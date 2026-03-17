# Comment Copilot - 技术架构文档

> 目标：以最小的基础设施负担，快速验证「评论采集 → AI 回复建议 → 潜客转化」核心价值链路。优先选择托管服务，消除运维负担。

最后更新：2026-03-13（v2.0 Serverless 版）  
文档目前以 **Next.js Serverless 架构** 为主，插件 + Go 后端的最新实现见下方「附录 A」。

- **已实现架构**（Next.js 版本的接口、目录、数据流）：见 [architecture-as-built.md](architecture-as-built.md)。
- **使用逻辑**（插件为主、Web 为数据分析、身份打通）：见 [usage-flow.md](usage-flow.md)。

---

## 1. 系统总览

### 1.1 整体架构（当前实现 + 规划）

**当前已实现**：Chrome 插件 + Next.js（Vercel）+ Neon DB；无独立后端服务、无 Redis、无 Inngest。

```
┌─────────────────────────────────────────────────────────┐
│                   Chrome Extension (Plasmo)              │
│  content script (MutationObserver DOM 解析)              │
│  background script (消息路由 + API 调用 + 速率限制)       │
│  sidepanel (评论列表 + AI 回复建议 + 填入输入框 + 滚动联动) │
└────────────────────┬────────────────────────────────────┘
                     │ HTTPS
┌────────────────────▼────────────────────────────────────┐
│              Next.js App (Vercel 部署) — web/             │
│  app/api/ingest/comments  → 评论入库                      │
│  app/api/ai/reply         → DeepSeek-V3 生成回复          │
│  app/api/comments         → 评论列表查询                  │
│  app/api/selectors        → DOM 选择器热更新              │
│  app/api/auth/*           → NextAuth 登录/注册            │
│  app/api/settings/persona → 人设读写                     │
│  app/(dashboard|settings) → Web 控制台 / 设置（数据分析）   │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌───────────────┐
│  Neon DB      │     （规划中：Inngest 后台任务、Upstash Redis 缓存）
│  Serverless   │
│  PostgreSQL   │
│  Drizzle ORM  │
└───────────────┘
```

关键决策：
- **单体 Next.js 应用**：API + Web 控制台均在 `web/`，无独立后端服务。
- **Vercel 部署**：自动 SSL、CDN、环境变量，零运维。
- **Neon DB**：Serverless PostgreSQL，Drizzle ORM。
- **Inngest / Redis**：规划中（意向评分、SLA 提醒、回复缓存等），当前未接入。

### 1.2 环境

| 环境 | 说明 | 部署方式 |
|---|---|---|
| `local` | 本地开发，`web`: `next dev`；插件: `apps/extension` 下 `npm run dev` | 本地运行 |
| `preview` | PR 预览 | Vercel Preview Deployment |
| `production` | 正式环境 | Vercel Production |

### 1.3 产品使用定位

- **博主日常**：以 **Chrome 插件** 为主——在小红书笔记页用侧边栏看评论、生成 AI 回复、一键填入输入框并手动发送。
- **Web 后台**：用于注册/登录、设置人设、**阶段性数据分析**（Dashboard 查看评论与统计），非主操作界面。
- 详细动线与 Web/插件身份关系见 [usage-flow.md](usage-flow.md)。

---

## 2. Chrome 插件架构

### 2.1 三层职责

| 层 | 文件 | 职责 |
|---|---|---|
| Content Script | `contents/xiaohongshu.ts` | DOM 解析、MutationObserver、URL 变化监听、数据提取、点击回复填入输入框 |
| Background Script | `background.ts` | 消息路由、API 调用、速率限制、断路器、转发 FILL_REPLY / SCROLL_TO_COMMENT |
| Side Panel | `sidepanel/index.tsx` | 评论列表、AI 回复建议、点击回复填入小红书输入框、与页面滚动联动 |

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

### 3.1 核心接口（已实现）

