# Comment Copilot - 技术架构文档

> 目标：以最小的基础设施负担，快速验证"评论采集 → AI 回复建议 → 潜客转化"核心价值链路。单人开发，优先选择托管服务，消除运维负担。

最后更新：2026-03-12（v2.0 Serverless 版）

---

## 1. 系统总览

### 1.1 整体架构

```
┌─────────────────────────────────────────────────────────┐
│                   Chrome Extension (Plasmo)              │
│  content script (MutationObserver DOM 解析)              │
│  background script (消息路由 + API 调用)                  │
│  sidepanel (React UI：评论列表 + AI 回复建议)              │
└────────────────────┬────────────────────────────────────┘
                     │ HTTPS
┌────────────────────▼────────────────────────────────────┐
│              Next.js App (Vercel 部署)                   │
│  app/api/ingest/comments  → 写入 Neon DB                 │
│  app/api/ai/reply         → 调用 DeepSeek-V3             │
│  app/api/inngest          → Inngest 函数入口              │
│  app/(dashboard)          → Web 控制台 (React UI)        │
└────────────────────┬────────────────────────────────────┘
                     │
        ┌────────────┴────────────┐
        ▼                         ▼
┌───────────────┐        ┌────────────────┐
│  Neon DB      │        │  Inngest       │
│  (Serverless  │        │  (后台任务队列) │
│   PostgreSQL) │        │  - AI 批处理   │
│  Drizzle ORM  │        │  - SLA 定时器  │
└───────────────┘        └────────────────┘
```

关键决策：
- **单体 Next.js 应用**：API Routes + Web 控制台合并在同一项目，无需独立后端服务。
- **Vercel 部署**：Git 推送即部署，自动 SSL、CDN、环境变量管理，零运维。
- **Neon DB**：Serverless PostgreSQL，按需付费，自动扩展，月费可低至 $0。
- **Inngest**：基于 HTTP 的无服务器任务队列，替代 BullMQ + Redis，无需管理消息队列。

### 1.2 环境

| 环境 | 说明 | 部署方式 |
|---|---|---|
| `local` | 本地开发，`next dev` + Inngest Dev Server | 本地运行 |
| `preview` | PR 预览，Vercel Preview Deployment | Git Push 自动触发 |
| `production` | 正式环境 | Vercel Production |

---

## 2. Chrome 插件架构

### 2.1 三层职责

| 层 | 文件 | 职责 |
|---|---|---|
| Content Script | `contents/xiaohongshu.ts` | DOM 解析、MutationObserver 监听、数据提取 |
| Background Script | `background.ts` | 消息路由、API 调用、速率限制、断路器 |
| Side Panel | `sidepanel/index.tsx` | 评论列表展示、AI 回复建议、一键复制 |

### 2.2 数据采集合规设计

**核心原则：插件不主动发起任何对平台服务器的 HTTP 请求，所有数据来自浏览器已渲染的 DOM。**

```
用户打开小红书笔记页面
  → 平台正常加载评论（用户行为）
  → MutationObserver 检测到评论区 DOM 变化
  → Content Script 解析新增节点（addedNodes）
  → 提取评论数据（评论ID、作者、内容、时间）
  → 发送消息给 Background Script
  → Background Script 批量上报到 /api/ingest/comments
```

### 2.3 风险控制机制

**断路器（Circuit Breaker）**：
- 连续 5 次 DOM 选择器匹配失败 → 停止所有操作
- 向 Background 发送 `CIRCUIT_OPEN` 消息
- 插件图标显示错误角标，提示"平台已更新，请等待适配"

**随机延迟**：
- 任何模拟用户操作前加入 300~500ms 随机延迟
- `await new Promise(r => setTimeout(r, 300 + Math.random() * 200))`

**速率限制（Background Script 维护）**：
- 最近 1 小时操作时间戳队列
- 两次回复间隔 ≥ 30s，两次私信间隔 ≥ 60s
- 大促模式下可临时调整为 ≥ 15s

### 2.4 Selector 热更新

- 每个平台维护独立 selector 配置（JSON），存储在 Neon DB 的 `selector_configs` 表。
- 插件启动时从 `/api/selectors?platform=xiaohongshu` 拉取最新配置，缓存到 `chrome.storage.local`。
- DOM 结构变动时，只需更新数据库记录，无需重新发布插件。

---

## 3. Next.js API 设计

### 3.1 核心接口

| 接口 | 方法 | 说明 |
|---|---|---|
| `/api/ingest/comments` | POST | 接收插件上报的评论批次，写入 DB |
| `/api/ai/reply` | POST | 接收评论内容，调用 DeepSeek-V3，返回 3 条建议 |
| `/api/comments` | GET | 查询当前 tenant 的评论列表 |
| `/api/selectors` | GET | 返回指定平台的 DOM selector 配置 |
| `/api/inngest` | POST | Inngest 函数入口（webhook） |
| `/api/health` | GET | 健康检查 |

### 3.2 认证

