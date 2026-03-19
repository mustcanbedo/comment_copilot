-- 积分系统：免费积分 + 充值积分
-- 1 积分 = 1 次 AI 调用，注册送 2000 免费积分

-- 添加积分字段（若不存在）
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = current_schema() and table_name = 'users' and column_name = 'free_points_balance'
  ) then
    alter table users add column free_points_balance bigint not null default 2000;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = current_schema() and table_name = 'users' and column_name = 'topup_points_balance'
  ) then
    alter table users add column topup_points_balance bigint not null default 0;
  end if;
end $$;

-- 存量用户补发 2000 免费积分（仅当为 0 或 NULL 时）
update users set free_points_balance = 2000 where free_points_balance = 0 or free_points_balance is null;
update users set topup_points_balance = 0 where topup_points_balance is null;

-- 负余额防护
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'chk_users_points_positive'
  ) then
    alter table users add constraint chk_users_points_positive
      check (free_points_balance >= 0 and topup_points_balance >= 0);
  end if;
end $$;
