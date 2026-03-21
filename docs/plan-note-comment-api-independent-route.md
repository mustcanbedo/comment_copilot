# 实施方案：笔记跟评 AI（独立路由）

> **已定技术路线**：采用 **独立路由** `POST /api/ai/note-comment`，与 `POST /api/ai/reply` 并列；**不**扩展 `reply` 的 `mode`。  
> 目的：URL 与 handler 职责清晰，便于后期迭代（监控、限流、版本化、OpenAPI 拆分）。

**关联文档**：[architecture-review-note-comment-and-docs.md](architecture-review-note-comment-and-docs.md)（架构审阅）、[backend-changes-ai-note-comment.md](backend-changes-ai-note-comment.md)（速查）、[compare-ai-note-comment-api.md](compare-ai-note-comment-api.md)（定案记录）、[usage-flow.md](usage-flow.md) §2.3（产品交互）、[README.md](README.md)（文档中心）。

最后更新：2026-03-16

---

## 1. 目标与边界（MVP）

| 项 | 说明 |
|----|------|
| **产品** | 用户在**笔记详情页**生成「发在该笔记下的主跟评」文案；**非**回复某条已有评论。 |
| **交互** | 与现有一致：侧栏生成 → **一键填入网页主评输入框** → **用户手动发送**（不自动发帖）。 |
| **后端** | 新路由 + 新 handler；复用鉴权、租户、`DeductPoints`/`RefundPoints`、DeepSeek JSON 流程。 |
| **数据库** | MVP **不**新增表、不迁移。 |
| **不改动** | `POST /api/ai/reply` 行为保持不变（零回归要求）。 |

---

## 2. 总体架构

```
扩展 Sidepanel / CS
    → 消息 GET_AI_NOTE_COMMENT（payload：帖子上下文）
    → Background：Authorization + x-tenant-id
    → POST /api/ai/note-comment
    → AIHandler.NoteComment
    → { ok, suggestions }
    → 填入主评框（扩展实现，非本文交付范围）
```

与 `Reply` 共用：`RequireAuth`、`RequireTenantMatch`、`UserRepository` 积分逻辑、`deepseek_api_key` 与 mock 策略。

---

## 3. API 契约（定稿）

### 3.1 路由与方法

| 项 | 值 |
|----|-----|
| Method | `POST` |
| Path | `/api/ai/note-comment`（注册于 `tenantProtected` 组，与 `/api/ai/reply` 同级） |
| Headers | `Authorization: Bearer <JWT>`、`Content-Type: application/json`、**`x-tenant-id`**（必填，与现有一致） |

### 3.2 请求体 JSON

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `postUrl` | string | **建议** | 当前笔记 URL，日志与排障；若抓取失败可传空字符串但建议监控 |
| `postTitle` | string | 否 | 笔记标题 |
| `postContent` | string | 否 | 正文摘要（扩展可截断，如前 2000 字） |
| `persona` | string | 否 | 覆盖默认人设；空则与 `Reply` 一致使用默认字符串（后续可接 `tenants.persona`） |
| `style` | string | 否 | 如 `casual` / `professional` / `playful`，仅影响 user prompt 说明 |

**校验策略（建议）**：

- 至少提供 **一种** 有效上下文，避免空 prompt：`postTitle`、`postContent`、`postUrl` 三者**不能同时为空或全空白**（否则 `400`，`error` 信息明确）。
- 与 `Reply` 不同：**不要求** `commentId` / `commentContent`。

### 3.3 成功响应

```json
{
  "ok": true,
  "suggestions": ["跟评文案1", "跟评文案2", "跟评文案3"]
}
```

与 `Reply` 成功体一致，扩展可复用解析逻辑。

### 3.4 错误响应（与 `Reply` 对齐）

| HTTP | 场景 |
|------|------|
| 400 | 缺 `x-tenant-id`、JSON 绑定失败、业务校验失败（如上下文全空） |
| 401 | 未登录 / 无效 JWT |
| 402 | 积分不足，body 含 `insufficient_points` / `INSUFFICIENT_POINTS` 等与现网一致 |
| 502 | DeepSeek 网络/HTTP/解析/空 suggestions 等（**须**已执行积分回退，与 `Reply` 相同） |
| 500 | 非积分类的 repository 错误（与 `Reply` 行为一致即可） |

### 3.5 Mock 模式

当 `deepseek_api_key` 为空：**不扣费**，返回固定 3 条跟评风格 `suggestions`（文案与 `Reply` 的 mock 区分开，避免侧栏混淆场景）。

---

## 4. Prompt 设计要点（需产品/运营过稿）

| 维度 | `Reply`（现有） | `NoteComment`（新增） |
|------|-----------------|------------------------|
| 角色 | 品牌客服回复**评论** | 普通浏览者/运营号在笔记下写**主跟评** |
| 输入 | 评论正文 + 可选帖子 | 帖子标题/正文/URL + 可选 style |
| 约束 | 已有 7 条（含 `[表情]` 说明等） | **另写一套**：自然、不冒充笔记作者、不造谣、违规导流话术禁区；长度建议与现网类似（如短句 15–40 字量级，可多条） |
| 输出格式 | `{"suggestions":["…","…","…"]}` | **相同**（`response_format: json_object`） |