- MVP 阶段：`x-tenant-id` Header（简单占位）。
- M1 阶段：NextAuth.js（邮箱 + Google OAuth），JWT Session。
- API Key 鉴权（Agency 套餐对外 API）。

### 3.3 多租户

- 所有数据库查询强制携带 `tenant_id` 过滤条件。
- MVP 阶段每个用户即一个 tenant，无需复杂 RBAC。

---

## 4. AI 工作流

### 4.1 同步回复生成（MVP）

```
POST /api/ai/reply
  → 读取 tenant 人设配置
  → 构建 Prompt（系统提示 + 评论内容）
  → 调用 DeepSeek-V3 API（response_format: json_object）
  → 解析返回的 3 条候选回复
  → 写入 ai_replies 表
  → 返回给插件
```

### 4.2 模型路由策略

| 任务 | 首选模型 | 降级 |
|---|---|---|
| 垃圾过滤 / 快速分类 | 关键词规则 | 无需 AI |
| 意图识别 | DeepSeek-V3 | keyword boost |
| 评论回复生成（中文） | DeepSeek-V3 | 历史高赞模板 |
| 评论回复生成（多语言） | GPT-4o | DeepSeek-V3 |
| 私信脚本生成 | GPT-4o long-form | 预置 SOP |

### 4.3 后台异步任务（Inngest）

Inngest 函数通过 HTTP Webhook 触发，Vercel 自动处理重试和超时：

```typescript
// 示例：批量意向评分
export const scoreIntentFn = inngest.createFunction(
  { id: 'score-intent', retries: 3 },
  { event: 'comment/ingested' },
  async ({ event, step }) => {
    const { tenantId, commentIds } = event.data
    // 批量调用 DeepSeek 意向识别
    // 写回 comments.intent_level
  }
)
```

当前 Inngest 函数：
- `comment/ingested`：新评论入库后触发意向评分（M1）
- `sla/check`：定时检查未处理的 hot 评论，发送提醒（M1）
- `report/weekly`：每周生成报表（M2）

### 4.4 成本控制

- 默认使用 DeepSeek-V3（约 $0.001/1k tokens，比 GPT-4o 便宜 10x）。
- `ai_call_logs` 表记录每次调用的 token 消耗和成本。
- 当 tenant 当日成本超过阈值时，自动切换到更便宜的模型并发送邮件告警。
- Prompt 缓存：相同评论内容 + 相同人设 → 直接返回缓存结果（Redis/Upstash，M1 引入）。

---

## 5. 数据层

### 5.1 Neon DB（Serverless PostgreSQL）

- 连接方式：`@neondatabase/serverless`（HTTP 模式，适合 Vercel Serverless Functions）。
- ORM：Drizzle ORM（类型安全，SQL-like 语法，AI 友好）。
- 连接池：Neon 内置连接池，无需 PgBouncer。

### 5.2 缓存策略（MVP 阶段）

- 人设配置：Next.js `unstable_cache` 缓存 5 分钟。
- Selector 配置：`chrome.storage.local` 缓存 1 小时。
- M1 引入 Upstash Redis 用于 AI 回复缓存和速率限制。

---

## 6. 安全与合规

| 方面 | 方案 |
|---|---|
| API 密钥管理 | Vercel 环境变量（加密存储），无需 Vault/KMS |
| 传输加密 | HTTPS/TLS（Vercel 自动处理） |
| 敏感数据 | 手机号等敏感字段加密存储（pgcrypto） |
| 审计日志 | `audit_logs` 表记录所有自动发送动作 |
| Cookie 合规 | Cookie 数据仅本地处理，Onboarding 时明确用户授权 |

---

## 7. 监控与可观测性

| 工具 | 用途 |
|---|---|
| Sentry | 插件和 Next.js 的错误追踪 |
| Vercel Analytics | API 延迟、请求量 |
| Inngest Dashboard | 后台任务执行日志、重试记录 |
| `ai_call_logs` 表 | AI 成本分析（自建简单查询） |

告警策略（M1 引入）：
- AI 失败率 > 30% → 邮件告警
- 单 tenant 日成本超阈值 → 邮件告警 + 自动降级模型

---

## 8. 技术演进路线

| 阶段 | 当前（MVP） | M1（产品化） | M2（规模化） |
|---|---|---|---|
| 后端 | Next.js Route Handlers | 同左 | 可拆分为独立 NestJS 服务 |
| 数据库 | Neon DB 单表 | 同左 + 索引优化 | 按需引入分区 |
| 任务队列 | Inngest | 同左 | 评估 NATS JetStream |
| 缓存 | Next.js cache | Upstash Redis | Redis Cluster |
| 部署 | Vercel | 同左 | 可迁移至 EKS/GKE |
| 实时推送 | 无（轮询） | Supabase Realtime | Socket.IO |

技术债管理：
1. MVP 阶段不引入分区表、物化视图、RLS，待数据量 > 500 万行时再评估。
2. RBAC 在 MVP 阶段简化为单一 `owner` 角色，M1 再扩展。
3. WebSocket 实时推送在 MVP 阶段用轮询替代，M1 引入 Supabase Realtime。
