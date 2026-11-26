-- ============================================
-- توصيل النوبارية - إعداد قاعدة البيانات
-- Nubaria Delivery - database schema (Supabase)
-- Run this whole file once in Supabase > SQL Editor
-- ============================================

-- ---------- جداول ----------

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  phone text not null unique,
  role text not null check (role in ('customer','shop','captain','admin')),
  status text not null default 'approved' check (status in ('pending','approved','rejected')),
  vehicle text,
  created_at timestamptz not null default now()
);

create table if not exists public.shops (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  category text not null default 'أخرى',
  address text not null default '',
  phone text not null default '',
  delivery_fee numeric(10,2) not null default 15,
  is_open boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  name text not null,
  price numeric(10,2) not null check (price >= 0),
  is_available boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.profiles(id),
  shop_id uuid not null references public.shops(id),
  captain_id uuid references public.profiles(id),
  status text not null default 'new' check (status in ('new','confirmed','picked_up','delivered','cancelled')),
  delivery_address text not null,
  customer_phone text not null,
  notes text not null default '',
  subtotal numeric(10,2) not null,
  delivery_fee numeric(10,2) not null,
  total numeric(10,2) not null,
  created_at timestamptz not null default now(),
  confirmed_at timestamptz,
  picked_up_at timestamptz,
  delivered_at timestamptz
);

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  name text not null,
  price numeric(10,2) not null,
  qty int not null default 1 check (qty > 0)
);

-- مستحقات التطبيق عند المحل أو الكابتن (10%)
create table if not exists public.dues (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  party_id uuid not null references public.profiles(id),
  party_role text not null check (party_role in ('shop','captain')),
  amount numeric(10,2) not null,
  settled boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_shops_owner on public.shops(owner_id);
create index if not exists idx_products_shop on public.products(shop_id);
create index if not exists idx_orders_customer on public.orders(customer_id);
create index if not exists idx_orders_shop on public.orders(shop_id);
create index if not exists idx_orders_captain on public.orders(captain_id);
create index if not exists idx_orders_status on public.orders(status);
create index if not exists idx_items_order on public.order_items(order_id);
create index if not exists idx_dues_party on public.dues(party_id);

-- ---------- دوال مساعدة ----------

-- دور المستخدم الحالي بدون ما تدخل فى سياسات profiles (تفادى recursion)
create or replace function public.auth_role()
returns text language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid();
$$;

create or replace function public.auth_status()
returns text language sql stable security definer set search_path = public as $$
  select status from public.profiles where id = auth.uid();
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select role from public.profiles where id = auth.uid()) = 'admin', false);
$$;

-- هل صاحب المحل متوافق عليه (بتتفادى قيود RLS على profiles)
create or replace function public.owner_approved(uid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select status = 'approved' from public.profiles where id = uid), false);
$$;

-- أول واحد يسجل فى التطبيق يقدر ياخد صلاحية الأدمن مرة واحدة بس
create or replace function public.claim_admin()
returns text language plpgsql security definer set search_path = public as $$
begin
  perform set_config('app.allow_role_change', 'on', true);
  if exists (select 1 from public.profiles where role = 'admin') then
    return 'already_claimed';
  end if;
  update public.profiles set role = 'admin', status = 'approved' where id = auth.uid();
  return 'ok';
end;
$$;

-- منع تغيير الدور أو الحالة إلا من أدمن (أو من داخل claim_admin)
create or replace function public.guard_profile_update()
returns trigger language plpgsql as $$
begin
  if (new.role is distinct from old.role or new.status is distinct from old.status)
     and coalesce(current_setting('app.allow_role_change', true), '') <> 'on'
     and not public.is_admin() then
    raise exception 'not allowed to change role or status';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_profile on public.profiles;
create trigger trg_guard_profile before update on public.profiles
  for each row execute function public.guard_profile_update();

-- قواعد تحديث الأوردر حسب الدور + حماية الحقول
create or replace function public.guard_order_update()
returns trigger language plpgsql as $$
declare
  r text := public.auth_role();
  is_shop_owner boolean;
begin
  if public.is_admin() then
    return new;
  end if;

  select exists(select 1 from public.shops s where s.id = old.shop_id and s.owner_id = auth.uid())
    into is_shop_owner;

  -- المحل: يأكد أو يلغى فقط، من غير تغيير أى حاجة تانية
  if is_shop_owner and r = 'shop' then
    if new.status = 'confirmed' and old.status = 'new' then
      new.confirmed_at := now();
      return new;
    elsif new.status = 'cancelled' and old.status in ('new','confirmed') then
      return new;
    else
      raise exception 'shop can only confirm or cancel';
    end if;
  end if;

  -- الكابتن: يستلم أوردر متاح، أو يحدث حالة أوردر عنده
  if r = 'captain' then
    if old.captain_id is null and old.status = 'confirmed'
       and new.captain_id = auth.uid() and new.status = 'confirmed' then
      return new; -- استلام الأوردر
    elsif old.captain_id = auth.uid() and new.captain_id = auth.uid() then
      if new.status = 'picked_up' and old.status = 'confirmed' then
        new.picked_up_at := now();
        return new;
      elsif new.status = 'delivered' and old.status = 'picked_up' then
        new.delivered_at := now();
        return new;
      end if;
    end if;
    raise exception 'captain transition not allowed';
  end if;

  -- الزبون: يلغى أوردر لسه جديد بس
  if r = 'customer' and old.customer_id = auth.uid()
     and old.status = 'new' and new.status = 'cancelled' then
    return new;
  end if;

  raise exception 'update not allowed';
