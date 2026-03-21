# 架构审阅：笔记跟评 API + 项目文档健康度

> 角色：架构视角结论与可执行建议。  
> 日期：2026-03-16

---

## 1. 笔记跟评：独立路由方案

### 1.1 结论

**认可**采用 `POST /api/ai/note-comment`，与 `POST /api/ai/reply` 并列。

| 维度 | 评价 |
|------|------|
| **边界清晰** | URL 表达业务语义，网关日志、按路径限流、未来 v2 拆 path 都更简单。 |
| **回归风险** | 不修改 `Reply` 绑定与行为，旧扩展路径稳定。 |
| **与领域模型一致** | 「回复一条评论」与「对笔记发主评」是不同用例，分接口符合 REST 与团队认知。 |
| **代价** | 必然重复一段「HTTP + DeepSeek + JSON 解析 + 积分」样板代码，**必须用内部私有方法抽取**（见 §1.3），否则双处改易出事故。 |

### 1.2 风险与缓解

| 风险 | 缓解 |
|------|------|
| Prompt 与合规 | 跟评场景禁止冒充作者、违规导流等，需产品审 system/user 模板；与 `Reply` 的「客服回复」严格区分。 |
| 主评输入框选择器 | 与评论区输入框 DOM 不同，扩展需独立 selector 或配置；失败时要有明确 UI 提示（非后端范畴但影响成功率）。 |
| 空上下文 | Plan 中「标题/正文/URL 不可全空」合理，避免浪费积分与模型胡编。 |
| 监控 | 上线后对 `note-comment` 单独看 402/502 率与耗时，便于与 `reply` 对比。 |

### 1.3 实现建议（非阻塞文档，供开发对照）

1. 在 `AIHandler` 内抽取 `runDeepSeekSuggestions(ctx, userID, systemPrompt, userPrompt) ([]string, error)`（命名随意），内聚：扣费、`http.Client`、解析、`RefundPoints`。
2. `Reply` 与 `NoteComment` 只组装 prompt 并调用上述方法；mock 分支可共用或各保留一句文案。
3. MVP **不写库**与当前 `Reply` 一致；审计需求走后续 `ai_call_logs` 类设计（见 plan）。

---

## 2. 文档体系审阅

### 2.1 已发现问题（已修复或在索引中标注）

| 问题 | 处理 |
|------|------|
| `architecture-as-built.md` §4.2 描述 AI 回复会写库、更新 `comments.status` | 与 `ai_handler.go` **不符**；已改为与实际一致，并指向 `mark-replied` / TODO 文档 |
| 同文件 `/api/auth/me` 响应形状过时 | 已与当前 `AuthHandler.Me` 对齐 |
| 同文件 `/api/health` 鉴权描述错误 | 路由在 `protected` 下，**需 JWT**；已更正 |
| `roadmap_comment_copilot.md` 仍以 Next.js 为主叙事 | 与现栈脱节；已加页首「现状以 Go 为准」 |
| 笔记跟评相关三篇文档内容重叠 | **分工**：plan = 执行单；compare = 定案+对比；backend-changes = 速查（已瘦身） |
| `refactor-auth-and-ui.md` 可能误导新同学 | 在文档中心标为**过程稿**，以代码与 as-built 为准 |

### 2.2 推荐维护规则

1. **契约与数据流**：以 `architecture-as-built.md` 为唯一权威；改路由或 handler 行为时**同一 PR 更新该文件**。
2. **新功能**：先写/改 `plan-*.md` 或 ADR，落地后把「已实现」并入 as-built，plan 可保留或归档。
3. **路线图**：大改栈或阶段时更新 roadmap 的「技术栈」段落，避免与 as-built 矛盾。

---

## 3. 后续可选工作（未在本次全部改代码）

- 将 `GET /api/health` 挪到无需 JWT 的公开组（若运维强依赖无鉴权探活），属**产品/运维决策**，需单独 PR。
- `PersonaHandler` 与 `AIHandler` 默认 persona 字符串统一从 DB 读取（plan 已列为迭代项）。

---

## 相关链接

- [plan-note-comment-api-independent-route.md](plan-note-comment-api-independent-route.md)
- [architecture-as-built.md](architecture-as-built.md)
- [docs/README.md](README.md)
