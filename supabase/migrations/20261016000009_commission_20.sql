-- Rizq Rasan's commission is 20% of the listing price (it was 5%).
-- New orders take the rate from this setting when they are claimed; orders
-- already claimed keep the split they were created with.
update public.settings
set value = '20'::jsonb, updated_at = now()
where key = 'commission_percent';
