-- User-only schema (Tenant and business tables removed).
create extension if not exists "pgcrypto";

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  phone text not null unique,
  password_hash text,
  full_name text default '',
  created_at timestamp not null default now()
);

-- Cleanup removed tables in legacy databases.
drop table if exists audit_logs;
drop table if exists selector_configs;
drop table if exists leads;
drop table if exists ai_replies;
drop table if exists comments;
drop table if exists accounts;
drop table if exists ai_call_logs;
drop table if exists tenants;
