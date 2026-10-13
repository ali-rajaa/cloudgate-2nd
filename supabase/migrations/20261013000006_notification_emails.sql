-- Rizq Rasan platform: emailing notifications.
-- Every minute the scheduler asks the send-notifications Edge Function to email
-- anything new. It only runs once two Vault secrets exist (see README):
--   select vault.create_secret('https://<ref>.supabase.co', 'project_url');
--   select vault.create_secret('<service role key>', 'service_role_key');

create extension if not exists pg_net with schema extensions;

-- Notifications waiting to be emailed, with the person's address (service role only).
create or replace function public.pending_notification_emails(p_limit integer default 50)
returns table (id uuid, email text, full_name text, title text, body text, link text)
language sql stable security definer set search_path = public as $$
  select n.id, u.email::text, p.full_name, n.title, n.body, n.link
  from public.notifications n
  join auth.users u on u.id = n.user_id
  left join public.profiles p on p.id = n.user_id
  where n.emailed_at is null and n.created_at > now() - interval '1 day'
  order by n.created_at
  limit p_limit
$$;

create or replace function public.mark_notifications_emailed(p_ids uuid[]) returns void
language sql security definer set search_path = public as $$
  update public.notifications set emailed_at = now() where id = any(p_ids)
$$;

revoke execute on function public.pending_notification_emails(integer) from public, anon, authenticated;
revoke execute on function public.mark_notifications_emailed(uuid[]) from public, anon, authenticated;
grant execute on function public.pending_notification_emails(integer) to service_role;
grant execute on function public.mark_notifications_emailed(uuid[]) to service_role;

-- Called by the scheduler. Does nothing until the Vault secrets are set.
create or replace function public.dispatch_notification_emails() returns void
language plpgsql security definer set search_path = public as $$
declare v_url text; v_key text;
begin
  if not exists (select 1 from public.notifications where emailed_at is null and created_at > now() - interval '1 day') then return; end if;
  begin
    select decrypted_secret into v_url from vault.decrypted_secrets where name = 'project_url';
    select decrypted_secret into v_key from vault.decrypted_secrets where name = 'service_role_key';
  exception when others then return;
  end;
  if v_url is null or v_key is null then return; end if;
  perform net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/send-notifications',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body := '{}'::jsonb);
end $$;
revoke execute on function public.dispatch_notification_emails() from public, anon, authenticated;

select cron.schedule('rizq-emails', '* * * * *', $$select public.dispatch_notification_emails()$$);