| 接口 | 方法 | 说明 |
|---|---|---|
| `/api/ingest/comments` | POST | 接收插件上报的评论批次，去重写入 DB |
| `/api/ai/reply` | POST | 按 tenant 人设调用 DeepSeek-V3，返回 3 条建议，写 ai_replies / ai_call_logs |
| `/api/comments` | GET | 按 tenant 查询评论列表（可扩展按 postUrl 过滤当前帖子） |
| `/api/selectors` | GET | 返回指定平台的 DOM selector 配置（DB 或默认） |
| `/api/auth/[...nextauth]` | GET/POST | NextAuth 登录/会话 |
| `/api/auth/register` | POST | 用户注册（创建 tenant + user） |
| `/api/settings/persona` | GET/POST | 人设读取/保存（需 Session） |
| `/api/health` | GET | 健康检查 |
| `/api/inngest` | POST | **规划中**：Inngest 函数入口 |

### 3.2 认证（当前）

- **Web**：NextAuth.js（邮箱 + 密码），Session 中带 `tenantId`；Dashboard / 设置需登录。
- **插件**：请求头 `x-tenant-id`，从插件 storage 或默认值读取；与 Web 登录态不互通，需用户在 Web 获取 Tenant ID 后到插件内绑定。详见 [usage-flow.md](usage-flow.md)。
- **规划**：M1 插件与 Web 身份打通（如插件内登录跳转 Web、或 API Key 绑定）。

### 3.3 多租户

- 所有业务数据按 `tenant_id` 隔离。
- 当前：每用户一 tenant；Web 端 Session 对应 tenant，插件端依赖绑定的 Tenant ID。

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

### 4.3 后台异步任务（规划中：Inngest）

当前未接入 Inngest。规划中通过 HTTP Webhook 触发，例如：

```typescript
// 示例：批量意向评分（M1）
export const scoreIntentFn = inngest.createFunction(
  { id: 'score-intent', retries: 3 },
  { event: 'comment/ingested' },
  async ({ event, step }) => {
    const { tenantId, commentIds } = event.data
    // 批量调用 DeepSeek 意向识别，写回 comments.intent_level
  }
)
```

规划中的 Inngest 函数：
- `comment/ingested`：新评论入库后触发意向评分（M1）
- `sla/check`：定时检查未处理的 hot 评论，发送提醒（M1）
- `report/weekly`：每周生成报表（M2）

### 4.4 成本控制

- **已实现**：默认 DeepSeek-V3；`ai_call_logs` 表记录每次调用的 token 与成本。
- **规划**：tenant 日成本超阈值时降级模型 + 邮件告警；Prompt 缓存（Redis/Upstash，M1）。

---

## 5. 数据层

### 5.1 Neon DB（Serverless PostgreSQL）

- 连接方式：`@neondatabase/serverless`（HTTP 模式，适合 Vercel Serverless Functions）。
- ORM：Drizzle ORM（类型安全，SQL-like 语法，AI 友好）。
- 连接池：Neon 内置连接池，无需 PgBouncer。

### 5.2 缓存策略

- **当前**：Selector 配置可由插件侧缓存（如 1 小时）；人设每次请求从 DB 读取。
- **规划**：人设 `unstable_cache` 或短期缓存；M1 引入 Upstash Redis 用于 AI 回复缓存与速率限制。

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
| 后端 | Next.js Route Handlers（`web/`） | 同左 | 可拆分为独立服务 |
| 数据库 | Neon DB + Drizzle | 同左 + 索引优化 | 按需引入分区 |
| 任务队列 | 无 | Inngest | 评估 NATS JetStream |
| 缓存 | 无 / 插件本地 | Upstash Redis | Redis Cluster |
| 部署 | Vercel | 同左 | 可迁移至 EKS/GKE |
| 身份 | Web NextAuth；插件 x-tenant-id（未打通） | 插件与 Web 打通 | API Key / 多端统一 |
| 实时推送 | 无（轮询） | Supabase Realtime | Socket.IO |

