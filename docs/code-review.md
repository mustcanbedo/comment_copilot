# Comment Copilot — Code Review

> 基于当前仓库的静态审查，侧重安全、健壮性、一致性与可维护性。

**注意**：本文档部分结论基于早期 Next.js 架构。当前后端已迁移至 **Go + Gin + GORM**，最新实现见 [architecture-as-built.md](architecture-as-built.md)。租户隔离（RequireTenantMatch）、积分扣费、存言 CRUD、SavedReply Delete 的 tenant 校验等已按审查建议实现。

---

## 1. 安全与鉴权

### 1.1 高：API `/api/ai/reply` 未校验 comment 归属

**位置**：`web/src/app/api/ai/reply/route.ts`

**问题**：仅根据 Header `x-tenant-id` 和 Body `commentId` 执行更新与写入，未校验该 `commentId` 是否属于当前 `tenantId`。若有人猜到或枚举到其他租户的 comment UUID，可为其生成回复并改写其 `comments.status`。

**建议**：在调用 DeepSeek 前先查库确认评论归属，例如：

```ts
const [comment] = await db.select({ id: comments.id }).from(comments)
  .where(and(eq(comments.id, commentId), eq(comments.tenantId, tenantId))).limit(1)
if (!comment) return NextResponse.json({ ok: false, error: 'comment not found' }, { status: 404 })
```

---

### 1.2 中：插件侧边栏硬编码 Tenant ID

**位置**：`apps/extension/sidepanel/index.tsx` 第 23 行

**问题**：`const TENANT_ID = "00000000-0000-0000-0000-000000000001"`，侧边栏请求未与 background 一致使用 `storage.get("tenantId")`，导致即使用户在插件选项里绑定了 Tenant ID，侧边栏仍用默认 ID，数据错位。

**建议**：侧边栏从 `@plasmohq/storage` 或 `chrome.storage` 读取 tenantId（与 background 同一 key），无则再用默认值；或由 background 统一代理带 tenantId 的请求。

---

### 1.3 中：CORS 使用 `*`

**位置**：各 API route 的 `CORS_HEADERS['Access-Control-Allow-Origin'] = '*'`

**问题**：生产环境允许任意来源，若未来有敏感操作或 Cookie，会放大风险。

**建议**：MVP 可保留；上线前改为允许的 origin 列表（如 `https://你的域名`、`chrome-extension://<id>`），或通过环境变量配置。

---

### 1.4 低：部分错误响应未带 CORS 头

**位置**：`web/src/app/api/ai/reply/route.ts` 中 400/500/502 的 `NextResponse.json` 部分未加 `headers: CORS_HEADERS`

**问题**：浏览器会因缺少 CORS 头而将响应视为“失败”，插件侧只能看到网络错误，不利于排查。

**建议**：所有 JSON 响应（含错误）统一加上 `CORS_HEADERS`。

---

## 2. 数据一致性与错误处理

### 2.1 中：注册接口无事务

**位置**：`web/src/app/api/auth/register/route.ts`

**问题**：先 `insert(tenants)` 再 `insert(users)`。若 tenant 插入成功而 user 插入失败（如唯一约束），会留下无对应用户的 tenant，且接口已返回 200。

**建议**：使用 Drizzle 事务（或 Neon 的 `sql.begin`）将创建 tenant + user 包在同一事务中，任一步失败则整体回滚。

---

### 2.2 中：Ingest 存在 N+1 与并发

**位置**：`web/src/app/api/ingest/comments/route.ts`

**问题**：对每条评论先 `select` 再 `insert`，大批量时请求多、耗时长；若并发 ingest 同一条评论，可能重复插入（依赖 DB unique 约束会 500）。

**建议**：  
- 批量：按 `(tenantId, platform, platformCommentId)` 一次 `select` 出已存在 ID 集合，再对“未存在”的项批量 `insert`。  
- 幂等：插入使用 `onConflictDoNothing` 或 catch unique 冲突并视为 skip，避免 500。

---

### 2.3 低：DeepSeek 返回 JSON 解析未防护

**位置**：`web/src/app/api/ai/reply/route.ts` 第 92–93 行

**问题**：`JSON.parse(data.choices[0].message.content)` 若格式异常或 `choices[0]` 缺失会抛错，直接进 catch 变成 500。

