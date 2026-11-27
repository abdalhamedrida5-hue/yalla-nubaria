-- ============================================
-- يلا نوبارية - تصنيفات المحلات وتخصصاتها
-- Shop categories + specialties
-- Run once in Supabase > SQL Editor (after schema_v3_pause_wallets.sql)
-- ============================================

alter table public.shops
  add column if not exists specialties text[] not null default '{}';

-- تحويل التصنيفات القديمة لأسماء التصنيفات الجديدة
update public.shops set category = case category
  when 'مطعم' then 'مطاعم'
  when 'كشري ووجبات' then 'مطاعم'
  when 'قهوة وعصائر' then 'مطاعم'
  when 'سوبرماركت' then 'سوبرماركت وبقالة'
  when 'صيدلية' then 'أخرى'
  else category
end
where category in ('مطعم', 'كشري ووجبات', 'قهوة وعصائر', 'سوبرماركت', 'صيدلية');

update public.shops set category = 'أخرى'
where category is null or btrim(category) = '';
