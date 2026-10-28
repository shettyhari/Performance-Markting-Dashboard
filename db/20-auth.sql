-- Lead Performance — own login: the functions api/auth.js calls (through PostgREST, as service_role only).
-- auth.users / auth.email_tokens stay outside the API's public schema; these functions are the only way in.
-- Passwords are hashed by the server (scrypt) before they get here; email-link tokens arrive as sha256 hashes.
-- Safe to run again.

alter table auth.users add column if not exists failed_logins integer not null default 0;
alter table auth.users add column if not exists locked_until timestamptz;
-- a sign-up link carries the password chosen at that sign-up: confirming needs it, so a link from someone else's sign-up with your email is useless
alter table auth.email_tokens add column if not exists password_hash text;

drop function if exists public.auth_user_get(uuid, text);
create function public.auth_user_get(p_id uuid default null, p_email text default null)
returns table (id uuid, email text, encrypted_password text, email_confirmed_at timestamptz, confirmation_sent_at timestamptz,
               invited_at timestamptz, raw_user_meta_data jsonb, token_version integer, locked_until timestamptz)
language sql stable security definer set search_path = '' as $$
  select u.id, u.email, u.encrypted_password, u.email_confirmed_at, u.confirmation_sent_at, u.invited_at, u.raw_user_meta_data, u.token_version, u.locked_until
  from auth.users u
  where (p_id is not null and u.id = p_id) or (p_id is null and u.email = lower(btrim(p_email)))
  limit 1
$$;

-- new account; null when the email is already registered
create or replace function public.auth_user_create(p_email text, p_hash text, p_name text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v uuid;
begin
  insert into auth.users (email, encrypted_password, raw_user_meta_data)
  values (lower(btrim(p_email)), p_hash, case when nullif(btrim(p_name), '') is null then '{}'::jsonb else jsonb_build_object('full_name', left(btrim(p_name), 120)) end)
  on conflict (email) do nothing
  returning id into v;
  return v;
end $$;

-- p_hash: new password (also bumps token_version, so other sessions end, and lifts a lockout); p_name: profile name;
-- p_signed_in: a good sign-in (clears failed attempts); p_failed: a wrong password (10 in a row lock the account for 15 minutes)
drop function if exists public.auth_user_update(uuid, text, text, boolean);
drop function if exists public.auth_user_update(uuid, text, text, boolean, boolean);
create function public.auth_user_update(p_id uuid, p_hash text default null, p_name text default null, p_signed_in boolean default false, p_failed boolean default false)
returns integer language plpgsql security definer set search_path = '' as $$
declare v integer;
begin
  update auth.users set
    encrypted_password = coalesce(p_hash, encrypted_password),
    token_version = token_version + case when p_hash is null then 0 else 1 end,
    raw_user_meta_data = case when p_name is null then raw_user_meta_data else raw_user_meta_data || jsonb_build_object('full_name', left(btrim(p_name), 120)) end,
    last_sign_in_at = case when p_signed_in then now() else last_sign_in_at end,
    failed_logins = case when p_signed_in or p_hash is not null then 0 when p_failed then failed_logins + 1 else failed_logins end,
    locked_until = case when p_signed_in or p_hash is not null then null
                        when p_failed and failed_logins + 1 >= 10 then now() + interval '15 minutes' else locked_until end,
    updated_at = now()
  where id = p_id
  returning token_version into v;
  if p_failed then update auth.users set failed_logins = 0 where id = p_id and locked_until is not null and failed_logins >= 10; end if;
  return v;
end $$;

-- a one-time link (verify / reset; p_pw = the sign-up's password hash); older unused links of the same kind stop working.
-- false (nothing created) when a link of that kind went out less than a minute ago.
drop function if exists public.auth_token_add(uuid, text, text, integer);
drop function if exists public.auth_token_add(uuid, text, text, integer, text);
create function public.auth_token_add(p_user uuid, p_kind text, p_hash text, p_minutes integer, p_pw text default null)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_kind not in ('verify', 'reset') then raise exception 'unknown link kind'; end if;
  if exists (select 1 from auth.email_tokens t where t.user_id = p_user and t.kind = p_kind and t.created_at > now() - interval '1 minute') then return false; end if;
  update auth.email_tokens set used_at = now() where user_id = p_user and kind = p_kind and used_at is null;
  insert into auth.email_tokens (token_hash, user_id, kind, expires_at, password_hash) values (p_hash, p_user, p_kind, now() + make_interval(mins => greatest(p_minutes, 1)), p_pw);
  if p_kind = 'verify' then update auth.users set confirmation_sent_at = now(), updated_at = now() where id = p_user; end if;
  delete from auth.email_tokens where expires_at < now() - interval '7 days';
  return true;
end $$;

-- a link that still works: its user and (sign-up links) the password chosen with it; nothing when unknown / used / expired
create or replace function public.auth_token_peek(p_hash text, p_kind text)
returns table (user_id uuid, password_hash text) language sql stable security definer set search_path = '' as $$
  select t.user_id, t.password_hash from auth.email_tokens t where t.token_hash = p_hash and t.kind = p_kind and t.used_at is null and t.expires_at > now()
$$;

-- uses a link once (a sign-up link also makes its password the account's): returns its user, or null when unknown / used / expired. Either kind proves the person reads that inbox.
create or replace function public.auth_token_use(p_hash text, p_kind text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v uuid; pw text;
begin
  update auth.email_tokens set used_at = now()
  where token_hash = p_hash and kind = p_kind and used_at is null and expires_at > now()
  returning user_id, password_hash into v, pw;
  if v is not null then
    if pw is not null then update auth.users set encrypted_password = pw, token_version = token_version + 1 where id = v; end if;
    update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()), confirmation_sent_at = coalesce(confirmation_sent_at, now()), updated_at = now()
    where id = v;
  end if;
  return v;
end $$;

revoke all on function public.auth_user_get(uuid, text), public.auth_user_create(text, text, text), public.auth_user_update(uuid, text, text, boolean, boolean),
  public.auth_token_add(uuid, text, text, integer, text), public.auth_token_peek(text, text), public.auth_token_use(text, text) from public, anon, authenticated;
grant execute on function public.auth_user_get(uuid, text), public.auth_user_create(text, text, text), public.auth_user_update(uuid, text, text, boolean, boolean),
  public.auth_token_add(uuid, text, text, integer, text), public.auth_token_peek(text, text), public.auth_token_use(text, text) to service_role;

select 'auth functions ready';
