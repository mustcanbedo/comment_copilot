import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  bigserial,
} from 'drizzle-orm/pg-core'

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  apiKey: text('api_key').notNull().unique(),
  planCode: text('plan_code').default('basic').notNull(),
  status: text('status').default('active').notNull(),
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

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash'),
  fullName: text('full_name').default(''),
  role: text('role').default('owner').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  platform: text('platform').notNull(),
  platformUserId: text('platform_user_id').default(''),
  username: text('username').default(''),
  status: text('status').default('active').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  unique().on(t.platform, t.platformUserId),
  index('idx_accounts_tenant').on(t.tenantId),
])

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
  isAuthorReply: boolean('is_author_reply').default(false).notNull(),
  intentLevel: text('intent_level').default('cold'),
  intentScore: numeric('intent_score', { precision: 5, scale: 2 }),
  status: text('status').default('pending').notNull(),
  commentedAt: timestamp('commented_at').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  unique().on(t.tenantId, t.platform, t.platformCommentId),
  index('idx_comments_tenant').on(t.tenantId, t.commentedAt),
  index('idx_comments_intent').on(t.tenantId, t.intentLevel),
])

export const aiReplies = pgTable('ai_replies', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  commentId: uuid('comment_id').notNull().references(() => comments.id),
  suggestions: jsonb('suggestions').notNull().$type<string[]>(),
  selectedIndex: integer('selected_index'),
  modelUsed: text('model_used').notNull(),
  promptTokens: integer('prompt_tokens').default(0),
  completionTokens: integer('completion_tokens').default(0),
  costUsd: numeric('cost_usd', { precision: 10, scale: 6 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  index('idx_ai_replies_comment').on(t.commentId),
])

export const leads = pgTable('leads', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  commentId: uuid('comment_id').notNull().references(() => comments.id),
  intentLevel: text('intent_level').notNull(),
  stage: text('stage').default('new').notNull(),
  note: text('note').default(''),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => [
  index('idx_leads_tenant').on(t.tenantId, t.stage),
])

export const aiCallLogs = pgTable('ai_call_logs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  model: text('model').notNull(),
  taskType: text('task_type').notNull(),
  inputTokens: integer('input_tokens').default(0),
  outputTokens: integer('output_tokens').default(0),
  latencyMs: integer('latency_ms'),
  costUsd: numeric('cost_usd', { precision: 10, scale: 6 }),
  status: text('status').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  index('idx_ai_logs_tenant').on(t.tenantId, t.createdAt),
])

export const selectorConfigs = pgTable('selector_configs', {
  id: uuid('id').primaryKey().defaultRandom(),
  platform: text('platform').notNull().unique(),
  version: text('version').notNull(),
  selectors: jsonb('selectors').notNull().$type<{
    commentList: string
    authorName: string
    content: string
    timestamp: string
    commentId: string
  }>(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

export const auditLogs = pgTable('audit_logs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  actorId: uuid('actor_id'),
  resource: text('resource'),
  action: text('action'),
  payload: jsonb('payload'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  index('idx_audit_tenant').on(t.tenantId, t.createdAt),
])