end;
$$;

drop trigger if exists trg_guard_order on public.orders;
create trigger trg_guard_order before update on public.orders
  for each row execute function public.guard_order_update();

-- عند التسليم: سجل مستحقات 10% على المحل وعلى الكابتن
create or replace function public.on_order_delivered()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_owner uuid;
begin
  if new.status = 'delivered' and old.status is distinct from 'delivered' then
    select owner_id into v_owner from public.shops where id = new.shop_id;

    insert into public.dues (order_id, party_id, party_role, amount)
    values (new.id, v_owner, 'shop', round(new.subtotal * 0.10, 2));

    if new.captain_id is not null then
      insert into public.dues (order_id, party_id, party_role, amount)
      values (new.id, new.captain_id, 'captain', round(new.delivery_fee * 0.10, 2));
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_order_delivered on public.orders;
create trigger trg_order_delivered after update on public.orders
  for each row execute function public.on_order_delivered();

-- ---------- صلاحيات RLS ----------

alter table public.profiles enable row level security;
alter table public.shops enable row level security;
alter table public.products enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.dues enable row level security;

-- profiles
create policy profiles_select on public.profiles for select
  using (id = auth.uid() or public.is_admin());
create policy profiles_insert on public.profiles for insert
  with check (id = auth.uid() and role in ('customer','shop','captain') and status in ('pending','approved'));
create policy profiles_update on public.profiles for update
  using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

-- shops: تظهر لو صاحبها متوافق عليه، أو لصاحبها، أو للأدمن
create policy shops_select on public.shops for select
  using (
    public.is_admin()
    or owner_id = auth.uid()
    or public.owner_approved(owner_id)
  );
create policy shops_insert on public.shops for insert
  with check (owner_id = auth.uid() and public.auth_role() = 'shop');
create policy shops_update on public.shops for update
  using (owner_id = auth.uid() or public.is_admin());
create policy shops_delete on public.shops for delete
  using (owner_id = auth.uid() or public.is_admin());

-- products
create policy products_select on public.products for select
  using (
    public.is_admin()
    or exists (select 1 from public.shops s
               where s.id = shop_id and (public.owner_approved(s.owner_id) or s.owner_id = auth.uid()))
  );
create policy products_write on public.products for insert
  with check (exists (select 1 from public.shops s where s.id = shop_id and (s.owner_id = auth.uid() or public.is_admin())));
create policy products_update on public.products for update
  using (exists (select 1 from public.shops s where s.id = shop_id and (s.owner_id = auth.uid() or public.is_admin())));
create policy products_delete on public.products for delete
  using (exists (select 1 from public.shops s where s.id = shop_id and (s.owner_id = auth.uid() or public.is_admin())));

-- orders
create policy orders_select on public.orders for select
  using (
    public.is_admin()
    or customer_id = auth.uid()
    or captain_id = auth.uid()
    or exists (select 1 from public.shops s where s.id = shop_id and s.owner_id = auth.uid())
    or (public.auth_role() = 'captain' and public.auth_status() = 'approved'
        and status = 'confirmed' and captain_id is null)
  );
create policy orders_insert on public.orders for insert
  with check (customer_id = auth.uid() and public.auth_status() = 'approved'
              and captain_id is null and status = 'new');
create policy orders_update on public.orders for update
  using (
    public.is_admin()
    or (customer_id = auth.uid() and status = 'new')
    or captain_id = auth.uid()
    or (public.auth_role() = 'captain' and public.auth_status() = 'approved'
        and status = 'confirmed' and captain_id is null)
    or exists (select 1 from public.shops s where s.id = shop_id and s.owner_id = auth.uid())
  )
  with check (
    public.is_admin()
    or customer_id = auth.uid()
    or captain_id = auth.uid()
    or exists (select 1 from public.shops s where s.id = shop_id and s.owner_id = auth.uid())
  );

-- order_items: تبع الأوردر
create policy items_select on public.order_items for select
  using (exists (select 1 from public.orders o where o.id = order_id and (
    public.is_admin() or o.customer_id = auth.uid() or o.captain_id = auth.uid()
    or exists (select 1 from public.shops s where s.id = o.shop_id and s.owner_id = auth.uid())
  )));
create policy items_insert on public.order_items for insert
  with check (exists (select 1 from public.orders o where o.id = order_id and o.customer_id = auth.uid()));

-- dues: الطرف يشوف مستحقاته، والأدمن يشوف ويصفّى
create policy dues_select on public.dues for select
  using (party_id = auth.uid() or public.is_admin());
create policy dues_update on public.dues for update
  using (public.is_admin());

-- claim_admin متاحة لأى مستخدم مسجل
grant execute on function public.claim_admin() to authenticated;
