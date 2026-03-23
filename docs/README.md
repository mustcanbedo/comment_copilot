# 言灵 / Comment Copilot — 文档中心

> 按角色选路径；**实现契约**以 [architecture-as-built.md](architecture-as-built.md) 为准。  
> 最后整理：2026-03-11

---

## 架构师审阅摘要（当前结论）

1. **笔记跟评**：独立路由 `POST /api/ai/note-comment`，与 `POST /api/ai/reply` 并列；共用扣费与 DeepSeek 逻辑宜内聚抽取。
2. **文档与代码**：历史版 **Next.js / `web/`** 叙述已清理；路线图改为精简版，详技以 **as-built** 为准。
3. **AI 回复**：`Reply` handler 仅返回 suggestions + 扣费，**不写** `ai_replies`、**不**改 `comments.status`；已回复同步见 [todo_v1_reply_status_sync.md](todo_v1_reply_status_sync.md)。

完整审阅：[architecture-review-note-comment-and-docs.md](architecture-review-note-comment-and-docs.md)

---

## 按角色阅读

| 角色 | 建议顺序 |
|------|----------|
| **新同学 / 接后端** | [architecture-as-built.md](architecture-as-built.md) → [comment_copilot_database_schema.md](comment_copilot_database_schema.md) → [usage-flow.md](usage-flow.md) |
| **笔记跟评功能** | [plan-note-comment-api-independent-route.md](plan-note-comment-api-independent-route.md) → 落地后改 as-built |
| **产品 / 需求** | [prd_comment_copilot.md](prd_comment_copilot.md) → [usage-flow.md](usage-flow.md) |
| **插件打包 / 上架** | [extension-packaging.md](extension-packaging.md) |

---

## 文档地图

### 现状与契约（优先维护）

| 文档 | 用途 |
|------|------|
| [architecture-as-built.md](architecture-as-built.md) | **已实现**后端 API、目录、数据流 |
| [comment_copilot_database_schema.md](comment_copilot_database_schema.md) | 表结构、字段说明 |
| [usage-flow.md](usage-flow.md) | 用户动线、租户头、积分、合规 |

### 规划与产品

| 文档 | 用途 |
|------|------|
| [roadmap_comment_copilot.md](roadmap_comment_copilot.md) | 阶段目标（精简；栈以 as-built 为准） |
| [prd_comment_copilot.md](prd_comment_copilot.md) | 产品愿景、Persona、功能范围 |

### 笔记跟评 AI（已定案：独立路由）

| 文档 | 用途 |
|------|------|
| [plan-note-comment-api-independent-route.md](plan-note-comment-api-independent-route.md) | **执行单**：契约、任务、测试 |
| [compare-ai-note-comment-api.md](compare-ai-note-comment-api.md) | 方案对比与定案记录 |
| [backend-changes-ai-note-comment.md](backend-changes-ai-note-comment.md) | 变更速查（详单以 plan 为准） |

### 专项 TODO

| 文档 | 用途 |
|------|------|
| [todo_v1_reply_status_sync.md](todo_v1_reply_status_sync.md) | 评论「已回复」与后端同步的后续工作 |

---

## 与仓库根目录 README 的关系

- 根目录 [../README.md](../README.md)：简介、本地命令、多平台扩展说明、文档入口。
- **本文档中心**：索引与架构审阅入口。
