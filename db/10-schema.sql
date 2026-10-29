-- Qlarity — the multi-company schema. Run after db/00-platform.sql (ec2/setup.sh runs both). Safe to run again.
--
-- How companies are kept apart
--   Every data row has org_id. The browser sends the workspace it is working in as the header x-org-id; private.current_org() reads it.
--   Row level security lets a row through only when org_id = current_org() AND the signed-in login is a member of that workspace
--   with a proven email (confirmed by link or invite). Sending another workspace's id gets nothing. The server (service role) always
--   filters by org_id itself (api/_db.js). PostgREST on the EC2 sets the header and the JWT claims for every request.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;
grant usage on schema private to authenticated, service_role;

-- =====================================================================
-- 1. Workspaces, members, settings, secrets, machine keys, app config
-- =====================================================================
create table if not exists public.organizations (
  id            uuid primary key default gen_random_uuid(),
  public_id     text not null unique default encode(extensions.gen_random_bytes(9), 'hex'),   -- used in the website tracking snippet
  name          text not null check (length(btrim(name)) between 1 and 80),
  logo          text check (logo is null or length(logo) <= 300000),                           -- data: URL, resized in the browser
  currency      text not null default 'INR' check (currency ~ '^[A-Z]{3}$'),
  tz_offset_min integer not null default 330 check (tz_offset_min between -720 and 840),
  crm_name      text not null default 'CRM' check (length(btrim(crm_name)) between 1 and 40),
  active        boolean not null default true,
  created_by    uuid,
  created_at    timestamptz not null default now()
);

create table if not exists public.org_members (
  org_id     uuid not null references public.organizations (id) on delete cascade,
  email      text not null check (email = lower(btrim(email)) and email like '%@%'),
  user_id    uuid references auth.users (id) on delete set null,   -- null = invited, not signed in yet
  role       text not null check (role in ('admin', 'editor', 'viewer')),
  is_owner   boolean not null default false,   -- owner = an admin who also manages the workspace's AI keys and models, and who is owner
  invited_by text,
  created_at timestamptz not null default now(),
  primary key (org_id, email)
);
alter table public.org_members add column if not exists is_owner boolean not null default false;
create index if not exists org_members_user on public.org_members (user_id);
create index if not exists org_members_email on public.org_members (email);

-- the workspace the browser / server is working in (header x-org-id), or null
create or replace function private.current_org() returns uuid set search_path = ''
language sql stable as $$
  select case when h ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then h::uuid end
  from (select coalesce(current_setting('request.headers', true)::json ->> 'x-org-id', '') as h) x
$$;
grant execute on function private.current_org() to authenticated, service_role;

-- the signed-in login's role in a workspace: its own linked account, or an invite whose email the login has proven
create or replace function private.org_role(p_org uuid) returns text
language sql stable security definer set search_path = '' as $$
  select m.role
    from public.org_members m
    join auth.users u on u.id = (select auth.uid())
   where m.org_id = p_org
     and (m.user_id = u.id
          or (m.user_id is null and m.email = lower(u.email) and u.email_confirmed_at is not null
              and (u.confirmation_sent_at is not null or u.invited_at is not null)))
