# Comment Copilot — 路线图（精简）

> **当前实现与栈**以 [architecture-as-built.md](architecture-as-built.md) 为准：**Go (Gin) + PostgreSQL + Plasmo**。Chrome 扩展已支持 **小红书 / 哔哩哔哩 / 抖音** Web 页 DOM 采集（详见根目录 [README.md](../README.md)）。

最后更新：2026-03-11

---

## 原则

- 先验证、再构建；以「可演示功能」为交付单位。
- API / 数据流变更时，**同一 PR** 更新 `architecture-as-built.md`。

---

## 阶段目标

| Phase | 核心目标 | 验收方向 |
|-------|----------|----------|
| **Phase 1 · MVP** | 评论采集 → AI 回复/跟评建议 → 用户手动发送 | 核心闭环可用 |
| **Phase 2 · 产品化** | 易用性、付费与合规上架 | 留存与付费意愿 |
| **Phase 3+** | 按用户反馈深化（潜客、数据复盘等） | 见 [prd_comment_copilot.md](prd_comment_copilot.md) |

---

## 说明

早期文档中 **Next.js / Vercel / Neon / `web/`** 等周任务清单为历史规划，**已不再采用**；详细周计划不再维护，避免与仓库脱节。产品愿景与 Persona 仍以 PRD 为参考，技术细节以 as-built 为准。