**建议**：先判断 `data.choices?.[0]?.message?.content`，再 try/catch `JSON.parse`，解析失败返回 502 与明确错误信息（如 `error: 'invalid AI response'`）。

---

## 3. 类型与边界

### 3.1 低：请求体未做 schema 校验

**位置**：各 `POST` 的 `await req.json()` 后直接解构使用

**问题**：恶意或错误客户端可传任意结构，导致运行时类型不符或插入异常数据。

**建议**：对关键接口用 zod/valibot 等做 body schema 校验，不通过则 400。

---

### 3.2 低：tenantId 未校验格式

**位置**：所有依赖 `x-tenant-id` 的 API

**问题**：未校验是否为合法 UUID，错误值会进 DB 查询或外键失败，错误信息不直观。

**建议**：在公共中间件或工具中校验 UUID 格式，非法则 400。

---

## 4. 插件与前端

### 4.1 中：Content Script 未使用服务端 Selector

**位置**：`apps/extension/contents/xiaohongshu.ts` 中 `SELECTORS` 为本地常量

**问题**：架构文档说明 selector 可从 `/api/selectors` 热更新，但 content script 未在启动或收到消息时拉取并替换 `SELECTORS`，平台改版时仍需发版插件。

**建议**：background 或 content 在启动时请求 `GET /api/selectors?platform=xiaohongshu`，将结果写入 storage 或发送给 content，content 使用动态 selector；保留当前对象为兜底默认值。

---

### 4.2 低：MutationObserver 回调过于频繁

**位置**：`apps/extension/contents/xiaohongshu.ts` 中 `observer` 监听 `document.body` 的 `childList` + `subtree: true`

**问题**：页面任意 DOM 变化都会触发 `scanAllComments()`，大页面可能造成不必要的 CPU 与消息发送。

**建议**：将 observer 限定在评论区容器（若 selector 稳定），或对 `scanAllComments` 做简单节流（如 300ms 内只执行一次）。

---

### 4.3 低：Sidepanel fetchComments 依赖未列入 useEffect

**位置**：`apps/extension/sidepanel/index.tsx` 中 `useEffect(() => { fetchComments() }, [filter])`

**问题**：`fetchComments` 在每次渲染都是新引用，若未来在 effect 中增加对 `fetchComments` 的依赖，可能触发无限循环；目前仅依赖 `filter` 无问题，但不够直观。

**建议**：使用 `useCallback(fetchComments, [filter])` 或将 `fetchComments` 定义在 effect 内，依赖列表更清晰。

---

## 5. 运维与可观测

### 5.1 低：敏感信息打日志

**位置**：`apps/extension/background.ts` 中 `console.log("[CommentCopilot] ingest:", data)`

**问题**：若后端返回体包含敏感字段，会进入插件 Console，被用户或截图泄露。

**建议**：只打 `saved/skipped` 等汇总信息，或通过环境变量控制是否打 debug 日志。

---

### 5.2 低：AUTH_SECRET 未校验

**位置**：`web/src/auth.ts` 使用 `process.env.AUTH_SECRET`

**问题**：若未配置，NextAuth 可能使用弱默认或报错不直观。

**建议**：在 `auth.ts` 或启动时校验 `AUTH_SECRET` 存在且长度足够，否则抛错或打 warning。

---

## 6. 小结与优先级

| 优先级 | 项 | 建议 |
|--------|----|------|
| 高 | 1.1 comment 归属校验 | 尽快在 `/api/ai/reply` 中加上 tenantId + commentId 归属校验 |
| 中 | 1.2 侧边栏 tenantId | 侧边栏从 storage 读 tenantId，与 background 一致 |
| 中 | 2.1 注册事务 | 注册接口用事务包裹 tenant + user 创建 |
| 中 | 2.2 Ingest 批量与幂等 | 批量查 + 批量插，冲突时忽略而非 500 |
| 中 | 4.1 Selector 热更新 | Content 使用从 API 拉取的 selector，带兜底 |
| 低 | 1.3 CORS / 1.4 错误 CORS / 2.3 JSON 解析 / 3.x 校验 / 4.2 节流 / 5.x | 按迭代排期处理 |

以上为本次 Code Review 结论；实现时可对照本清单逐项修改并补充测试（尤其是 1.1、2.1、2.2）。
