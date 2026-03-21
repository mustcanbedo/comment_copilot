# 言灵 / Comment Copilot — 文档中心

> 阅读入口：按角色选路径，避免在多篇重复文档间迷路。  
> 最后整理：2026-03-16

---

## 架构师审阅摘要（当前结论）

1. **笔记跟评采用独立路由 `POST /api/ai/note-comment`**：与现有 `reply` 解耦，监控/限流/版本化清晰，长期维护成本低于单 handler 多 `mode`。**建议实施期抽取**与 `Reply` 共用的「扣费 → DeepSeek → 解析 JSON → 失败退款」逻辑，避免双份分叉。
2. **文档与代码曾对不齐**：`architecture-as-built.md` 中 AI 回复数据流曾描述「写 ai_replies / 改 comments」——与当前 `ai_handler.Reply` 实现不符（实际为**仅生成 suggestions + 扣费**；状态同步见 `todo_v1_reply_status_sync.md`）。**已在 as-built 中修正**。
3. **路线图 `roadmap_comment_copilot.md`** 仍含早期 Next.js 栈叙述，与现仓库 **Go + Plasmo** 不一致；已加页首说明，详细以 **as-built** 为准。

完整审阅与风险项：[architecture-review-note-comment-and-docs.md](architecture-review-note-comment-and-docs.md)

---

## 按角色阅读

| 角色 | 建议顺序 |
|------|----------|
| **新同学 / 接后端** | [architecture-as-built.md](architecture-as-built.md) → [comment_copilot_database_schema.md](comment_copilot_database_schema.md) → [usage-flow.md](usage-flow.md) |
| **做笔记跟评功能** | [plan-note-comment-api-independent-route.md](plan-note-comment-api-independent-route.md)（执行单）→ 实现后改 as-built |
| **产品 / 需求** | [prd_comment_copilot.md](prd_comment_copilot.md) → [usage-flow.md](usage-flow.md) |
| **插件打包 / 上架** | [extension-packaging.md](extension-packaging.md) |

---

## 文档地图（按类型）

### 现状与契约（Source of truth）

| 文档 | 用途 |
|------|------|
| [architecture-as-built.md](architecture-as-built.md) | **已实现**后端目录、API 表、数据流（与代码同步维护） |
| [comment_copilot_database_schema.md](comment_copilot_database_schema.md) | 表结构、字段说明 |
| [usage-flow.md](usage-flow.md) | 用户动线、租户头、积分、合规边界 |

### 规划与演进

| 文档 | 用途 |
|------|------|
| [roadmap_comment_copilot.md](roadmap_comment_copilot.md) | 阶段目标（**栈以 as-built 为准**） |
| [architecture_comment_copilot.md](architecture_comment_copilot.md) | 架构设想与演进（含历史规划） |

### 功能：笔记跟评 AI（已定案：独立路由）

| 文档 | 用途 |
|------|------|
| [plan-note-comment-api-independent-route.md](plan-note-comment-api-independent-route.md) | **主执行单**：契约、任务、测试、发布检查 |
| [compare-ai-note-comment-api.md](compare-ai-note-comment-api.md) | 方案 A/B 对比与**定案记录** |
| [backend-changes-ai-note-comment.md](backend-changes-ai-note-comment.md) | 变更说明**速查**（详单以 plan 为准） |

### 过程稿 / 专项 TODO（非入门必读）

| 文档 | 说明 |
|------|------|
| [code-review.md](code-review.md) | 某次代码审查结论 |
| [refactor-auth-and-ui.md](refactor-auth-and-ui.md) | 侧栏登录重构步骤；**部分与当前实现可能不一致**，以代码与 as-built 为准 |
| [todo_v1_reply_status_sync.md](todo_v1_reply_status_sync.md) | 评论「已回复」状态与后端同步的后续工作 |

---

## 与仓库根目录 README 的关系

- 根目录 [../README.md](../README.md)：项目简介、本地开发命令、**精简文档链接**。
- **本文档中心**：完整索引、类型划分、架构审阅入口。