$$;
revoke all on function private.org_role(uuid) from public;
grant execute on function private.org_role(uuid) to authenticated;
-- is the signed-in login an owner of the workspace (same membership proof as org_role)
create or replace function private.is_owner(p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(bool_or(m.is_owner and m.role = 'admin'), false)
    from public.org_members m
    join auth.users u on u.id = (select auth.uid())
   where m.org_id = p_org
     and (m.user_id = u.id
          or (m.user_id is null and m.email = lower(u.email) and u.email_confirmed_at is not null
              and (u.confirmation_sent_at is not null or u.invited_at is not null)))
$$;
revoke all on function private.is_owner(uuid) from public;
grant execute on function private.is_owner(uuid) to authenticated;
create or replace function private.my_role() returns text language sql stable set search_path = '' as $$ select private.org_role(private.current_org()) $$;
grant execute on function private.my_role() to authenticated;
create or replace function private.who() returns text language sql stable set search_path = '' as $$ select nullif(lower(coalesce(auth.jwt() ->> 'email', '')), '') $$;

create table if not exists public.org_settings (
  org_id     uuid primary key default private.current_org() references public.organizations (id) on delete cascade,
  settings   jsonb not null default '{}'::jsonb,
  updated_by text,
  updated_at timestamptz not null default now()
);

-- per-workspace tokens (Meta, Conversions API, audiences, Google): the value is encrypted in vault.secrets; this row only says it exists
create table if not exists public.org_secrets (
  org_id     uuid not null default private.current_org() references public.organizations (id) on delete cascade,
  key        text not null check (key in ('meta_access_token', 'meta_capi_token', 'meta_audience_token', 'google_refresh_token', 'google_login_customer_id', 'ai_anthropic_key', 'ai_openai_key', 'ai_gemini_key', 'ai_compatible_key')),
  vault_id   uuid not null,
  last4      text not null default '',
  updated_by text,
  updated_at timestamptz not null default now(),
  primary key (org_id, key)
);

alter table public.org_secrets drop constraint if exists org_secrets_key_check;
alter table public.org_secrets add constraint org_secrets_key_check check (key in ('meta_access_token', 'meta_capi_token', 'meta_audience_token', 'google_refresh_token', 'google_login_customer_id', 'ai_anthropic_key', 'ai_openai_key', 'ai_gemini_key', 'ai_compatible_key'));

-- Ask AI per workspace (owners only): which provider and model answer. The provider's key is in org_secrets (ai_<provider>_key).
-- Separate from org_settings on purpose: editors can change settings, and a custom address there could send the key elsewhere.
create table if not exists public.org_ai_config (
  org_id     uuid primary key default private.current_org() references public.organizations (id) on delete cascade,
  enabled    boolean not null default false,
  provider   text not null default 'anthropic' check (provider in ('anthropic', 'openai', 'gemini', 'compatible')),
  model      text not null default '' check (length(model) <= 200),
  base_url   text not null default '' check (base_url = '' or base_url ~ '^https://[^\s/?#]+(/[^\s?#]*)?$'),
  updated_by text,
  updated_at timestamptz not null default now()
);

-- machine keys: CRM push (n8n / webhooks) and API (MCP server, Chrome extension). Only a sha256 hash is stored.
create table if not exists public.org_api_keys (
  id         bigint generated always as identity primary key,
  org_id     uuid not null default private.current_org() references public.organizations (id) on delete cascade,
  kind       text not null check (kind in ('crm_push', 'api')),
  name       text not null default '',
  key_hash   text not null unique,
  last4      text not null default '',
  created_by text,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index if not exists org_api_keys_org on public.org_api_keys (org_id);

create table if not exists public.app_config (
  id       integer primary key default 1 check (id = 1),
  site_url text not null default ''           -- e.g. https://app.example.com (no trailing slash); used by the schedules below
);
insert into public.app_config (id) values (1) on conflict (id) do nothing;
alter table public.app_config enable row level security;
revoke all on public.app_config from anon, authenticated;

-- =====================================================================
-- 2. Data tables (every row belongs to one workspace)
-- =====================================================================
create table if not exists public.uploads (
  id          bigint generated always as identity primary key,
  org_id      uuid not null default private.current_org() references public.organizations (id) on delete cascade,
  uploaded_by text not null default lower(coalesce(auth.jwt() ->> 'email', '')),
  uploaded_at timestamptz not null default now(),
  meta_files  text[] not null default '{}',
  crm_file    text,
  meta_rows   integer not null default 0,
  crm_rows    integer not null default 0,
  date_from   date,
  date_to     date
);
create index if not exists uploads_org on public.uploads (org_id, uploaded_at desc);

create table if not exists public.meta_ad_rows (
  id               bigint generated always as identity primary key,
  org_id           uuid not null default private.current_org() references public.organizations (id) on delete cascade,
  campaign         text not null,
  adset            text not null default '',
  ad               text not null default '',
  day              date not null,
  day_end          date not null,
  spend            numeric(14, 2) not null default 0,
  results          numeric(14, 2) not null default 0,
  result_indicator text not null default '',
  currency         text not null default 'INR',
  brand            text not null default '',
  impressions      bigint not null default 0,
  clicks           bigint not null default 0,
  reach            bigint,
  ad_id            text not null default '',
  upload_id        bigint references public.uploads (id) on delete set null,
  source_file      text not null default '',
  updated_at       timestamptz not null default now(),
  constraint meta_ad_rows_key unique (org_id, campaign, adset, ad, day, day_end),
  constraint meta_ad_rows_dates check (day_end >= day)
);
create index if not exists meta_ad_rows_day_idx on public.meta_ad_rows (org_id, day, day_end);
create index if not exists meta_ad_rows_upload_idx on public.meta_ad_rows (upload_id, source_file);

create table if not exists public.crm_leads (
  org_id       uuid not null default private.current_org() references public.organizations (id) on delete cascade,
  lead_id      text not null,
  created_on   timestamp,          -- wall-clock time in the workspace's time zone
  lead_source  text not null default '',
  campaign     text not null default '',
  adset        text not null default '',
  ad           text not null default '',
  status       text not null default '',
  crm_brand    text not null default '',
  first_call   timestamp,
  owner        text not null default '',
  manager      text not null default '',
  brand        text not null default '',
  is_ql        boolean not null default false,
  tat_min      numeric(10, 1),
  upload_id    bigint references public.uploads (id) on delete set null,
  source_file  text not null default '',
  phone_key    text not null default '',
  email_key    text not null default '',
  fb_lead_id   text not null default '',
  prev_lead    text,
  prev_created timestamp,
  dup_match    text,
  phone        text,
  email        text,
  lead_name    text,
  extra        jsonb,
  updated_at   timestamptz not null default now(),
  primary key (org_id, lead_id)
);
create index if not exists crm_leads_created_idx on public.crm_leads (org_id, created_on);
create index if not exists crm_leads_upload_idx on public.crm_leads (upload_id, source_file);
create index if not exists crm_leads_phone_key_idx on public.crm_leads (org_id, brand, phone_key) where phone_key <> '';
create index if not exists crm_leads_email_key_idx on public.crm_leads (org_id, brand, email_key) where email_key <> '';
create index if not exists crm_leads_fb_lead_idx on public.crm_leads (org_id, brand, fb_lead_id) where fb_lead_id <> '';

create table if not exists public.google_ad_rows (
  id            bigint generated always as identity primary key,
  org_id        uuid not null default private.current_org() references public.organizations (id) on delete cascade,
  account_id    text not null,
  account_name  text not null default '',
  campaign_id   text not null,
  campaign      text not null,
  campaign_type text not null default '',
  day           date not null,
  spend         numeric(14, 2) not null default 0,
  conversions   numeric(14, 2) not null default 0,
  impressions   bigint not null default 0,
  clicks        bigint not null default 0,
  currency      text not null default 'INR',
  brand         text not null default '',
  updated_at    timestamptz not null default now(),
  constraint google_ad_rows_key unique (org_id, account_id, campaign_id, day)
);
create index if not exists google_ad_rows_day_idx on public.google_ad_rows (org_id, day);

create table if not exists public.change_log (
  id     bigint generated always as identity primary key,
  org_id uuid not null references public.organizations (id) on delete cascade,
  at     timestamptz not null default now(),
  actor  text not null,
  area   text not null,                 -- settings | upload | team
  action text not null,                 -- changed | added | deleted
  detail jsonb not null default '{}'::jsonb
);
create index if not exists change_log_at on public.change_log (org_id, at desc);

create table if not exists public.user_prefs (
  org_id     uuid not null default private.current_org() references public.organizations (id) on delete cascade,
  email      text not null default lower(coalesce(auth.jwt() ->> 'email', '')),
  prefs      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (org_id, email)
);

-- server-only tables (alerts, monitoring, Conversions API, tracking, audiences)
create table if not exists public.alert_state (
  org_id uuid not null references public.organizations (id) on delete cascade,
  k text not null, v jsonb, updated_at timestamptz not null default now(),
  primary key (org_id, k)
);
create table if not exists public.alert_log (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.organizations (id) on delete cascade,
  at timestamptz not null default now(), kind text not null, text text not null
);
create index if not exists alert_log_at on public.alert_log (org_id, at desc);
create table if not exists public.meta_activity (
  org_id uuid not null references public.organizations (id) on delete cascade,
  ev_key text not null, account_id text not null, account_name text not null default '', brand text not null default '',
  event_time timestamptz not null, event_type text not null default '', translated text not null default '',
  actor_name text not null default '', actor_id text not null default '', application_name text not null default '',
  object_type text not null default '', object_id text not null default '', object_name text not null default '',
  level text not null default '', campaign text not null default '', adset text not null default '', ad text not null default '',
  extra text, stored_at timestamptz not null default now(),
  primary key (org_id, ev_key)
);
create index if not exists meta_activity_time on public.meta_activity (org_id, event_time desc);
create table if not exists public.alert_issues (
  org_id uuid not null references public.organizations (id) on delete cascade,
  key text not null, kind text not null, severity text not null, confirmed boolean not null default true,
  status text not null default 'open', brand text not null default '', account text not null default '', campaign text not null default '',
  title text not null default '', detail jsonb not null default '{}'::jsonb,
  first_seen timestamptz not null default now(), last_seen timestamptz not null default now(), last_notified timestamptz,
  notified_value numeric, notify_count integer not null default 0, missed integer not null default 0, resolved_at timestamptz,
  ack_by text, ack_at timestamptz, note text,
  primary key (org_id, key)
);
create index if not exists alert_issues_status on public.alert_issues (org_id, status, last_seen desc);
create table if not exists public.capi_events (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.organizations (id) on delete cascade,
  lead_id text not null, stage text not null check (stage in ('ql', 'won')), brand text not null default '', campaign text not null default '',
  dataset_id text not null default '', event_name text not null default '', event_time timestamptz, status text not null default 'pending',
  detail text not null default '', match_keys text not null default '', fbtrace text not null default '', attempts integer not null default 0,
  created_at timestamptz not null default now(), sent_at timestamptz,
  constraint capi_events_key unique (org_id, lead_id, stage)
);
create index if not exists capi_events_created on public.capi_events (org_id, created_at desc);
create table if not exists public.web_events (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.organizations (id) on delete cascade,
  vid text not null, at timestamptz not null default now(), kind text not null default 'page',
  host text not null default '', path text not null default '', channel text not null default '', source text not null default '',
  medium text not null default '', campaign text not null default '', content text not null default '', term text not null default '',
  referrer text not null default '', fbclid text not null default '', gclid text not null default '', msclkid text not null default '',
  brand text not null default '', mobile boolean
);
create index if not exists web_events_vid on public.web_events (org_id, vid, at);
create index if not exists web_events_at on public.web_events (org_id, at desc);
create table if not exists public.web_identities (
  org_id uuid not null references public.organizations (id) on delete cascade,
  vid text not null, key_type text not null check (key_type in ('ph', 'em')), key_hash text not null, at timestamptz not null default now(),
  primary key (org_id, vid, key_type, key_hash)
);
create index if not exists web_identities_hash on public.web_identities (org_id, key_type, key_hash);
create table if not exists public.audience_lists (
  org_id uuid not null references public.organizations (id) on delete cascade,
  k text not null, brand text not null, list text not null, account_id text not null, audience_id text not null, name text not null,
  members integer not null default 0, last_sync timestamptz, last_error text not null default '',
  primary key (org_id, k)
);
create table if not exists public.audience_members (
  org_id uuid not null, k text not null, lead_id text not null, at timestamptz not null default now(),
  primary key (org_id, k, lead_id),
  foreign key (org_id, k) references public.audience_lists (org_id, k) on delete cascade
);

-- =====================================================================
-- 3. Row level security
-- =====================================================================
do $$
declare t text;
begin
  foreach t in array array['organizations', 'org_members', 'org_settings', 'org_secrets', 'org_api_keys', 'uploads', 'meta_ad_rows', 'crm_leads',
                           'google_ad_rows', 'change_log', 'user_prefs', 'alert_state', 'alert_log', 'meta_activity', 'alert_issues',
                           'capi_events', 'web_events', 'web_identities', 'audience_lists', 'audience_members'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
  -- shared data: members read; admins / editors add and change; admins delete
  foreach t in array array['uploads', 'meta_ad_rows', 'crm_leads', 'org_settings'] loop
    execute format('drop policy if exists org_read on public.%I', t);
    execute format('drop policy if exists org_insert on public.%I', t);
    execute format('drop policy if exists org_update on public.%I', t);
    execute format('drop policy if exists org_delete on public.%I', t);
    execute format('create policy org_read on public.%I for select to authenticated using (org_id = (select private.current_org()) and (select private.my_role()) is not null)', t);
    execute format('create policy org_insert on public.%I for insert to authenticated with check (org_id = (select private.current_org()) and (select private.my_role()) in (''admin'', ''editor''))', t);
    execute format('create policy org_update on public.%I for update to authenticated using (org_id = (select private.current_org()) and (select private.my_role()) in (''admin'', ''editor'')) with check (org_id = (select private.current_org()) and (select private.my_role()) in (''admin'', ''editor''))', t);
    execute format('create policy org_delete on public.%I for delete to authenticated using (org_id = (select private.current_org()) and (select private.my_role()) = ''admin'')', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
  -- read-only for members (written by the server or by triggers)
  foreach t in array array['google_ad_rows', 'change_log', 'org_secrets'] loop
    execute format('drop policy if exists org_read on public.%I', t);
    execute format('create policy org_read on public.%I for select to authenticated using (org_id = (select private.current_org()) and (select private.my_role()) is not null)', t);
    execute format('revoke insert, update, delete on public.%I from authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
  -- server only (read through /api/*)
  foreach t in array array['alert_state', 'alert_log', 'meta_activity', 'alert_issues', 'capi_events', 'web_events', 'web_identities', 'audience_lists', 'audience_members'] loop
    execute format('revoke all on public.%I from authenticated', t);
  end loop;
end $$;

-- workspaces: members see theirs; admins rename / change logo, currency, time zone, CRM name. New ones only through create_organization().
drop policy if exists org_read on public.organizations;
drop policy if exists org_update on public.organizations;
create policy org_read on public.organizations for select to authenticated using ((select private.org_role(id)) is not null);
create policy org_update on public.organizations for update to authenticated using ((select private.org_role(id)) = 'admin') with check ((select private.org_role(id)) = 'admin');
revoke all on public.organizations from authenticated;   -- new tables are fully granted by default (db/00-platform.sql); give back only what's needed
grant select, update (name, logo, currency, tz_offset_min, crm_name) on public.organizations to authenticated;

-- members: everyone in the workspace sees the list; admins invite, change roles and remove
drop policy if exists org_read on public.org_members;
drop policy if exists org_admin on public.org_members;
create policy org_read on public.org_members for select to authenticated using (org_id = (select private.current_org()) and (select private.my_role()) is not null);
create policy org_admin on public.org_members for all to authenticated
  using (org_id = (select private.current_org()) and (select private.my_role()) = 'admin')
  with check (org_id = (select private.current_org()) and (select private.my_role()) = 'admin');
grant select, insert, update, delete on public.org_members to authenticated;

-- personal view settings: own row only
drop policy if exists own_row on public.user_prefs;
create policy own_row on public.user_prefs for all to authenticated
  using (org_id = (select private.current_org()) and email = (select private.who()) and (select private.my_role()) is not null)
  with check (org_id = (select private.current_org()) and email = (select private.who()) and (select private.my_role()) is not null);
grant select, insert, update, delete on public.user_prefs to authenticated;

-- machine keys: admins list and revoke (created through create_api_key)
drop policy if exists org_read on public.org_api_keys;
drop policy if exists org_revoke on public.org_api_keys;
create policy org_read on public.org_api_keys for select to authenticated using (org_id = (select private.current_org()) and (select private.my_role()) = 'admin');
create policy org_revoke on public.org_api_keys for update to authenticated using (org_id = (select private.current_org()) and (select private.my_role()) = 'admin') with check (org_id = (select private.current_org()));
revoke all on public.org_api_keys from authenticated;    -- the hash column stays unreadable from the browser
grant select (id, org_id, kind, name, last4, created_by, created_at, revoked_at), update (revoked_at) on public.org_api_keys to authenticated;
grant usage on all sequences in schema public to authenticated;

-- a workspace always keeps at least one admin
create or replace function private.keep_an_admin() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (tg_op = 'DELETE' or new.role <> 'admin') and old.role = 'admin'
     and not exists (select 1 from public.org_members m where m.org_id = old.org_id and m.role = 'admin' and m.email <> old.email) then
    raise exception 'A workspace needs at least one admin. Make someone else admin first.';
  end if;
  return coalesce(new, old);
end $$;
drop trigger if exists keep_an_admin on public.org_members;
create trigger keep_an_admin before update or delete on public.org_members for each row
  when (pg_trigger_depth() = 0) execute function private.keep_an_admin();

-- owners: only set through create_organization / set_member_owner (never by a direct write from the browser); an owner stays an admin;
-- only an owner changes or removes an owner; a workspace always keeps at least one owner
-- runs with the caller's rights (security invoker): a write straight from the browser runs as authenticated, the app's functions as their owner
create or replace function private.guard_owner() returns trigger language plpgsql security invoker set search_path = '' as $$
declare direct boolean := current_user in ('authenticated', 'anon');   -- inside the app's functions current_user is their owner
begin
  if tg_op <> 'DELETE' and new.is_owner and new.role <> 'admin' then raise exception 'An owner must stay an admin. Remove owner first.'; end if;
  if direct then
    if tg_op = 'INSERT' and new.is_owner then raise exception 'Owners are set from the team list by an owner.'; end if;
    if tg_op = 'UPDATE' and new.is_owner is distinct from old.is_owner then raise exception 'Owners are set from the team list by an owner.'; end if;
    if tg_op <> 'INSERT' and old.is_owner and not private.is_owner(old.org_id) then raise exception 'Only an owner can change or remove an owner.'; end if;
  end if;
  if tg_op <> 'INSERT' and old.is_owner and (tg_op = 'DELETE' or not new.is_owner)
     and not exists (select 1 from public.org_members m where m.org_id = old.org_id and m.is_owner and m.email <> old.email) then
    raise exception 'A workspace needs at least one owner. Make someone else owner first.';
  end if;
  return coalesce(new, old);
end $$;
drop trigger if exists guard_owner on public.org_members;
create trigger guard_owner before insert or update or delete on public.org_members for each row execute function private.guard_owner();
-- workspaces from before owners existed: their first admin becomes owner
update public.org_members m set is_owner = true
 where m.role = 'admin'
   and not exists (select 1 from public.org_members x where x.org_id = m.org_id and x.is_owner)
   and m.email = (select a.email from public.org_members a where a.org_id = m.org_id and a.role = 'admin' order by a.created_at, a.email limit 1);

-- Ask AI settings: owners read and change them (through set_ai_config); the server reads them as service_role
alter table public.org_ai_config enable row level security;
drop policy if exists owner_read on public.org_ai_config;
create policy owner_read on public.org_ai_config for select to authenticated using (org_id = (select private.current_org()) and (select private.is_owner(private.current_org())));
revoke all on public.org_ai_config from anon, authenticated;
grant select on public.org_ai_config to authenticated;

-- =====================================================================
-- 4. Functions the app calls
-- =====================================================================
-- create a workspace: the caller becomes its first admin and owner
create or replace function public.create_organization(p_name text, p_currency text default 'INR', p_tz_offset_min integer default 330,
                                                      p_crm_name text default 'CRM', p_brands text[] default '{}')
returns uuid language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); em text; o uuid; b text[];
begin
  select lower(email) into em from auth.users where id = uid and email_confirmed_at is not null;
  if em is null then raise exception 'Confirm your email first.'; end if;
  if (select count(*) from public.org_members where user_id = uid and role = 'admin') >= 10 then raise exception 'Limit reached: 10 workspaces per person.'; end if;
  b := array(select distinct btrim(x) from unnest(coalesce(p_brands, '{}')) x where btrim(x) <> '' limit 50);
  insert into public.organizations (name, currency, tz_offset_min, crm_name, created_by)
    values (btrim(p_name), upper(coalesce(nullif(btrim(p_currency), ''), 'INR')), coalesce(p_tz_offset_min, 330), coalesce(nullif(btrim(p_crm_name), ''), 'CRM'), uid)
    returning id into o;
  insert into public.org_members (org_id, email, user_id, role, is_owner, invited_by) values (o, em, uid, 'admin', true, em);
  insert into public.org_settings (org_id, settings, updated_by)
    values (o, jsonb_build_object('brands', to_jsonb(b), 'keywords', coalesce((select jsonb_agg(jsonb_build_array(x, x)) from unnest(b) x), '[]'::jsonb)), em);
  return o;
end $$;
revoke all on function public.create_organization(text, text, integer, text, text[]) from public, anon;
grant execute on function public.create_organization(text, text, integer, text, text[]) to authenticated;

-- link invites to the signed-in login once its email is proven
create or replace function public.accept_invites() returns integer language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  update public.org_members m set user_id = u.id
    from auth.users u
   where u.id = auth.uid() and m.user_id is null and m.email = lower(u.email)
     and u.email_confirmed_at is not null and (u.confirmation_sent_at is not null or u.invited_at is not null);
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.accept_invites() from public, anon;
grant execute on function public.accept_invites() to authenticated;

drop function if exists public.my_orgs();
create function public.my_orgs()
returns table (id uuid, public_id text, name text, logo text, currency text, tz_offset_min integer, crm_name text, role text, is_owner boolean)
language sql stable security definer set search_path = '' as $$
  select o.id, o.public_id, o.name, o.logo, o.currency, o.tz_offset_min, o.crm_name, private.org_role(o.id), private.is_owner(o.id)
    from public.organizations o
   where o.active and private.org_role(o.id) is not null
   order by o.name
$$;
revoke all on function public.my_orgs() from public, anon;
grant execute on function public.my_orgs() to authenticated;

-- tokens: admins store / replace / clear; the value goes into Vault and is never readable by the browser
create or replace function public.set_org_secret(p_key text, p_value text) returns text
language plpgsql security definer set search_path = '' as $$
declare o uuid := private.current_org(); v uuid; nm text; val text := btrim(coalesce(p_value, ''));
begin
  if o is null or coalesce(private.org_role(o), '') <> 'admin' then raise exception 'Only workspace admins can change tokens.'; end if;
  if p_key like 'ai\_%' and not private.is_owner(o) then raise exception 'Only the workspace owner can change AI keys.'; end if;
  if p_key not in ('meta_access_token', 'meta_capi_token', 'meta_audience_token', 'google_refresh_token', 'google_login_customer_id', 'ai_anthropic_key', 'ai_openai_key', 'ai_gemini_key', 'ai_compatible_key') then raise exception 'Unknown token %', p_key; end if;
  select vault_id into v from public.org_secrets where org_id = o and key = p_key;
  if val = '' then
    if v is not null then delete from vault.secrets where id = v; delete from public.org_secrets where org_id = o and key = p_key; end if;
    return 'cleared';
  end if;
  nm := 'org:' || o || ':' || p_key;
  if v is null then
    v := vault.create_secret(val, nm, 'Workspace token');
    insert into public.org_secrets (org_id, key, vault_id, last4, updated_by) values (o, p_key, v, right(val, 4), private.who());
  else
    perform vault.update_secret(v, val, nm, 'Workspace token');
    update public.org_secrets set last4 = right(val, 4), updated_by = private.who(), updated_at = now() where org_id = o and key = p_key;
  end if;
  return 'saved';
end $$;
revoke all on function public.set_org_secret(text, text) from public, anon;
grant execute on function public.set_org_secret(text, text) to authenticated;

create or replace function public.get_org_secret(p_org uuid, p_key text) returns text
language sql stable security definer set search_path = '' as $$
  select d.decrypted_secret from public.org_secrets s join vault.decrypted_secrets d on d.id = s.vault_id where s.org_id = p_org and s.key = p_key
$$;
revoke all on function public.get_org_secret(uuid, text) from public, anon, authenticated;
grant execute on function public.get_org_secret(uuid, text) to service_role;

-- owners make another admin owner, or stop being one (the last owner can't)
create or replace function public.set_member_owner(p_email text, p_owner boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare o uuid := private.current_org(); r text;
begin
  if o is null or not private.is_owner(o) then raise exception 'Only an owner can change owners.'; end if;
  select role into r from public.org_members where org_id = o and email = lower(btrim(p_email));
  if r is null then raise exception 'No member with that email.'; end if;
  if p_owner and r <> 'admin' then raise exception 'Make them admin first.'; end if;
  update public.org_members set is_owner = coalesce(p_owner, false) where org_id = o and email = lower(btrim(p_email));
end $$;
revoke all on function public.set_member_owner(text, boolean) from public, anon;
grant execute on function public.set_member_owner(text, boolean) to authenticated;

-- Ask AI: owners choose the provider, model and (for OpenAI-compatible services) the https address
create or replace function public.set_ai_config(p_enabled boolean, p_provider text, p_model text, p_base_url text default '') returns void
language plpgsql security definer set search_path = '' as $$
declare o uuid := private.current_org(); u text := btrim(coalesce(p_base_url, '')); h text;
begin
  if o is null or not private.is_owner(o) then raise exception 'Only the workspace owner can change AI settings.'; end if;
  if p_provider not in ('anthropic', 'openai', 'gemini', 'compatible') then raise exception 'Unknown AI provider.'; end if;
  if p_provider = 'compatible' then
    if u !~ '^https://[^\s/?#]+(/[^\s?#]*)?$' then raise exception 'The address must start with https://'; end if;
    h := lower(substring(u from '^https://([^/:]+)'));
    if h = 'localhost' or h like '%.local' or h like '%.internal' or h ~ '^(10|127|0)\.' or h ~ '^192\.168\.' or h ~ '^169\.254\.' or h ~ '^172\.(1[6-9]|2[0-9]|3[01])\.' or h like '[%' then
      raise exception 'That address points to a private network.'; end if;
  else u := ''; end if;
  insert into public.org_ai_config (org_id, enabled, provider, model, base_url, updated_by, updated_at)
    values (o, coalesce(p_enabled, false), p_provider, left(btrim(coalesce(p_model, '')), 200), u, private.who(), now())
  on conflict (org_id) do update set enabled = excluded.enabled, provider = excluded.provider, model = excluded.model, base_url = excluded.base_url,
    updated_by = excluded.updated_by, updated_at = excluded.updated_at;
end $$;
revoke all on function public.set_ai_config(boolean, text, text, text) from public, anon;
grant execute on function public.set_ai_config(boolean, text, text, text) to authenticated;

-- what every member may know about Ask AI: on or off, and which provider / model answers (no keys, no address)
create or replace function public.ai_status() returns table (enabled boolean, provider text, model text)
language sql stable security definer set search_path = '' as $$
  select c.enabled, c.provider, c.model from public.org_ai_config c
   where c.org_id = private.current_org() and private.org_role(c.org_id) is not null
$$;
revoke all on function public.ai_status() from public, anon;
grant execute on function public.ai_status() to authenticated;

-- machine keys: shown once, stored as a hash
create or replace function public.create_api_key(p_kind text, p_name text) returns text
language plpgsql security definer set search_path = '' as $$
declare o uuid := private.current_org(); raw text;
begin
  if o is null or coalesce(private.org_role(o), '') <> 'admin' then raise exception 'Only workspace admins can create keys.'; end if;
  if p_kind not in ('crm_push', 'api') then raise exception 'Unknown key type'; end if;
  raw := 'lp_' || case p_kind when 'crm_push' then 'push_' else 'api_' end || encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.org_api_keys (org_id, kind, name, key_hash, last4, created_by)
    values (o, p_kind, left(coalesce(btrim(p_name), ''), 60), encode(extensions.digest(raw, 'sha256'), 'hex'), right(raw, 4), private.who());
  return raw;
end $$;
revoke all on function public.create_api_key(text, text) from public, anon;
grant execute on function public.create_api_key(text, text) to authenticated;

-- duplicate-person keys: HMAC with a secret per workspace (kept in Vault); phone numbers and emails are never compared in the clear
create or replace function public.lead_keys(vals text[]) returns text[]
language plpgsql security definer set search_path = '' as $f$
declare o uuid := private.current_org(); pep text; out text[]; nm text;
begin
  if o is null or (coalesce((select auth.role()), '') <> 'service_role' and coalesce(private.org_role(o), '') not in ('admin', 'editor')) then raise exception 'not allowed'; end if;
  nm := 'org:' || o || ':lead_key_pepper';
  select decrypted_secret into pep from vault.decrypted_secrets where name = nm;
  if pep is null then perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), nm, 'Duplicate detection key');
    select decrypted_secret into pep from vault.decrypted_secrets where name = nm; end if;
  select array_agg(case when coalesce(v, '') = '' then '' else encode(extensions.hmac(v, pep, 'sha256'), 'hex') end order by i)
    into out from unnest(vals) with ordinality as t(v, i);
  return coalesce(out, '{}');
end $f$;
revoke all on function public.lead_keys(text[]) from public, anon;
grant execute on function public.lead_keys(text[]) to authenticated, service_role;

-- repeat leads: same person (phone, email or Facebook lead id) for the same brand → link to the previous lead
create or replace function public.refresh_lead_dupes() returns integer
language plpgsql security definer set search_path = '' as $f$
declare o uuid := private.current_org(); n integer;
begin
  if o is null or (coalesce((select auth.role()), '') <> 'service_role' and coalesce(private.org_role(o), '') not in ('admin', 'editor')) then raise exception 'not allowed'; end if;
  with k as (
    select lead_id, created_on, brand, 'phone' as how, phone_key as kv from public.crm_leads where org_id = o and phone_key <> '' and created_on is not null
    union all select lead_id, created_on, brand, 'email', email_key from public.crm_leads where org_id = o and email_key <> '' and created_on is not null
    union all select lead_id, created_on, brand, 'facebook lead id', fb_lead_id from public.crm_leads where org_id = o and fb_lead_id <> '' and created_on is not null),
  w as (
    select lead_id, how, lag(lead_id) over p as prev_lead, lag(created_on) over p as prev_created
      from k window p as (partition by brand, how, kv order by created_on, lead_id)),
  best as (
    select distinct on (lead_id) lead_id, prev_lead, prev_created, how from w where prev_lead is not null
     order by lead_id, prev_created desc, prev_lead desc, case how when 'phone' then 1 when 'email' then 2 else 3 end),
  m as (select l.lead_id, b.prev_lead, b.prev_created, b.how from public.crm_leads l left join best b on b.lead_id = l.lead_id where l.org_id = o)
  update public.crm_leads c set prev_lead = m.prev_lead, prev_created = m.prev_created, dup_match = m.how
    from m where c.org_id = o and c.lead_id = m.lead_id
     and (c.prev_lead is distinct from m.prev_lead or c.prev_created is distinct from m.prev_created or c.dup_match is distinct from m.how);
  get diagnostics n = row_count;
  return n;
end $f$;
revoke all on function public.refresh_lead_dupes() from public, anon;
grant execute on function public.refresh_lead_dupes() to authenticated, service_role;

-- assignee email → the name and manager seen in earlier CRM exports (so one person isn't split in two)
create or replace function public.owner_name_map(emails text[]) returns table (email text, owner text, manager text)
language sql stable security definer set search_path = '' as $$
  select distinct on (lower(l.extra ->> 'Assignee emailid')) lower(l.extra ->> 'Assignee emailid'), l.owner, l.manager
    from public.crm_leads l
   where l.org_id = private.current_org() and lower(l.extra ->> 'Assignee emailid') = any (emails) and l.owner <> '' and position('@' in l.owner) = 0
     and (coalesce((select auth.role()), '') = 'service_role' or private.org_role(private.current_org()) is not null)   -- members (or the server) only
   order by lower(l.extra ->> 'Assignee emailid'), l.updated_at desc
$$;
revoke all on function public.owner_name_map(text[]) from public, anon;
grant execute on function public.owner_name_map(text[]) to authenticated, service_role;

-- a new Meta upload replaces what's stored for the same campaign on the same days
create or replace function public.meta_replace_days(items jsonb) returns integer
language plpgsql security definer set search_path = '' as $f$
declare o uuid := private.current_org(); n integer;
begin
  if o is null or coalesce(private.org_role(o), '') not in ('admin', 'editor') then raise exception 'not allowed'; end if;
  with x as (select distinct lower(btrim(e->>'c')) as c, (e->>'d')::date as d from jsonb_array_elements(items) e)
  delete from public.meta_ad_rows m using x
   where m.org_id = o and lower(btrim(m.campaign)) = x.c and m.day <= x.d and m.day_end >= x.d;
  get diagnostics n = row_count;
  return n;
end $f$;
revoke all on function public.meta_replace_days(jsonb) from public, anon;
grant execute on function public.meta_replace_days(jsonb) to authenticated;

create or replace function public.meta_replace_account_days(items jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare o uuid := private.current_org(); n integer := 0; k integer; it jsonb;
begin
  if o is null or (coalesce((select auth.role()), '') <> 'service_role' and coalesce(private.org_role(o), '') not in ('admin', 'editor')) then raise exception 'not allowed'; end if;
  for it in select * from jsonb_array_elements(items) loop
    if it ? 'id' then
      delete from public.meta_ad_rows where org_id = o and source_file like 'Meta API%· ' || (case when it->>'id' like 'act_%' then it->>'id' else 'act_' || (it->>'id') end)
        and day >= (it->>'from')::date and day_end <= (it->>'to')::date;
    elsif coalesce(it->>'f', '') like 'Meta API · %' then
      delete from public.meta_ad_rows where org_id = o and source_file = it->>'f' and day >= (it->>'from')::date and day_end <= (it->>'to')::date;
    else continue; end if;
    get diagnostics k = row_count; n := n + k;
  end loop;
  return n;
end $$;
revoke all on function public.meta_replace_account_days(jsonb) from public, anon;
grant execute on function public.meta_replace_account_days(jsonb) to authenticated, service_role;

-- alerts / monitoring numbers (server only; scoped by the x-org-id header the server sends)
create or replace function public.alerts_brand_daily(p_from date, p_excluded text[] default '{}')
returns table (brand text, day date, spend numeric, leads numeric, crm bigint, ql bigint)
language sql stable security definer set search_path = public as $$
  with m as (
    select coalesce(nullif(r.brand, ''), 'Unmapped') as brand, r.day, sum(r.spend) as spend,
           sum(case when (r.result_indicator = '' or r.result_indicator ~* 'lead|form|messag|conversation|whatsapp')
                     and not (r.campaign = any (coalesce(p_excluded, '{}'))) then r.results else 0 end) as leads
    from public.meta_ad_rows r where r.org_id = private.current_org() and r.day >= p_from and r.day_end = r.day group by 1, 2),
  c as (
    select coalesce(nullif(l.brand, ''), 'Unmapped') as brand, l.created_on::date as day, count(*) as crm, count(*) filter (where l.is_ql) as ql
    from public.crm_leads l where l.org_id = private.current_org() and l.created_on >= p_from and l.prev_lead is null group by 1, 2)
  select coalesce(m.brand, c.brand), coalesce(m.day, c.day), coalesce(m.spend, 0), coalesce(m.leads, 0), coalesce(c.crm, 0), coalesce(c.ql, 0)
  from m full join c on m.brand = c.brand and m.day = c.day
$$;
create or replace function public.mon_brand_daily(p_from date, p_excluded text[] default '{}')
returns table (brand text, day date, spend numeric, leads numeric, impressions bigint, clicks bigint, crm bigint, ql bigint, rows_n bigint)
language sql stable security definer set search_path = public as $$
  with m as (
    select coalesce(nullif(r.brand, ''), 'Unmapped') as brand, r.day, sum(r.spend) as spend,
           sum(case when (r.result_indicator = '' or r.result_indicator ~* 'lead|form|messag|conversation|whatsapp')
                     and not (r.campaign = any (coalesce(p_excluded, '{}'))) then r.results else 0 end) as leads,
           sum(r.impressions)::bigint as impressions, sum(r.clicks)::bigint as clicks, count(*) as rows_n
    from public.meta_ad_rows r where r.org_id = private.current_org() and r.day >= p_from and r.day_end = r.day group by 1, 2),
  c as (
    select coalesce(nullif(l.brand, ''), 'Unmapped') as brand, l.created_on::date as day, count(*) as crm, count(*) filter (where l.is_ql) as ql
    from public.crm_leads l where l.org_id = private.current_org() and l.created_on >= p_from and l.prev_lead is null group by 1, 2)
  select coalesce(m.brand, c.brand), coalesce(m.day, c.day), coalesce(m.spend, 0), coalesce(m.leads, 0), coalesce(m.impressions, 0), coalesce(m.clicks, 0),
         coalesce(c.crm, 0), coalesce(c.ql, 0), coalesce(m.rows_n, 0)
  from m full join c on m.brand = c.brand and m.day = c.day
$$;
create or replace function public.mon_campaign_daily(p_from date, p_excluded text[] default '{}')
returns table (brand text, campaign text, day date, spend numeric, leads numeric, impressions bigint, clicks bigint, lead_type boolean)
language sql stable security definer set search_path = public as $$
  select coalesce(nullif(r.brand, ''), 'Unmapped'), r.campaign, r.day, sum(r.spend),
         sum(case when (r.result_indicator = '' or r.result_indicator ~* 'lead|form|messag|conversation|whatsapp') and not (r.campaign = any (coalesce(p_excluded, '{}'))) then r.results else 0 end),
         sum(r.impressions)::bigint, sum(r.clicks)::bigint,
         bool_or(r.result_indicator ~* 'lead|form|messag|conversation|whatsapp')
  from public.meta_ad_rows r where r.org_id = private.current_org() and r.day >= p_from and r.day_end = r.day
  group by 1, 2, 3
$$;
revoke all on function public.alerts_brand_daily(date, text[]) from public, anon, authenticated;
revoke all on function public.mon_brand_daily(date, text[]) from public, anon, authenticated;
revoke all on function public.mon_campaign_daily(date, text[]) from public, anon, authenticated;
grant execute on function public.alerts_brand_daily(date, text[]) to service_role;
grant execute on function public.mon_brand_daily(date, text[]) to service_role;
grant execute on function public.mon_campaign_daily(date, text[]) to service_role;

-- =====================================================================
-- 5. Views (row level security applies through security_invoker)
-- =====================================================================
create or replace view public.data_days with (security_invoker = true) as
  select distinct d from (
    select generate_series(day, least(day_end, day + 400), interval '1 day')::date as d from public.meta_ad_rows
    union
    select created_on::date from public.crm_leads where created_on is not null
  ) x;

create or replace function private.extra_get(x jsonb, want text[]) returns text set search_path = ''
language sql immutable as $$
  select nullif(trim(e.value), '') from jsonb_each_text(coalesce(x, '{}'::jsonb)) e
  where regexp_replace(lower(e.key), '[^a-z]', '', 'g') = any (want) and nullif(trim(e.value), '') is not null
  order by array_position(want, regexp_replace(lower(e.key), '[^a-z]', '', 'g')) limit 1
$$;
grant execute on function private.extra_get(jsonb, text[]) to authenticated, service_role;

create or replace view public.v_crm_google with (security_invoker = true) as
select * from (
  select l.lead_id, l.created_on, l.lead_source, l.status, l.crm_brand, l.first_call, l.owner, l.manager, l.prev_lead, l.prev_created, l.dup_match,
         l.lead_name, l.phone, l.email,
         private.extra_get(l.extra, array['utmcampaign', 'googlecampaignname', 'googlecampaign', 'googleadscampaign']) as utm_campaign,
         private.extra_get(l.extra, array['utmsource']) as utm_source,
         private.extra_get(l.extra, array['utmmedium']) as utm_medium,
         private.extra_get(l.extra, array['utmcontent', 'utmadgroup']) as utm_content,
         private.extra_get(l.extra, array['gclid']) as gclid
  from public.crm_leads l
) g
where g.lead_source ~* 'google|adwords' or g.gclid is not null or coalesce(g.utm_source, '') ~* 'google|adwords'
   or (g.utm_campaign is not null and coalesce(g.utm_source, '') !~* '(facebook|^fb|instagram|^ig$|^meta)');

create or replace view public.v_meta_daily with (security_invoker = true) as
  select day, day_end, brand, campaign, adset, ad, spend, results, result_indicator, currency, impressions, clicks,
         case when impressions > 0 then round(clicks::numeric / impressions, 4) end as ctr
  from public.meta_ad_rows;
create or replace view public.v_crm_leads with (security_invoker = true) as
  select lead_id, created_on, created_on::date as created_date, brand, crm_brand, lead_source, campaign, adset, ad, status, is_ql, owner, first_call, tat_min
  from public.crm_leads;
grant select on public.data_days, public.v_crm_google, public.v_meta_daily, public.v_crm_leads to authenticated;
revoke all on public.data_days, public.v_crm_google, public.v_meta_daily, public.v_crm_leads from anon;

-- =====================================================================
-- 6. Change history (people's changes only; automatic jobs aren't logged)
-- =====================================================================
create or replace function private.log_settings() returns trigger
language plpgsql security definer set search_path = public, private as $$
declare who text := private.who(); o jsonb := case when tg_op = 'UPDATE' then coalesce(old.settings, '{}'::jsonb) else '{}'::jsonb end;
        n jsonb := coalesce(new.settings, '{}'::jsonb); diff jsonb;
begin
  if who is null then return new; end if;
  select jsonb_object_agg(k, jsonb_build_array(o -> k, n -> k)) into diff
    from (select jsonb_object_keys(o) k union select jsonb_object_keys(n)) keys
   where (o -> k) is distinct from (n -> k) and k not in ('metaAutoCursor');
  if diff is null then return new; end if;
  insert into public.change_log (org_id, actor, area, action, detail) values (new.org_id, who, 'settings', 'changed', jsonb_build_object('keys', diff));
  return new;
end $$;
drop trigger if exists log_settings on public.org_settings;
create trigger log_settings after insert or update on public.org_settings for each row execute function private.log_settings();

create or replace function private.log_uploads() returns trigger
language plpgsql security definer set search_path = public, private as $$
declare who text := private.who(); r public.uploads;
begin
  if who is null then return coalesce(new, old); end if;
  if tg_op = 'DELETE' then r := old; else r := new; end if;
  insert into public.change_log (org_id, actor, area, action, detail) values (r.org_id, who, 'upload', case when tg_op = 'DELETE' then 'deleted' else 'added' end,
    jsonb_build_object('id', r.id, 'meta_files', to_jsonb(r.meta_files), 'crm_file', r.crm_file, 'meta_rows', r.meta_rows, 'crm_rows', r.crm_rows,
      'from', r.date_from, 'to', r.date_to, 'by', r.uploaded_by, 'uploaded_at', r.uploaded_at));
  return coalesce(new, old);
end $$;
drop trigger if exists log_uploads on public.uploads;
create trigger log_uploads after insert or delete on public.uploads for each row execute function private.log_uploads();

create or replace function private.log_team() returns trigger
language plpgsql security definer set search_path = public, private as $$
declare who text := private.who();
begin
  if who is null then return coalesce(new, old); end if;
  if tg_op = 'UPDATE' and old.role is not distinct from new.role then return new; end if;
  insert into public.change_log (org_id, actor, area, action, detail) values (coalesce(new.org_id, old.org_id), who, 'team',
    case tg_op when 'INSERT' then 'added' when 'DELETE' then 'deleted' else 'changed' end,
    jsonb_build_object('email', coalesce(new.email, old.email), 'old_role', case when tg_op <> 'INSERT' then old.role end, 'new_role', case when tg_op <> 'DELETE' then new.role end));
  return coalesce(new, old);
end $$;
drop trigger if exists log_team on public.org_members;
create trigger log_team after insert or update or delete on public.org_members for each row execute function private.log_team();

-- Schedules: the EC2 crontab (ec2/fanout.sh) calls /api/*-cron?org=<id> once per active workspace.
select 'schema ready' as status, count(*) as tables from information_schema.tables where table_schema = 'public';
