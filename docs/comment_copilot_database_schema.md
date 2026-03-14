# Comment Copilot - Database Schema

> 目标：以最简洁的表结构支撑 MVP 核心链路，避免过度设计。分区、物化视图、RLS 等高级特性在数据量驱动时再引入。

数据库：Neon DB（Serverless PostgreSQL），ORM：Drizzle ORM。

最后更新：2026-03-13（v2.0 MVP 简化版）

---

## 1. 设计原则

1. **够用即可**：MVP 阶段只建核心表，不预建未来表。
2. **多租户隔离**：所有业务表包含 `tenant_id`，应用层强制过滤。
3. **字符串枚举**：`intent_level` 等字段使用 `'hot'/'warm'/'cold'/'spam'` 字符串，UI 层映射 Emoji，避免数据库 Emoji 编码问题。
4. **UUID 主键**：全部使用 `gen_random_uuid()`，适合 Serverless 分布式环境。
5. **不分区**：MVP 阶段（评论量 < 500 万行）不使用分区表，待真实性能瓶颈出现后再引入。

---

## 2. 表结构（Drizzle Schema）

### 2.1 Tenants（租户）

合并了原 `tenants` + `tenant_settings`，减少 JOIN 查询：

```typescript
export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  apiKey: text('api_key').notNull().unique(),
  planCode: text('plan_code').default('basic').notNull(),
  status: text('status').default('active').notNull(),

  // 人设配置（原 tenant_settings）
  persona: text('persona').default(''),
  defaultModel: text('default_model').default('deepseek-chat').notNull(),
  sendThrottleCommentMs: integer('send_throttle_comment_ms').default(30000).notNull(),
  sendThrottleDmMs: integer('send_throttle_dm_ms').default(60000).notNull(),
  monthlyTokenBudget: integer('monthly_token_budget').default(1000000).notNull(),
  autoReplyEnabled: boolean('auto_reply_enabled').default(false).notNull(),
  intentThresholds: jsonb('intent_thresholds')
    .$type<{ hot: number; warm: number; cold: number }>()
    .default({ hot: 0.8, warm: 0.5, cold: 0.2 }),

  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})
```

### 2.2 Users（用户）

MVP 阶段简化：移除 `roles` / `user_roles` 表，`role` 字段直接存在 `users` 表：

```typescript
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash'),
  fullName: text('full_name').default(''),
  role: text('role').default('owner').notNull(), // 'owner' | 'editor' | 'viewer'
  createdAt: timestamp('created_at').defaultNow().notNull(),
})
```

### 2.3 Accounts（平台账号）

```typescript
export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  platform: text('platform').notNull(), // 'xiaohongshu' | 'douyin' | 'kuaishou'
  platformUserId: text('platform_user_id').default(''),
  username: text('username').default(''),
  status: text('status').default('active').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  uniq: unique().on(t.platform, t.platformUserId),
  idxTenant: index('idx_accounts_tenant').on(t.tenantId),
}))
```

### 2.4 Comments（评论）

**不分区**，单表存储，MVP 阶段完全够用：

```typescript
export const comments = pgTable('comments', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  accountId: uuid('account_id').references(() => accounts.id),
  platform: text('platform').notNull(),
  platformCommentId: text('platform_comment_id').notNull(),
  authorName: text('author_name').notNull(),
  authorId: text('author_id').default(''),
  content: text('content').notNull(),
  postUrl: text('post_url').default(''),
  isAuthorReply: boolean('is_author_reply').default(false).notNull(), // 是否笔记作者自己的回复，列表过滤用
  intentLevel: text('intent_level').default('cold'), // 'hot' | 'warm' | 'cold' | 'spam'
  intentScore: numeric('intent_score', { precision: 5, scale: 2 }),
  status: text('status').default('pending').notNull(), // 'pending' | 'replied' | 'ignored' | 'author'
  commentedAt: timestamp('commented_at').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  uniqComment: unique().on(t.tenantId, t.platform, t.platformCommentId),
  idxTenant: index('idx_comments_tenant').on(t.tenantId, t.commentedAt),
  idxIntent: index('idx_comments_intent').on(t.tenantId, t.intentLevel),
}))
```

### 2.5 AI Replies（AI 回复建议）

```typescript
export const aiReplies = pgTable('ai_replies', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  commentId: uuid('comment_id').notNull().references(() => comments.id),
  suggestions: jsonb('suggestions').notNull().$type<string[]>(),
  selectedIndex: integer('selected_index'), // 用户选择了哪条，null 表示未选
  modelUsed: text('model_used').notNull(),
  promptTokens: integer('prompt_tokens').default(0),
  completionTokens: integer('completion_tokens').default(0),
  costUsd: numeric('cost_usd', { precision: 10, scale: 6 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  idxComment: index('idx_ai_replies_comment').on(t.commentId),
}))
```