技术债管理：
1. MVP 阶段不引入分区表、物化视图、RLS，待数据量 > 500 万行时再评估。
2. RBAC 在 MVP 阶段简化为单一 `owner` 角色，M1 再扩展。
3. WebSocket 实时推送在 MVP 阶段用轮询替代，M1 引入 Supabase Realtime。

---

## 附录 A：当前插件 + Go 后端实现差异（2026-03）

> 这一节用于同步当前仓库内实际实现（Go 后端 + 插件本地存储），与上文 Next.js Serverless 架构存在一定差异。

### A.1 后端形态

- **当前实际后端**：Go + Gin + GORM + PostgreSQL
  - 入口：`backend/cmd/server`
  - 路由：`backend/internal/server/router.go`
  - 认证中间件：`backend/internal/middleware/auth.go` 中的 `RequireAuth`
  - 业务 Handler：`backend/internal/handler/*`
- **认证方式**：
  - `/api/auth/login`：邮箱 + 密码登录，返回 JWT token，并同时写入 `cc_token` Cookie。
  - 受保护接口（`/api/comments`、`/api/ingest/comments`、`/api/ai/reply` 等）统一挂载 `RequireAuth`，要求：
    - `Authorization: Bearer <token>`，或
    - `Cookie: cc_token=<token>`。
  - `/api/auth/me`：基于 JWT 中的 `userId` 返回用户信息（`id/email/name`）。

### A.2 插件 Side Panel 结构（当前实现）

主入口：`apps/extension/sidepanel/index.tsx`，结构上已拆为一个状态容器 + 4 个页面组件：

- `SidePanel`：容器组件
  - 管理登录态、用户信息、评论列表、AI 状态、存言列表等。
  - 通过 `activeNav: "account" | "zhiyan" | "cunyan" | "settings"` 控制当前页面。
- `ZhiyanPage`（智言）：
  - 评论列表虚拟滚动（按当前小红书页面 DOM + 后端 `/comments?postUrl=` 合并）。
  - 每条评论支持生成 AI 回复（调用 `/api/ai/reply`），展示多条建议。
  - 每条 AI 建议支持：
    - 「回复」：自动填入小红书输入框；
    - 「收藏」：保存为存言（见 A.3）。
- `CunyanPage`（存言）：
  - 展示本地收藏的 AI 回复列表。
  - 支持按「分类」筛选（目前默认分类为「默认」）和关键字搜索。
- `AccountPage`（我的账户）：
  - 展示当前登录用户信息（头像首字母 / 邮箱 / 昵称）。
  - 提供「退出登录」按钮（清除插件内 `authToken`，回到登录页）。
- `SettingsPage`（设置）：
  - 目前为占位，展示通用设置卡片和即将上线提示。

### A.3 存言（收藏回复）实现

- 数据模型（前端）：

```ts
interface SavedReply {
  id: string
  text: string
  fromComment: string       // 评论内容前 80 字
  createdAt: string         // ISO 时间
  category: string          // 目前固定为 "默认"
}
```

- 持久化方式：
  - 使用 `@plasmohq/storage` 本地存储，不走后端。
  - key 为 `savedReplies:v1:<userId>`，通过 `getSavedRepliesKey(userId)` 生成：

```ts
const SAVED_REPLIES_KEY_PREFIX = "savedReplies:v1"
const getSavedRepliesKey = (userId: string | null | undefined) =>
  `${SAVED_REPLIES_KEY_PREFIX}:${userId || "anonymous"}`
```

- 多账号隔离：
  - 登录成功后通过 `/api/auth/me` 获取 `user.id`，`SidePanel` 中根据 `userProfile.id`：
    - 初始化时从对应 key 读取该用户的存言。
    - 收藏 / 取消收藏时写回该 key。

> 未来如果要与数据库同步存言，可在 Go 后端补充：
> - `GET /api/saved-replies`
> - `POST /api/saved-replies`
> - `DELETE /api/saved-replies/:id`
> 并保持与当前 `SavedReply` 结构兼容。
