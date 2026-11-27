-- ============================================
-- يلا نوبارية - إيقاف مؤقت لتحويلات المحفظة + رجوع الدفع كاش عند الاستلام
-- Wallet transfers paused (licensing check) + cash on delivery restored
-- Run once in Supabase > SQL Editor (after schema_v2_wallets.sql)
-- Reversible: update app_settings set value='true' where key='wallet_transfer_enabled';
-- ============================================

-- ---------- 1) طريقة الدفع على الطلب ----------
alter table public.orders
  add column if not exists payment_method text not null default 'cash';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'orders_payment_method_check'
      and conrelid = 'public.orders'::regclass
  ) then
    alter table public.orders
      add constraint orders_payment_method_check
      check (payment_method in ('cash', 'wallet'));
  end if;
end $$;

-- ---------- 2) خصم المحفظة بقى للطلبات المدفوعة من المحفظة بس ----------
create or replace function public.on_order_wallet_payment()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_balance numeric;
begin
  if new.payment_method is distinct from 'wallet' then
    return new;
  end if;
  select balance into v_balance from public.wallets where user_id = new.customer_id for update;
  if coalesce(v_balance, 0) < new.total then
    raise exception 'insufficient_wallet_balance';
  end if;
  perform public.wallet_apply(new.customer_id, -new.total, 'order_payment', new.id, 'دفع طلب');
  return new;
end;
$$;

-- ---------- 3) الاسترجاع للمحفظة كمان للطلبات المدفوعة من المحفظة بس ----------
create or replace function public.on_order_wallet_refund()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'cancelled' and old.status is distinct from 'cancelled'
     and old.status is distinct from 'delivered'
     and old.payment_method = 'wallet' then
    perform public.wallet_apply(new.customer_id, new.total, 'order_refund', new.id, 'استرجاع طلب ملغي');
  end if;
  return new;
end;
$$;

-- ---------- 4) مفتاح إيقاف الشحن والسحب ----------
create table if not exists public.app_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

insert into public.app_settings (key, value)
values ('wallet_transfer_enabled', 'false')
on conflict (key) do nothing;

alter table public.app_settings enable row level security;

create or replace function public.wallet_transfer_enabled()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select value from public.app_settings where key = 'wallet_transfer_enabled'), 'false') = 'true';
$$;

grant execute on function public.wallet_transfer_enabled() to anon, authenticated;

-- ---------- 5) منع أي طلب شحن/سحب جديد وقت الإيقاف (حماية على مستوى الداتابيز) ----------
create or replace function public.on_wallet_request_pause()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not public.wallet_transfer_enabled() then
    raise exception 'wallet_transfer_paused';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_wallet_request_pause on public.wallet_requests;
create trigger trg_wallet_request_pause before insert on public.wallet_requests
  for each row execute function public.on_wallet_request_pause();

-- ---------- 6) القيد اليدوي من الأدمن بقى متسجل باسم تجريبي ----------
create or replace function public.admin_adjust_wallet(p_user uuid, p_amount numeric, p_note text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'not admin';
  end if;
  perform public.wallet_apply(p_user, p_amount, 'admin_adjustment', null, 'قيد يدوي تجريبي - ' || coalesce(p_note, ''));
end;
$$;

grant execute on function public.admin_adjust_wallet(uuid, numeric, text) to authenticated;
