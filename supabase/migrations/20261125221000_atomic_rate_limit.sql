begin;
create or replace function public.consume_api_rate_limit(p_action text,p_client_hash text,p_maximum integer,p_window_minutes integer)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare n bigint;
begin
  if p_maximum < 1 or p_maximum > 10000 or p_window_minutes < 1 or p_window_minutes > 1440
    or p_client_hash is null or p_action is null then raise exception 'Invalid rate limit parameters'; end if;
  -- Counting and consuming a slot share the same transaction and lock.
  perform pg_advisory_xact_lock(hashtextextended(p_action || ':' || p_client_hash,0));
  select count(*) into n from public.api_requests
    where action=p_action and client_hash=p_client_hash
      and created_at >= clock_timestamp() - make_interval(mins=>p_window_minutes);
  if n >= p_maximum then return false; end if;
  insert into public.api_requests(action,client_hash) values(p_action,p_client_hash);
  return true;
end;
$$;
revoke all on function public.consume_api_rate_limit(text,text,integer,integer) from public,anon,authenticated;
grant execute on function public.consume_api_rate_limit(text,text,integer,integer) to service_role;
commit;
