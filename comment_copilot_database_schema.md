# Comment Copilot - Database Schema

> 目标：提供面向多租户内容创作者的高可用数据层，支撑「评论抓取 → AI 互动 → 潜客转化 → 报表洞察」全链路。

数据库：PostgreSQL 16（主从 + 只读副本），配套 Redis 用于缓存/队列。

最后更新：2026-03-11（v1.1 优化版）

---

## 1. 设计概述

### 1.1 设计原则

1. **多租户隔离**：所有业务表以 `tenant_id`（或 `user_id`）+主键组合索引，避免数据串扰。
2. **可追溯**：评论/回复/私信的状态流转均有审计记录，保证风控与合规。
3. **高吞吐**：评论写入采用分区表 + 异步流水线，P95 入库延迟 <3s。
4. **可扩展**：平台、账号、模型等均以配置驱动，预留扩展字段。
5. **成本透明**：关键表支持冷热分层、定期归档，便于控制存储与查询成本。

### 1.2 模块映射

| 模块 | 关键表 | 描述 |
|---|---|---|
| SaaS 账号/权限 | `users`, `tenants`, `user_memberships`, `roles`, `audit_logs` | 组织管理、RBAC、操作留痕 |
| 创作者资产 | `creators`, `accounts`, `videos`, `personas` | 多平台账号、视频内容、人设配置 |
| 评论与互动 | `comments`, `comment_events`, `ai_replies`, `reply_actions` | 评论存储、状态变化、AI 输出、人工操作 |
| 潜客与转化 | `leads`, `lead_actions`, `dm_conversations`, `deal_records` | 潜客生命周期、私信记录、转化结果 |
| 运维与洞察 | `reports`, `metrics_daily`, `webhook_events`, `job_queue` | 周报、指标、外部通知、后台任务 |

### 1.3 ER 概览（文本）

```
tenants ──┐
          ├─ users ── user_memberships ── roles
          ├─ creators ── accounts ── videos ── comments ── comment_events
          │                                           ├─ ai_replies ─ reply_actions
          │                                           └─ leads ── dm_conversations ─ deal_records
          ├─ personas
          └─ reports / metrics_daily / webhook_events
```

---

## 2. 命名与通用字段

- 主键：`id UUID DEFAULT gen_random_uuid()`。
- 时间：`created_at TIMESTAMPTZ DEFAULT now()`、`updated_at TIMESTAMPTZ DEFAULT now()`（触发器自动更新）。
- 软删：重要表加 `deleted_at TIMESTAMPTZ`（默认 `NULL`）。
- 枚举：使用 PostgreSQL ENUM（`status_comment`, `intent_level`, ...）或字符串 + CHECK 约束。
- 多租户：关键表包含 `tenant_id UUID REFERENCES tenants(id)`。

---

## 3. 核心表设计

### 3.1 Tenants & Users

```sql
CREATE TABLE tenants (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  plan_code TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE users (
  id UUID PRIMARY KEY,
  email CITEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE user_memberships (
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  role TEXT CHECK (role IN ('admin','editor','viewer')),
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE audit_logs (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  actor_id UUID,
  resource TEXT,
  action TEXT,
  payload JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_audit_tenant ON audit_logs(tenant_id, created_at DESC);
```

### 3.2 Creators & Accounts & Personas

```sql
CREATE TABLE creators (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  display_name TEXT,
  timezone TEXT DEFAULT 'Asia/Shanghai',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE accounts (
  id UUID PRIMARY KEY,
  creator_id UUID REFERENCES creators(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  platform TEXT CHECK (platform IN ('xiaohongshu','douyin','kuaishou','other')),
  platform_user_id TEXT,
  username TEXT,
  auth_state JSONB,
  status TEXT DEFAULT 'active',
  UNIQUE(platform, platform_user_id)
);
CREATE INDEX idx_accounts_tenant ON accounts(tenant_id);

CREATE TABLE personas (
  id UUID PRIMARY KEY,
  account_id UUID REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT,
  tone JSONB,            -- 语气、emoji、禁用词
  templates JSONB,       -- 评论/私信模板
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

### 3.3 Videos / Posts

```sql
CREATE TABLE videos (
  id UUID PRIMARY KEY,
  account_id UUID REFERENCES accounts(id) ON DELETE CASCADE,
  platform TEXT,
  platform_video_id TEXT,
  url TEXT,
  title TEXT,
  published_at TIMESTAMPTZ,
  metrics JSONB,
  UNIQUE(account_id, platform_video_id)
);
CREATE INDEX idx_videos_account_published ON videos(account_id, published_at DESC);
```

### 3.4 Comments（分区表）

```sql
CREATE TABLE comments (
  tenant_id UUID NOT NULL,
  id UUID NOT NULL,
  video_id UUID REFERENCES videos(id) ON DELETE CASCADE,
  platform_comment_id TEXT,
  parent_comment_id UUID,
  author_name TEXT,
  author_id TEXT,
  content TEXT,
  language TEXT,
  intent_score NUMERIC(5,2),
  intent_level TEXT CHECK (intent_level IN ('🔥','✨','👀','🚫')),
  status TEXT DEFAULT 'new',
  commented_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
) PARTITION BY RANGE (commented_at);