将最终 system/user 模板落在代码注释或本文附录（实施时贴到 PR 描述亦可）。

---

## 5. 后端实施清单（按顺序）

| 序号 | 任务 | 位置 / 说明 |
|------|------|-------------|
| B1 | 注册路由 | `backend/internal/server/router.go`：`tenantProtected.POST("/ai/note-comment", deps.AIHandler.NoteComment)` |
| B2 | 实现 `NoteComment` | `backend/internal/handler/ai_handler.go`（或新建 `ai_note_comment.go` 同 package，由 `AIHandler` 挂载方法） |
| B3 | 复制并改编流程 | 从 `Reply` 复制：user/tenant 校验 → mock 分支 → 扣费 → 组 payload → HTTP DeepSeek → 解析 → 失败 `RefundPoints` |
| B4 | 抽取公共逻辑（**强烈建议**，可与 B3 同步） | 将「扣费 → 请求 DeepSeek → decode choices → 解析 JSON suggestions → 退款」抽为 `(*AIHandler).runSuggestionsJob(...)` 或类似，`Reply` 与 `NoteComment` 仅传入不同 prompts 与 mock 文案 |
| B5 | 单元/集成测试 | 若有 handler 测试惯例则新增；至少手工用 curl/Thunder Client 覆盖 §7 用例 |
| B6 | 日志（可选 MVP+） | 记录 `userId`、`tenantId`、`postUrl` 摘要，**勿**记录完整正文若过长 |

**验收**：`go build ./...` 通过；新路由单独可测；`POST /api/ai/reply` 行为与改前一致。

---

## 6. 扩展端实施清单（概要）

> 详细 DOM 与消息名以实现时代码为准；此处为与后端契约对齐的检查项。

| 序号 | 任务 |
|------|------|
| E1 | Sidepanel 增加「笔记跟评」入口与 UI 状态（与回复评论区分） |
| E2 | Content script 抓取 `postTitle`、`postContent`、`postUrl`（与现有帖子上下文抓取方式对齐） |
| E3 | 新增 background 消息类型（例如 `GET_AI_NOTE_COMMENT`），请求 `POST {API_BASE}/api/ai/note-comment`，headers 与 `reply` 一致 |
| E4 | 将返回的 `suggestions` 展示并支持一键填入**主评输入框**（选择器可能与评论区不同，需单独配置或 `selectors` 扩展） |
| E5 | 错误处理：402 引导充值、502 提示重试，与现有 AI 回复一致 |

后端 **MVP 可先上线**，扩展可跟版发布；联调时使用 mock 或真实 key。

---

## 7. 测试用例（必过）

| # | 用例 | 预期 |
|---|------|------|
| T1 | 无 `Authorization` | 401 |
| T2 | 缺 `x-tenant-id` | 400 |
| T3 | body 合法、积分不足 | 402，结构与 `Reply` 一致 |
| T4 | body 合法、积分足够、key 有效 | 200，`suggestions` 长度 ≥ 1 |
| T5 | DeepSeek 返回非 2xx 或解析失败 | 502 + 积分已回退 |
| T6 | `deepseek_api_key` 为空 | 200，mock `suggestions`，**未扣费** |
| T7 | `postTitle`/`postContent`/`postUrl` 全空 | 400（若采用 §3.2 校验策略） |
| T8 | 回归 `POST /api/ai/reply` | 与改前一致 |

---

## 8. 文档与沟通（发布前）

| 文档 | 动作 |
|------|------|
| [architecture-as-built.md](architecture-as-built.md) | 增加 `POST /api/ai/note-comment` 一行及简要契约 |
| [backend-changes-ai-note-comment.md](backend-changes-ai-note-comment.md) | 已实现为速查页；实施后更新 as-built 即可 |
| [compare-ai-note-comment-api.md](compare-ai-note-comment-api.md) | 文首保留「已定案：方案 A」 |
| [prd_comment_copilot.md](prd_comment_copilot.md) | （可选）补充跟评场景一句 |
| OpenAPI / 若对外 SDK | 仅增加新 path，不修改 `reply` schema |

---

## 9. 后续迭代（非 MVP）

- 从 `tenants.persona` 读默认人设（与 `PersonaHandler` 对齐）。
- 调用日志表 `task_type = note_comment` 用于计费/审计。
- 限流：按用户或租户对 `/ai/note-comment` 单独配额。
- API 版本：`/api/v2/ai/note-comment`（若未来 body 大改）。

---

## 10. 小结

| 交付物 | 说明 |
|--------|------|
| 路由 | `POST /api/ai/note-comment` |
| 代码 | `NoteComment` + 可选公共抽取；**不改** `Reply` 语义 |
| 数据 | 无迁移 |
| 扩展 | 新消息 + 新填框逻辑（另排期） |
| 风险 | 低（与 `Reply` 路径隔离）；主要风险在 prompt 质量与前端选择器 |

本文件为 **独立路由路线** 的执行单；实施时以代码与 PR 为准，若契约变更请同步更新 §3 与 architecture-as-built。
