-- ============================================
-- يلا نوبارية - ترقية المحافظ (المرحلة 1)
-- Wallets phase 1: internal ledger, manual top-up/withdrawal
-- Run this whole file once in Supabase > SQL Editor (after schema.sql)
-- ============================================

-- ---------- جداول المحافظ ----------

-- رصيد كل مستخدم (سجل داخلي، بيأكده الأدمن يدوي)
create table if not exists public.wallets (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  balance numeric(12,2) not null default 0 check (balance >= 0),
  updated_at timestamptz not null default now()
);

-- دفتر الحركات: كل جنيه دخل أو خرج
create table if not exists public.wallet_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  order_id uuid references public.orders(id) on delete set null,
  kind text not null check (kind in ('topup','withdrawal','order_payment','order_refund','order_earning','admin_adjustment')),
  amount numeric(12,2) not null, -- موجب = داخل، سالب = خارج
  note text not null default '',
  created_at timestamptz not null default now()
);

-- طلبات الشحن والسحب (الأدمن يوافق يدوي بعد التحويل)
create table if not exists public.wallet_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null check (kind in ('topup','withdrawal')),
  amount numeric(12,2) not null check (amount > 0),
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  note text not null default '',       -- رقم العملية / وسيلة التحويل
  admin_note text not null default '',
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists idx_ledger_user on public.wallet_ledger(user_id);
create index if not exists idx_wreq_status on public.wallet_requests(status);
create index if not exists idx_wreq_user on public.wallet_requests(user_id);

-- ---------- دوال المحفظة ----------

-- تطبيق حركة على رصيد مستخدم + تسجيلها فى الدفتر
-- بتترمى exception لو الرصيد هيبقى بالسالب
create or replace function public.wallet_apply(p_user uuid, p_amount numeric, p_kind text, p_order uuid, p_note text)
returns void language plpgsql security definer set search_path = public as $$
begin
  -- خصم: لازم يكون فى رصيد كفاية (التحديث هيفشل لو الناتج بالسالب)
  update public.wallets
  set balance = balance + p_amount, updated_at = now()
  where user_id = p_user;
  if not found then
    if p_amount < 0 then
      raise exception 'insufficient_wallet_balance';
    end if;
    insert into public.wallets (user_id, balance) values (p_user, p_amount);
  end if;
  insert into public.wallet_ledger (user_id, order_id, kind, amount, note)
  values (p_user, p_order, p_kind, p_amount, coalesce(p_note, ''));
end;
$$;

-- محفظة جديدة لكل حساب جديد
create or replace function public.on_profile_wallet()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.wallets (user_id) values (new.id) on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists trg_profile_wallet on public.profiles;
create trigger trg_profile_wallet after insert on public.profiles
  for each row execute function public.on_profile_wallet();

-- محافظ للحسابات الموجودة قبل الترقية
insert into public.wallets (user_id)
select id from public.profiles
on conflict do nothing;

-- عند إنشاء الأوردر: خصم الإجمالى من محفظة الزبون
create or replace function public.on_order_wallet_payment()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_balance numeric;
begin
  select balance into v_balance from public.wallets where user_id = new.customer_id for update;
  if coalesce(v_balance, 0) < new.total then
    raise exception 'insufficient_wallet_balance';
  end if;
  perform public.wallet_apply(new.customer_id, -new.total, 'order_payment', new.id, 'دفع طلب');
  return new;
end;
$$;

drop trigger if exists trg_order_wallet_payment on public.orders;
create trigger trg_order_wallet_payment after insert on public.orders
  for each row execute function public.on_order_wallet_payment();

-- عند التسليم: نصيب المحل 90% من قيمة الأصناف، ونصيب الكابتن 90% من التوصيل
-- (يحل محل نظام المستحقات القديم)
create or replace function public.on_order_delivered()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_owner uuid;
begin
  if new.status = 'delivered' and old.status is distinct from 'delivered' then
    select owner_id into v_owner from public.shops where id = new.shop_id;
    perform public.wallet_apply(v_owner, round(new.subtotal * 0.90, 2), 'order_earning', new.id, 'نصيب المحل من طلب (بعد عمولة 10%)');
    if new.captain_id is not null then
      perform public.wallet_apply(new.captain_id, round(new.delivery_fee * 0.90, 2), 'order_earning', new.id, 'نصيب الكابتن من توصيل (بعد عمولة 10%)');
    end if;
  end if;
  return new;
