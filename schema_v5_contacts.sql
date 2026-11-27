-- يلا نوبارية - أرقام التواصل الخاصة بالطلب (زبون / محل / كابتن)
create or replace function public.order_contacts(p_order uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  o public.orders;
  v_shop_phone text;
  v_cap_name text;
  v_cap_phone text;
  v_uid uuid := auth.uid();
  v_ok boolean;
begin
  select * into o from public.orders where id = p_order;
  if not found then return null; end if;
  select phone into v_shop_phone from public.shops where id = o.shop_id;
  select exists(select 1 from public.shops s where s.id = o.shop_id and s.owner_id = v_uid) into v_ok;
  if not (o.customer_id = v_uid or o.captain_id = v_uid or v_ok or public.is_admin()) then
    raise exception 'not allowed';
  end if;
  if o.captain_id is not null then
    select full_name, phone into v_cap_name, v_cap_phone from public.profiles where id = o.captain_id;
  end if;
  return jsonb_build_object(
    'shop_phone', coalesce(v_shop_phone, ''),
    'captain_name', coalesce(v_cap_name, ''),
    'captain_phone', coalesce(v_cap_phone, '')
  );
end $$;

grant execute on function public.order_contacts(uuid) to authenticated;