-- 每月分区
CREATE TABLE comments_2026_03 PARTITION OF comments
  FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');

CREATE INDEX idx_comments_video ON comments_2026_03(video_id, commented_at);
CREATE INDEX idx_comments_intent ON comments_2026_03(intent_level);
```

### 3.5 Comment Events & AI Replies

```sql
CREATE TABLE comment_events (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID,
  comment_id UUID,
  event_type TEXT CHECK (event_type IN ('ingested','scored','replied','rejected','archived')),
  payload JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE ai_replies (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  comment_id UUID NOT NULL, -- 通过 (tenant_id, comment_id) 与 comments 对齐，应用层保证引用完整性
  persona_id UUID REFERENCES personas(id),
  content TEXT,
  model TEXT,
  confidence NUMERIC(4,3),
  status TEXT CHECK (status IN ('generated','approved','sent','rejected')),
  created_at TIMESTAMPTZ DEFAULT now(),
  sent_at TIMESTAMPTZ
);
CREATE INDEX idx_ai_replies_comment ON ai_replies(tenant_id, comment_id);

CREATE TABLE reply_actions (
  id BIGSERIAL PRIMARY KEY,
  ai_reply_id UUID REFERENCES ai_replies(id),
  actor_id UUID,
  action TEXT CHECK (action IN ('approve','edit','reject','send')),
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### 3.6 Leads & 转化

```sql
CREATE TABLE leads (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  comment_id UUID NOT NULL, -- 与 comments 的 id 对齐，结合 tenant_id 使用
  assigned_to UUID REFERENCES users(id),
  intent_level TEXT,
  stage TEXT CHECK (stage IN ('new','contacted','nurturing','converted','lost')),
  score INT,
  source TEXT, -- comment / dm / import
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE lead_actions (
  id BIGSERIAL PRIMARY KEY,
  lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
  actor_id UUID,
  action TEXT,
  payload JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE dm_conversations (
  id UUID PRIMARY KEY,
  lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
  platform_thread_id TEXT,
  status TEXT DEFAULT 'open',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 私信消息量级可达数百万，采用按月分区
CREATE TABLE dm_messages (
  tenant_id UUID NOT NULL,
  id BIGINT NOT NULL,
  conversation_id UUID REFERENCES dm_conversations(id) ON DELETE CASCADE,
  sender TEXT CHECK (sender IN ('creator','lead','system')),
  content TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
) PARTITION BY RANGE (created_at);

CREATE TABLE dm_messages_2026_03 PARTITION OF dm_messages
  FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');

CREATE TABLE deal_records (
  id UUID PRIMARY KEY,
  lead_id UUID REFERENCES leads(id),
  amount NUMERIC(12,2),
  currency TEXT DEFAULT 'CNY',
  closed_at TIMESTAMPTZ,
  status TEXT CHECK (status IN ('won','lost','refunded')),
  reason TEXT
);
```

### 3.7 报表 & 任务

```sql
CREATE TABLE reports (
  id UUID PRIMARY KEY,
  tenant_id UUID,
  report_type TEXT,
  period_start DATE,
  period_end DATE,
  data JSONB,
  generated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE metrics_daily (
  tenant_id UUID,
  metric_date DATE,
  metric_name TEXT,
  metric_value NUMERIC,
  PRIMARY KEY (tenant_id, metric_date, metric_name)
);

CREATE TABLE job_queue (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID REFERENCES tenants(id),
  job_type TEXT,
  payload JSONB,
  run_at TIMESTAMPTZ,
  status TEXT DEFAULT 'pending',
  attempts INT DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_job_queue_tenant ON job_queue(tenant_id, status, run_at);

CREATE TABLE webhook_events (
  id UUID PRIMARY KEY,
  tenant_id UUID,
  endpoint TEXT,
  event_name TEXT,
  payload JSONB,
  status TEXT DEFAULT 'queued',
  retry_count INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### 3.8 Tenant Settings & AI Call Logs

```sql
CREATE TABLE tenant_settings (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id),
  intent_thresholds JSONB DEFAULT '{"hot":0.8,"warm":0.5,"cold":0.2}',
  send_throttle_comment_ms INT DEFAULT 30000,
  send_throttle_dm_ms INT DEFAULT 60000,
  monthly_token_budget INT DEFAULT 1000000,
  auto_reply_enabled BOOLEAN DEFAULT false,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE ai_call_logs (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  model TEXT NOT NULL,
  task_type TEXT CHECK (task_type IN ('intent','reply','dm_script','spam_filter')),
  input_tokens INT,
  output_tokens INT,
  latency_ms INT,
  cost_usd NUMERIC(10,6),
  status TEXT CHECK (status IN ('success','error','timeout')),
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_ai_logs_tenant_date ON ai_call_logs(tenant_id, created_at DESC);
```

---

## 4. 索引与性能策略

1. **分区**：`comments`, `comment_events`, `dm_messages` 采用按月分区，便于冷热分层与快速清理。
2. **组合索引**：
   - `comments(video_id, commented_at)` 支撑按视频查询。
   - `leads(tenant_id, stage, updated_at DESC)` 支撑潜客看板。
   - `ai_replies(comment_id, status)` 支撑审核查询。
3. **全文检索**：`comments`、`dm_messages` 可增加 `tsvector`（中文可用 zhparser + ngram）。
4. **物化视图**：`mv_lead_funnel_daily` 汇总转化漏斗，定时刷新。
5. **缓存**：Redis 存储热评论、模版、人设配置；设置 TTL + 版本号。
6. **异步写**：AI 日志、Webhook 通过 `job_queue` 异步处理，避免阻塞核心事务。

---

## 5. 数据治理

### 5.1 权限与安全

- 所有表以 `tenant_id` 过滤，API 层实施 Row Level Security (RLS)。
- 敏感字段（手机号、留资链接）使用 `pgcrypto` 列级加密。
- `audit_logs` 保留 180 天；归档到对象存储后可删除。

### 5.2 备份与恢复

- PITR：持续 WAL 归档 + 日度全量备份（保留 30 天）。
- 灾备：异地只读节点可在 15 分钟内提升为主库。

### 5.3 数据生命周期

- `comments`：保存 12 个月，超过后转移至冷数据仓库（Snowflake / BigQuery）。
- `dm_messages`：保留 18 个月，可按租户配置更短周期以满足 GDPR/数据最小化要求。
- `reports`：保留 24 个月，之后仅存聚合指标。

---

## 6. 计算指标与意向评分

意向公式：`I = w1*S + w2*F + w3*C + w4*R`

| 项 | 说明 | 数据来源 |
|---|---|---|
| S (Semantic) | 关键词、问价/链接等语义信号 | `comments.content` NLP 特征 |
| F (Frequency) | 历史互动频率、连发评论 | `comment_events` 聚合 |
| C (Context) | 视频类型、发布时间、平台权重 | `videos.metrics` + 平台配置 |
| R (Relationship) | 既有私域关系/粉丝标签 | `leads` / CRM 回写 |

- 模型输出 `intent_score`、`intent_level`，同时写入 `comment_events`。
- 决策阈值可按租户配置，写入 `tenant_settings`（可选表）。

---

## 7. 扩展与演进

1. **多平台**：`accounts.platform` + `videos.platform` + `comments.language` 支撑扩展至 Instagram、YouTube 等；若需不同字段，可通过 `platform_metadata JSONB` 存储特定结构。
2. **MCN 多账号**：`creators` 作为组织节点，`accounts`、`videos` 与之关联，借助 `user_memberships` 控制权限。
3. **模型自训练**：新增 `training_samples` 表（存储人工标注样本），便于蒸馏/微调。
4. **多区域部署**：可在不同 Region 维持独立主库，利用 Debezium + Kafka 进行增量同步至数据湖。

---

## 8. 数据量预估与容量规划

| 维度 | 假设 | 12 个月数据量 | 建议 |
|---|---|---|---|
| 创作者账号 | 1,000 | 1,000 rows | 单表无需特别优化 |
| 视频 | 每账号 10 条 | 10,000 rows | 常规模式 |
| 评论 | 视频均 1,000 评论 | 10,000,000 rows | 月分区 + 索引 200GB 级别 |
| 潜客 | 评论 5% 产生 lead | 500,000 rows | 需组合索引 |
| 私信消息 | 每 lead 5 条 | 2,500,000 rows | 分区 + 压缩 |

硬件建议：主库 8 vCPU / 64GB RAM，NVMe SSD；只读副本用于报表，Auto-VACUUM 参数按高写入调优。

---

## 9. 总结

- **结构化领域模型**：从 SaaS 用户→创作者→账号→内容→评论→潜客→成交的链路全量建模。
- **可运营的数据资产**：事件、审计、指标、报表表支撑运营与合规需求。
- **可扩展的基础**：通过分区、缓存、异步任务、RLS 等手段支持更高并发与更多平台。

该 Schema 将随产品版本迭代（PRD & 架构文档）同步更新，并在发布前进行 Migration Review。