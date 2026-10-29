-- Qlarity — platform administration (the CEO console at /admin, api/admin.js). Safe to run again.
-- Everything here is for service_role only: no signed-in user or workspace can call these functions or read these tables.
-- The console sees counts and sizes per workspace, never its leads, phone numbers, emails or tokens.

-- server health snapshots, written every 5 minutes by ec2/health.sh on the database server (kept 7 days)
create table if not exists public.platform_health (
  id       bigint generated always as identity primary key,
  taken_at timestamptz not null default now(),
  data     jsonb not null
);
create index if not exists platform_health_at on public.platform_health (taken_at desc);

-- errors and notable events from the site's server code (Vercel) and the database server (kept 30 days)
create table if not exists public.platform_events (
  id      bigint generated always as identity primary key,
  at      timestamptz not null default now(),
  source  text not null default 'vercel' check (source in ('vercel', 'server', 'admin')),
  level   text not null default 'error' check (level in ('error', 'warn', 'info')),
  area    text not null default '',
  message text not null default '',
  org_id  uuid,
  detail  jsonb not null default '{}'::jsonb
);
create index if not exists platform_events_at on public.platform_events (at desc);

alter table public.platform_health enable row level security;
alter table public.platform_events enable row level security;
revoke all on public.platform_health, public.platform_events from public, anon, authenticated;

-- every workspace with its size and activity (no row contents)
create or replace function public.platform_orgs()
returns table (id uuid, name text, public_id text, active boolean, created_at timestamptz, currency text, crm_name text,
               owners text[], members integer, members_joined integer, leads bigint, meta_rows bigint, google_rows bigint, uploads bigint,
               last_upload timestamptz, last_sign_in timestamptz, storage_bytes bigint, storage jsonb, ai_enabled boolean)
language plpgsql stable security definer set search_path = '' as $$
declare t text; sizes jsonb := '{}'::jsonb; r record;
begin
  -- bytes per workspace per table, for every public table that carries org_id
  for t in select c.table_name from information_schema.columns c join information_schema.tables x on x.table_schema = c.table_schema and x.table_name = c.table_name
            where c.table_schema = 'public' and c.column_name = 'org_id' and x.table_type = 'BASE TABLE' and c.table_name not like 'platform\_%' loop
    for r in execute format('select org_id, sum(pg_column_size(x.*))::bigint as b from public.%I x where org_id is not null group by org_id', t) loop
      sizes := jsonb_set(sizes, array[r.org_id::text], coalesce(sizes -> r.org_id::text, '{}'::jsonb) || jsonb_build_object(t, r.b));
    end loop;
  end loop;
  return query
  select o.id, o.name, o.public_id, o.active, o.created_at, o.currency, o.crm_name,
         coalesce((select array_agg(m.email order by m.email) from public.org_members m where m.org_id = o.id and m.is_owner), '{}'),
         (select count(*)::int from public.org_members m where m.org_id = o.id),
         (select count(*)::int from public.org_members m where m.org_id = o.id and m.user_id is not null),
         (select count(*) from public.crm_leads l where l.org_id = o.id),
         (select count(*) from public.meta_ad_rows a where a.org_id = o.id),
         (select count(*) from public.google_ad_rows g where g.org_id = o.id),
         (select count(*) from public.uploads u where u.org_id = o.id),
         (select max(u.uploaded_at) from public.uploads u where u.org_id = o.id),
         (select max(au.last_sign_in_at) from public.org_members m join auth.users au on au.id = m.user_id where m.org_id = o.id),
         coalesce((select sum(v::bigint) from jsonb_each_text(coalesce(sizes -> o.id::text, '{}'::jsonb)) as e(k, v)), 0)::bigint,
         coalesce(sizes -> o.id::text, '{}'::jsonb),
         coalesce((select c.enabled from public.org_ai_config c where c.org_id = o.id), false)
    from public.organizations o
   order by o.created_at;
end $$;

