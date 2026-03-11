---
name: build-ai-reply
description: 实现 Comment Copilot 的 AI 评论回复功能，包括意图识别、回复生成、批量处理、缓存和安全词过滤。当需要实现 AI 回复、意图检测、回复建议系统、ai.service.ts 时使用。
---

# AI 回复生成

## 意图类型

| 意图 | 示例评论 | 处理优先级 |
|---|---|---|
| `price` | 多少钱 / 什么价 | 🔥 高 |
| `purchase` | 哪里买 / 有链接吗 | 🔥 高 |
| `link_request` | 求链接 / 能发我吗 | 🔥 高 |
| `praise` | 好好看 / 太美了 | ✨ 中 |
| `question` | 怎么用 / 适合什么肤质 | ✨ 中 |
| `other` | 其他 | 👀 普通 |

## 模型路由策略

- 默认：\n  - 中文评论（文本主要为中文）：使用 **DeepSeek-V3** 生成回复。\n  - 非中文/多语言评论：使用 **GPT-4o**，保证跨语种表达质量。\n- 可配置：通过 `tenant_settings.intent_thresholds` 旁边增加模型偏好字段，在特定租户上强制使用某个模型（例如高端品牌账号全量 GPT-4o）。\n

## AI 调用入参

```typescript
interface ReplyRequest {
  comment: string;
  persona: { tone: string; blockedWords: string[]; ctaTemplate: string };
  platform: 'xiaohongshu' | 'douyin' | 'kuaishou';
  videoContext?: string; // 视频标题/描述，提升相关性
}
```

## Prompt 模板（存放于 `modules/ai/prompts/reply.prompt.ts`）

```typescript
export const REPLY_PROMPT = `你是一位{platform}创作者，以下是你的人设：
{persona_tone}

评论：{comment}

用中文写一条简短自然的回复（≤30字）。
规则：不提微信/手机号，引导至官方名片；禁止硬销售；返回 JSON。

输出格式：{"intent": "price|purchase|praise|question|other", "reply": "回复内容"}`;
```

## 批量处理（必须，禁止逐条调用）

```typescript
// ✅ 正确：BullMQ 队列批量处理
async processBatch(comments: Comment[]) {
  const chunks = chunk(comments, 20); // lodash chunk
  for (const batch of chunks) {
    await this.queue.add('ai-reply-batch', { comments: batch });
  }
}

// ❌ 错误：循环内单条调用
for (const c of comments) await this.aiService.reply(c);
```

## 缓存策略

```typescript
const cacheKey = `reply:${personaId}:${md5(comment.content)}`;
const cached = await this.redis.get(cacheKey);
if (cached) return JSON.parse(cached);
// ... AI 调用 ...
await this.redis.set(cacheKey, JSON.stringify(result), 'EX', 86400); // TTL 24h
```

## 输出格式

```json
{ "intent": "price", "reply": "现在有活动价～我私信发你详细介绍～" }
```

## 服务文件路径

```
services/api/src/modules/ai/
  ai.service.ts          # 主入口，调用 LLM
  prompts/
    reply.prompt.ts
    intent.prompt.ts
  ai.module.ts
```
