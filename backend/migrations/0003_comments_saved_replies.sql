-- comments: 评论表，支持 status 与 replied_at
create table if not exists comments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  platform text not null,
  platform_comment_id text not null,
  author_name text not null,
  content text not null,
  intent_level text default 'cold',
  status text not null default 'pending',
  commented_at timestamptz not null,
  post_url text,
  is_author_reply boolean default false,
  replied_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, platform, platform_comment_id)
);

create index if not exists idx_comments_tenant_status on comments(tenant_id, status);
create index if not exists idx_comments_tenant_intent on comments(tenant_id, intent_level);

-- saved_replies: 存言（收藏的 AI 回复）
create table if not exists saved_replies (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  tenant_id uuid not null,
  text text not null,
  from_comment_id text,
  from_comment_snippet text,
  category text not null default '默认',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_saved_replies_user on saved_replies(user_id);
create index if not exists idx_saved_replies_tenant on saved_replies(tenant_id);