end;
$$;

-- إلغاء الأوردر قبل التسليم: رد كامل المبلغ للزبون
create or replace function public.on_order_wallet_refund()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'cancelled' and old.status is distinct from 'cancelled'
     and old.status is distinct from 'delivered' then
    perform public.wallet_apply(new.customer_id, new.total, 'order_refund', new.id, 'استرجاع طلب ملغي');
  end if;
  return new;
end;
$$;

drop trigger if exists trg_order_delivered on public.orders;
create trigger trg_order_delivered after update on public.orders
  for each row execute function public.on_order_delivered();

drop trigger if exists trg_order_wallet_refund on public.orders;
create trigger trg_order_wallet_refund after update on public.orders
  for each row execute function public.on_order_wallet_refund();

-- موافقة الأدمن على طلب شحن/سحب: تطبيق الحركة مرة واحدة بس
create or replace function public.on_wallet_request_resolved()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'approved' and old.status = 'pending' then
    new.resolved_at := now();
    if new.kind = 'topup' then
      perform public.wallet_apply(new.user_id, new.amount, 'topup', null, 'شحن محفظة (تأكيد يدوي من الإدارة) - ' || new.note);
    else
      perform public.wallet_apply(new.user_id, -new.amount, 'withdrawal', null, 'سحب من المحفظة (تأكيد يدوي من الإدارة) - ' || new.note);
    end if;
  elsif new.status = 'rejected' and old.status = 'pending' then
    new.resolved_at := now();
  elsif new.status is distinct from old.status and old.status <> 'pending' then
    raise exception 'request already resolved';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_wallet_request on public.wallet_requests;
create trigger trg_wallet_request before update on public.wallet_requests
  for each row execute function public.on_wallet_request_resolved();

-- قيد يدوي من الأدمن (إضافة/خصم) - مسجل بوضوح فى الدفتر
create or replace function public.admin_adjust_wallet(p_user uuid, p_amount numeric, p_note text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'not admin';
  end if;
  perform public.wallet_apply(p_user, p_amount, 'admin_adjustment', null, coalesce(p_note, ''));
end;
$$;

grant execute on function public.admin_adjust_wallet(uuid, numeric, text) to authenticated;

-- صلاحية الأدمن: مربوطة برقم صاحب التطبيق أو كود تفعيل لمرة واحدة.
-- بتتقفل نهائي بعد ما يتسجل أول أدمن. مفيش claim عام.
drop function if exists public.claim_admin();
create or replace function public.claim_admin(p_code text default null)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_phone text;
begin
  if exists (select 1 from public.profiles where role = 'admin') then
    return 'already_claimed';
  end if;
  select phone into v_phone from public.profiles where id = auth.uid();
  if v_phone is distinct from '01061777039' and coalesce(p_code, '') <> 'NB-7391-KX' then
    return 'wrong_code';
  end if;
  perform set_config('app.allow_role_change', 'on', true);
  update public.profiles set role = 'admin', status = 'approved' where id = auth.uid();
  return 'ok';
end;
$$;

grant execute on function public.claim_admin(text) to authenticated;

-- رصيد المستخدم الحالي (للعرض فى التطبيق)
create or replace function public.my_balance()
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce((select balance from public.wallets where user_id = auth.uid()), 0);
$$;

grant execute on function public.my_balance() to authenticated;

-- ---------- صلاحيات RLS ----------

alter table public.wallets enable row level security;
alter table public.wallet_ledger enable row level security;
alter table public.wallet_requests enable row level security;

-- wallets: المستخدم يشوف رصيده بس، والأدمن يشوف الكل. مفيش تعديل مباشر لأى حد.
create policy wallets_select on public.wallets for select
  using (user_id = auth.uid() or public.is_admin());

-- ledger: المستخدم يشوف حركاته بس، والأدمن يشوف الكل
create policy ledger_select on public.wallet_ledger for select
  using (user_id = auth.uid() or public.is_admin());

-- requests: المستخدم يقدم طلب pending ويشوف طلباته، الأدمن يشوف الكل ويحدد القرار
create policy wreq_insert on public.wallet_requests for insert
  with check (user_id = auth.uid() and status = 'pending' and public.auth_status() = 'approved');
create policy wreq_select on public.wallet_requests for select
  using (user_id = auth.uid() or public.is_admin());
create policy wreq_update on public.wallet_requests for update
  using (public.is_admin())
  with check (public.is_admin());
