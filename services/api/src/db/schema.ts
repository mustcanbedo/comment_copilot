import { pgTable, text, timestamp, uuid, jsonb, integer } from 'drizzle-orm/pg-core'

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  apiKey: text('api_key').notNull().unique(),
  persona: text('persona').default(''),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

export const comments = pgTable('comments', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  platform: text('platform').notNull(),
  platformCommentId: text('platform_comment_id').notNull(),
  authorName: text('author_name').notNull(),
  content: text('content').notNull(),
  postUrl: text('post_url').default(''),
  intentLevel: text('intent_level').default('cold'),
  status: text('status').default('pending').notNull(),
  commentedAt: timestamp('commented_at').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

export const aiReplies = pgTable('ai_replies', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  commentId: uuid('comment_id').notNull().references(() => comments.id),
  suggestions: jsonb('suggestions').notNull().$type<string[]>(),
  modelUsed: text('model_used').notNull(),
  promptTokens: integer('prompt_tokens').default(0),
  completionTokens: integer('completion_tokens').default(0),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})
