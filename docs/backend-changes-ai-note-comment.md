# 后端技术变更说明 —「笔记跟评」AI（速查）

> 用户浏览**任意小红书笔记**时，生成**发在该笔记下的主跟评文案**（非回复某条评论）。  
> 交互与「回复评论」一致：**侧栏生成 → 一键填入输入框 → 用户手动发送**（[usage-flow.md](usage-flow.md) §2.3）。

**已定案**：独立路由 **`POST /api/ai/note-comment`**。  
**主文档（契约、任务顺序、测试表）** → [plan-note-comment-api-independent-route.md](plan-note-comment-api-independent-route.md)  
**方案对比与定案记录** → [compare-ai-note-comment-api.md](compare-ai-note-comment-api.md)

最后更新：2026-03-16

---

## 1. 文档范围

| 内容 | 是否包含 |
|------|----------|
| 路由、Handler、Prompt 要点 | ✅ 下文摘要 |
| 执行顺序、校验细节、Mock 文案区分 | ➜ **plan** |
| 数据库迁移 / 新表 | ❌ MVP 不要求 |
| 扩展填主评框 | ❌ 前端；plan 中有契约摘要 |
| 改动 `POST /api/ai/reply` | ❌ **不改** |

---

## 2. 复用能力（与 `Reply` 相同）

| 能力 | 实现位置 |
|------|----------|
| JWT、`x-tenant-id`、`RequireTenantMatch` | `middleware/` |
| `DeductPoints` / `RefundPoints` | `repository/user_repository.go` |
| 单次扣费 | `ai_handler.go` `pointsPerCall` |
| DeepSeek + JSON `suggestions` | 建议与 `Reply` **抽取共用**私有方法 |

---

## 3. 变更摘要（MVP）

| 项 | 内容 |
|----|------|
| 路由 | `tenantProtected.POST("/ai/note-comment", …)` → `POST /api/ai/note-comment` |
| Handler | `AIHandler.NoteComment`（可与 `Reply` 同文件或同 package 新文件） |
| 请求字段 | `postUrl`（建议）、`postTitle`、`postContent`、`persona`、`style` — **无** `commentId` / `commentContent` |
| 响应 | `{ "ok": true, "suggestions": [...] }`，错误码与 `Reply` 对齐 |
| Prompt | 跟评场景：非客服回复评论；不冒充作者、合规约束见 plan |
| Mock | `deepseek_api_key` 为空：不扣费；mock 文案宜与 `Reply` 区分 |
| 数据库 | MVP 无迁移 |

---

## 4. 实施后同步

- [architecture-as-built.md](architecture-as-built.md) — 将 `note-comment` 从「规划中」改为已实现并补全契约行
- （可选）[prd_comment_copilot.md](prd_comment_copilot.md)

---

## 5. 测试（摘录）

无 JWT → 401；缺租户头 → 400；积分不足 → 402；DeepSeek 失败 → 502 + 退款；无 key → mock；**回归 `POST /api/ai/reply`**。

完整表见 **plan** §7。
