# 「笔记跟评」后端 API：两种方案对比

> **已定案（2026-03-16）**：采用 **方案 A（独立路由）**。执行单见 **[plan-note-comment-api-independent-route.md](plan-note-comment-api-independent-route.md)**。

> **场景**：在**任意笔记**下生成用户自己要发的**主跟评**（非回复某条已有评论）。  
> **产品交互**：与现有「AI 回复评论」一致——侧栏生成 → 一键填入输入框 → **用户手动发送**（见 [usage-flow.md](usage-flow.md) §2.3）。

两种后端落地方式（**保留作决策记录**）：

| 代号 | 名称 | 要点 |
|------|------|------|
| **方案 A** | **独立路由** | 新增 `POST /api/ai/note-comment`，专用 handler |
| **方案 B** | **扩展 `reply`** | 在现有 `POST /api/ai/reply` 上增加 `mode`（或等价字段）分支 |

**执行单**见 [plan-note-comment-api-independent-route.md](plan-note-comment-api-independent-route.md)；**速查**见 [backend-changes-ai-note-comment.md](backend-changes-ai-note-comment.md)。架构审阅见 [architecture-review-note-comment-and-docs.md](architecture-review-note-comment-and-docs.md)。

最后更新：2026-03-16

---

## 1. 背景与约束

- **复用能力**（两种方案都应复用）：JWT、`x-tenant-id`、积分预扣/失败退款、DeepSeek、JSON `suggestions`、402/502 等与现 `Reply` 一致。
- **兼容性**：若选方案 B，**未传新模式字段**的旧扩展须与当前生产行为 **100% 一致**。
- **MVP**：两种方案均可 **不建新表**；跟评与回复的 prompt 语义不同，需单独设计文案。

---

## 2. 方案概述

### 2.1 方案 A：独立路由 `POST /api/ai/note-comment`

- **路由**：在 `tenantProtected` 组内新增一行，与 `POST /api/ai/reply` 并列。
- **Handler**：如 `NoteComment(c *gin.Context)`，请求体仅包含跟评所需字段（帖子 URL/标题/正文摘要、persona、style 等）。
- **扩展**：Background 对跟评调用**新 URL**；回复评论仍走 `/api/ai/reply`。

### 2.2 方案 B：扩展 `POST /api/ai/reply`

- **请求体**：增加可选字段，例如 `mode: "reply" | "note_comment"`，默认 `"reply"`。
- **校验**：`mode === "reply"` 时保持 `commentId`、`commentContent` 等**现有必填**；`mode === "note_comment"` 时**不要求**评论相关字段，改为校验帖子上下文字段。
- **逻辑**：同一 `Reply` handler 内分支：扣费与 LLM 调用共用，**仅 system/user prompt 与入参拼装不同**。
- **扩展**：跟评与回复**同一 URL**，body 多带 `mode`（及跟评字段）。

---

## 3. 多维度对比

| 维度 | 方案 A 独立路由 | 方案 B 扩展 `reply` |
|------|-----------------|---------------------|
| **API 语义** | URL 即意图，OpenAPI/网关日志一眼可读 | 单一路径承载两种业务，依赖文档与 `mode` |
| **契约与校验** | 独立 struct，字段必填规则清晰 | 需在代码与文档中维护「模式 × 字段」矩阵，易漏测 |
| **Handler 复杂度** | 新方法，职责单一；可与 `Reply` 抽公共 `completeChatJSON` | `Reply` 函数变长，需规范分支结构避免成「上帝方法」 |
| **路由与注册** | 多一行 `router`、多一个集成测试入口 | 不改路由表，改动面更集中 |
| **扩展 / 客户端** | 两个 endpoint，类型定义可分开 | 一个 client 方法 + 联合类型或可选字段，需注意不要误传评论字段 |
| **监控与限流** | 可按 path 直接区分 `reply` vs `note_comment` | 需依赖 `mode` 打标签或从 body 解析，否则指标混在一起 |
| **版本演进** | 跟评字段大改时可单独做 v2 path | 同一 body 继续膨胀，兼容性压力略大 |
| **重复代码** | 若不抽取公共逻辑，易与 `Reply` 重复 | 天然共用扣费与调用链，重复最少 |
| **认知成本（新人）** | 「跟评找 note-comment」直观 | 「跟评也是 reply」需要读文档才能理解 |

---

## 4. 契约示例（便于评审）

### 4.1 方案 A — 跟评专用 body（示意）

```json
{
  "postUrl": "https://...",
  "postTitle": "标题",
  "postContent": "正文摘要…",
  "persona": "",
  "style": "casual"
}
```

### 4.2 方案 B — 跟评时同一 `reply` URL（示意）

```json
{
  "mode": "note_comment",
  "postUrl": "https://...",
  "postTitle": "标题",
  "postContent": "正文摘要…",
  "persona": "",
  "style": "casual"
}
```

回复评论时：`mode` 省略或 `"reply"`，并带现有 `commentId`、`commentContent` 等。

**响应**：两种方案成功时均可与现网一致：`{ "ok": true, "suggestions": ["…", "…", "…"] }`。

---

## 5. 工作量与维护（定性）

| 项 | 方案 A | 方案 B |
|----|--------|--------|
| 首次开发 | 新 handler + 注册 + 文档；可与 `Reply` 复制后改 prompt | 改 binding/校验 + 分支 + prompt；无新路由 |
| 长期维护 | 两处逻辑，**强烈建议**抽公共「扣费 + 调模型 + 解析 + 退款」 | 单文件集中，但分支测试用例要覆盖两种 mode |
| 文档 | 路由表多一行即可说明白 | 必须维护「模式与字段」对照表，避免前后端理解偏差 |

---

## 6. 风险与缓解

| 风险 | 方案 A | 方案 B |
|------|--------|--------|
| 旧客户端误调新接口 | 新 URL，老包根本打不到 | 不涉及 |
| 新客户端传错 `mode` 或漏字段 | 不涉及 | 集成测试覆盖 `reply` / `note_comment` 全矩阵；400 错误信息区分场景 |
| `Reply` 回归 | 新代码路径独立，**不触碰**原 `Reply` | 每次改 `Reply` 须跑全量回复场景回归 |
| Prompt 混用 | 低（物理隔离） | 中（需代码审查确保分支不串 prompt） |

---

## 7. 决策建议（非强制）

- 更重视 **REST 语义清晰、监控按 path 拆分、尽量少动已稳定 `Reply`** → 倾向 **方案 A**。
- 更重视 **少一个 URL、少一处注册、最大化共用调用链** → 倾向 **方案 B**。

团队规模小、快速迭代且愿意写好分支测试时，**方案 B** 很划算；对外暴露 API、或多团队消费契约时，**方案 A** 通常更省心。

---

## 8. 选定后需同步的文档与代码

| 动作 | 说明 |
|------|------|
| [backend-changes-ai-note-comment.md](backend-changes-ai-note-comment.md) | 以选定方案为主路径改写「推荐变更」小节（另一方案保留为附录或简表即可） |
| [architecture-as-built.md](architecture-as-built.md) | 更新 API 表：新增路由 **或** 注明 `reply` 的 `mode` 扩展 |
| 扩展 Background | 方案 A：`POST .../note-comment`；方案 B：`POST .../reply` + `mode` |

---

## 9. 相关链接

- 实现细节与测试清单：[backend-changes-ai-note-comment.md](backend-changes-ai-note-comment.md)
- 使用与边界：[usage-flow.md](usage-flow.md)