### 2.6 Leads（潜客）

```typescript
export const leads = pgTable('leads', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  commentId: uuid('comment_id').notNull().references(() => comments.id),
  intentLevel: text('intent_level').notNull(), // 'hot' | 'warm'
  stage: text('stage').default('new').notNull(), // 'new' | 'contacted' | 'converted' | 'lost'
  note: text('note').default(''),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  idxTenant: index('idx_leads_tenant').on(t.tenantId, t.stage),
}))
```

### 2.7 AI Call Logs（AI 调用日志）

用于成本分析和告警：

```typescript
export const aiCallLogs = pgTable('ai_call_logs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  model: text('model').notNull(),
  taskType: text('task_type').notNull(), // 'reply' | 'intent' | 'dm_script'
  inputTokens: integer('input_tokens').default(0),
  outputTokens: integer('output_tokens').default(0),
  latencyMs: integer('latency_ms'),
  costUsd: numeric('cost_usd', { precision: 10, scale: 6 }),
  status: text('status').notNull(), // 'success' | 'error' | 'timeout'
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  idxTenantDate: index('idx_ai_logs_tenant_date').on(t.tenantId, t.createdAt),
}))
```

### 2.8 Selector Configs（DOM 选择器热更新）

```typescript
export const selectorConfigs = pgTable('selector_configs', {
  id: uuid('id').primaryKey().defaultRandom(),
  platform: text('platform').notNull().unique(), // 'xiaohongshu' | 'douyin'
  version: text('version').notNull(), // e.g. '2026.03.12'
  selectors: jsonb('selectors').notNull().$type<{
    commentList: string
    authorName: string
    content: string
    timestamp: string
    commentId: string
  }>(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})
```

### 2.9 Audit Logs（操作审计）

```typescript
export const auditLogs = pgTable('audit_logs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  actorId: uuid('actor_id'),
  resource: text('resource'),
  action: text('action'),
  payload: jsonb('payload'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  idxTenant: index('idx_audit_tenant').on(t.tenantId, t.createdAt),
}))
```

---

## 3. 精简后的 ER 关系

```
tenants ──┬── users
          ├── accounts ── comments ── ai_replies
          │                       └── leads
          ├── ai_call_logs
          ├── audit_logs
          └── selector_configs（全局，无 tenant_id）
```

---

## 4. 与 v1.1 的对比（简化内容）

| 变更项 | v1.1（旧） | v2.0（新） | 原因 |
|---|---|---|---|
| `comments` 表 | 按月分区 | 单表 | MVP 数据量不需要分区 |
| `dm_messages` 表 | 按月分区 | 暂不建表 | M1 再引入 |
| `tenant_settings` 表 | 独立表 | 合并到 `tenants` | 减少 JOIN |
| `roles` / `user_roles` 表 | 独立表 | `users.role` 字段 | MVP 不需要复杂 RBAC |
| `intent_level` 枚举 | Emoji（`🔥✨👀🚫`） | 字符串（`hot/warm/cold/spam`） | 避免编码问题 |
| `comment_events` 表 | 存在 | 暂不建表 | 用 `comments.status` 字段替代 |
| `creators` / `videos` 表 | 存在 | 暂不建表 | M1 再引入 |
| `reports` / `metrics_daily` 表 | 存在 | 暂不建表 | M2 再引入 |
| 物化视图 | 规划 | 不引入 | 数据量不到瓶颈 |
| RLS | 规划 | 不引入 | 应用层过滤已足够 |

---

## 5. 数据量预估（MVP 阶段）

| 维度 | 假设 | 数据量 | 建议 |
|---|---|---|---|
| 租户 | 100 | 100 rows | 无需优化 |
| 评论 | 每租户 1k/月 | 100k rows/月 | 单表 + 索引完全够用 |
| AI 回复 | 每评论 1 次 | 100k rows/月 | 同上 |
| AI 调用日志 | 每次调用 1 条 | 100k rows/月 | 同上 |

**分区引入时机**：当 `comments` 表超过 500 万行时，通过 `pg_partman` 引入按月分区。

---

## 6. Migration 策略

使用 `drizzle-kit` 管理 migration：

```bash
# 生成 migration 文件
npm run db:generate

# 执行 migration（连接 Neon DB）
npm run db:migrate
```

Migration 文件纳入 Git 版本控制，每次 Schema 变更都生成新的 migration 文件，不直接修改已有文件。
