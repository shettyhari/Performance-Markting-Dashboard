-- Lead Performance on your own Postgres (EC2) — platform pieces the schema expects. Run first, then db/10-schema.sql.
-- ec2/setup.sh runs both. Safe to run again.
--
-- What this replaces from Supabase, with the same names so the schema and the app don't change:
--   roles       anon / authenticated / service_role (what PostgREST switches to from the JWT's "role"), authenticator (PostgREST's login)
--   auth        auth.users (own login: api/auth.js), auth.email_tokens, auth.uid() / auth.jwt() / auth.role() read from the JWT
--   vault       vault.secrets + create_secret / update_secret / decrypted_secrets, encrypted with pgcrypto and a key only the owner can read

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------
-- Roles (PostgREST logs in as authenticator and switches to the JWT's role)
-- ---------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin noinherit bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator login noinherit; end if;
end $$;
grant anon, authenticated, service_role to authenticator;
grant usage on schema public, extensions to anon, authenticated, service_role;
-- like Supabase: new tables / functions in public are usable by the three roles; row level security decides what they see
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- auth: users of the app (passwords hashed with scrypt by api/auth.js) and the JWT helpers
-- ---------------------------------------------------------------------
create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

create table if not exists auth.users (
  id                   uuid primary key default gen_random_uuid(),
  email                text not null unique check (email = lower(btrim(email)) and email like '%@%'),
  encrypted_password   text not null,
  email_confirmed_at   timestamptz,
  confirmation_sent_at timestamptz,
  invited_at           timestamptz,
  raw_user_meta_data   jsonb not null default '{}'::jsonb,
  token_version        integer not null default 0,     -- bumped on password change / reset: older sessions stop working
  last_sign_in_at      timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
-- one-time links (verify email / reset password): only a sha256 of the token is stored
create table if not exists auth.email_tokens (
  token_hash text primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  kind       text not null check (kind in ('verify', 'reset')),
  expires_at timestamptz not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists email_tokens_user on auth.email_tokens (user_id, kind);
revoke all on auth.users, auth.email_tokens from anon, authenticated;
grant select, insert, update, delete on auth.users, auth.email_tokens to service_role;   -- only the server (api/auth.js) touches them

-- same definitions as Supabase: the claims PostgREST puts in request.jwt.claims
create or replace function auth.jwt() returns jsonb language sql stable set search_path = '' as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
$$;
create or replace function auth.uid() returns uuid language sql stable set search_path = '' as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;
create or replace function auth.role() returns text language sql stable set search_path = '' as $$
  select nullif(auth.jwt() ->> 'role', '')
$$;
grant execute on function auth.jwt(), auth.uid(), auth.role() to anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- vault: encrypted secrets (workspace tokens, duplicate-detection keys). Read only inside security definer functions.
-- ---------------------------------------------------------------------
create schema if not exists vault;
revoke all on schema vault from public, anon, authenticated, service_role;

create table if not exists vault.master_key (id integer primary key default 1 check (id = 1), k text not null);
insert into vault.master_key (k) select encode(extensions.gen_random_bytes(32), 'hex') where not exists (select 1 from vault.master_key);

create table if not exists vault.secrets (
  id          uuid primary key default gen_random_uuid(),
  name        text unique,
  description text not null default '',
  secret      bytea not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create or replace function vault.create_secret(new_secret text, new_name text default null, new_description text default '') returns uuid
language sql security definer set search_path = '' as $$
  insert into vault.secrets (name, description, secret)
  values (new_name, coalesce(new_description, ''), extensions.pgp_sym_encrypt(new_secret, (select k from vault.master_key where id = 1)))
  returning id
$$;
create or replace function vault.update_secret(secret_id uuid, new_secret text default null, new_name text default null, new_description text default null) returns void
language sql security definer set search_path = '' as $$
  update vault.secrets set
    secret = case when new_secret is null then secret else extensions.pgp_sym_encrypt(new_secret, (select k from vault.master_key where id = 1)) end,
    name = coalesce(new_name, name), description = coalesce(new_description, description), updated_at = now()
  where id = secret_id
$$;
create or replace view vault.decrypted_secrets as
  select s.id, s.name, s.description, extensions.pgp_sym_decrypt(s.secret, (select k from vault.master_key where id = 1)) as decrypted_secret, s.created_at, s.updated_at
  from vault.secrets s;
revoke all on all tables in schema vault from public, anon, authenticated, service_role;
revoke all on all functions in schema vault from public, anon, authenticated, service_role;

select 'platform ready' as status;
