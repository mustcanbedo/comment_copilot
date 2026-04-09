-- Upgrade existing users table:
-- 1) rename email -> phone
-- 2) drop role column
-- 3) keep unique constraint on phone

do $$
begin
  -- Rename email column to phone when upgrading old schema.
  if exists (
    select 1
    from information_schema.columns
    where table_schema = current_schema()
      and table_name = 'users'
      and column_name = 'email'
  ) and not exists (
    select 1
    from information_schema.columns
    where table_schema = current_schema()
      and table_name = 'users'
      and column_name = 'phone'
  ) then
    alter table users rename column email to phone;
  end if;
end $$;

do $$
begin
  -- Ensure phone is not null after rename/new install.
  if exists (
    select 1
    from information_schema.columns
    where table_schema = current_schema()
      and table_name = 'users'
      and column_name = 'phone'
  ) then
    alter table users alter column phone set not null;
  end if;
end $$;

do $$
begin
  -- Drop role column if it still exists in old schema.
  if exists (
    select 1
    from information_schema.columns
    where table_schema = current_schema()
      and table_name = 'users'
      and column_name = 'role'
  ) then
    alter table users drop column role;
  end if;
end $$;

do $$
begin
  -- Create unique index on phone when missing.
  if not exists (
    select 1
    from pg_indexes
    where schemaname = current_schema()
      and tablename = 'users'
      and indexname = 'idx_users_phone_unique'
  ) then
    create unique index idx_users_phone_unique on users(phone);
  end if;
end $$;
