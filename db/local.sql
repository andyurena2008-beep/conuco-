create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

create schema auth;
create schema extensions;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('t.uid', true), '')::uuid
$$;

grant usage on schema public, auth to anon, authenticated, service_role;
grant usage on schema extensions to service_role;
-- Corre antes de base.sql, así que el permiso se aplica a las tablas que se creen después.
alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;