-- every login with its state and workspaces (account data only)
create or replace function public.platform_users()
returns table (id uuid, email text, name text, created_at timestamptz, confirmed_at timestamptz, last_sign_in timestamptz,
               failed_logins integer, locked_until timestamptz, disabled_at timestamptz, workspaces jsonb)
language sql stable security definer set search_path = '' as $$
  select u.id, u.email, coalesce(u.raw_user_meta_data ->> 'full_name', ''), u.created_at, u.email_confirmed_at, u.last_sign_in_at,
         u.failed_logins, u.locked_until, u.disabled_at,
         coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'role', m.role, 'owner', m.is_owner, 'active', o.active) order by o.name)
                     from public.org_members m join public.organizations o on o.id = m.org_id
                    where m.user_id = u.id or (m.user_id is null and m.email = u.email)), '[]'::jsonb)
    from auth.users u
   order by u.created_at desc
$$;

-- the database as a whole: size, biggest tables, connections
create or replace function public.platform_db()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'size_bytes', pg_database_size(current_database()),
    'version', current_setting('server_version'),
    'connections', (select count(*) from pg_stat_activity where datname = current_database()),
    'max_connections', current_setting('max_connections')::int,
    'tables', (select coalesce(jsonb_agg(t order by (t ->> 'bytes')::bigint desc), '[]'::jsonb) from (
       select jsonb_build_object('name', c.relname, 'bytes', pg_total_relation_size(c.oid), 'rows', greatest(c.reltuples, 0)::bigint) as t
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname in ('public', 'auth', 'vault') and c.relkind = 'r'
        order by pg_total_relation_size(c.oid) desc limit 12) x))
$$;

-- suspend / reactivate a workspace: members can't open it and its schedules stop (my_orgs and lp-fanout skip inactive ones); data is kept
create or replace function public.platform_set_org_active(p_org uuid, p_active boolean) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update public.organizations set active = p_active where id = p_org;
  return found;
end $$;

-- delete a workspace and everything in it, including its encrypted tokens; p_name must match (a typed confirmation)
create or replace function public.platform_delete_org(p_org uuid, p_name text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare n text;
begin
  select name into n from public.organizations where id = p_org;
  if n is null then return false; end if;
  if btrim(coalesce(p_name, '')) <> n then raise exception 'The name does not match.'; end if;
  delete from vault.secrets where id in (select vault_id from public.org_secrets where org_id = p_org) or name like 'org:' || p_org || ':%';
  delete from public.organizations where id = p_org;   -- every workspace table cascades from here
  return true;
end $$;

-- users: end every session; disable (no sign-in, no session) or enable; unlock after wrong passwords
create or replace function public.platform_user_action(p_user uuid, p_action text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if p_action = 'signout' then update auth.users set token_version = token_version + 1, updated_at = now() where id = p_user;
  elsif p_action = 'disable' then update auth.users set disabled_at = now(), token_version = token_version + 1, updated_at = now() where id = p_user;
  elsif p_action = 'enable' then update auth.users set disabled_at = null, locked_until = null, failed_logins = 0, updated_at = now() where id = p_user;
  else raise exception 'Unknown action.'; end if;
  return found;
end $$;

-- housekeeping, called by the health job: keep 7 days of snapshots and 30 days of events
create or replace function public.platform_prune() returns void
language sql security definer set search_path = '' as $$
  delete from public.platform_health where taken_at < now() - interval '7 days';
  delete from public.platform_events where at < now() - interval '30 days';
$$;

revoke all on function public.platform_orgs(), public.platform_users(), public.platform_db(), public.platform_set_org_active(uuid, boolean),
  public.platform_delete_org(uuid, text), public.platform_user_action(uuid, text), public.platform_prune() from public, anon, authenticated;
grant execute on function public.platform_orgs(), public.platform_users(), public.platform_db(), public.platform_set_org_active(uuid, boolean),
  public.platform_delete_org(uuid, text), public.platform_user_action(uuid, text), public.platform_prune() to service_role;

select 'platform admin ready';
