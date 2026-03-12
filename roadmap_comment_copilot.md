# Comment Copilot - 项目开发路线图

> 核心原则：**先验证，再构建**。以最小代价跑通核心价值闭环，用真实用户反馈驱动后续迭代。单人 + AI 开发模式，优先选择零运维的托管服务。

最后更新：2026-03-12（v2.0 单人 MVP 版）

---

## 0. 开发模式

- **单人 + AI 协作**：Cursor AI 辅助编码，每个功能模块维护上下文文档。
- **节奏**：以"可演示的功能"为交付单位，不以 Sprint 为单位。
- **验证优先**：每个阶段结束时必须有真实用户使用数据，再决定下一步。
- **技术栈**：Next.js + Vercel + Neon DB + Drizzle ORM + Inngest + Plasmo。

---

## 1. 阶段规划

| Phase | 时间 | 核心目标 | 验收标准 |
|---|---|---|---|
| **Phase 1：极简 MVP** | Week 1-3 | 跑通核心价值闭环 | 10 个种子用户完成首次 AI 辅助回复 |
| **Phase 2：产品化** | Week 4-8 | 提升易用性，验证付费意愿 | 首批 5 个付费用户，月留存率 ≥ 60% |
| **Phase 3：数据驱动迭代** | Week 9+ | 根据用户反馈深化功能 | 付费用户数 ≥ 50，NPS ≥ 30 |

---

## 2. Phase 1：极简 MVP（Week 1-3）

**目标**：跑通「小红书评论抓取 → AI 生成回复建议 → 用户手动发送」闭环。

### Week 1：后端核心链路

| 任务 | 说明 | 验收 |
|---|---|---|
| 初始化 Next.js 项目 | App Router + TypeScript + Tailwind | `next dev` 正常启动 |
| 接入 Neon DB + Drizzle | 建 `tenants`、`comments`、`ai_replies` 三张表 | `db:migrate` 成功 |
| `POST /api/ingest/comments` | 接收评论批次，去重写入 DB | curl 测试通过 |
| `POST /api/ai/reply` | 调用 DeepSeek-V3，返回 3 条候选回复 | curl 测试通过 |
| `GET /api/health` | 健康检查 | 返回 `{ status: 'ok' }` |

### Week 2：Chrome 插件

| 任务 | 说明 | 验收 |
|---|---|---|
| Plasmo 脚手架 | 初始化插件项目，配置 manifest | `plasmo dev` 正常启动 |
| 小红书 content script | MutationObserver 监听评论区 DOM 变化 | 能捕获新评论节点 |
| Background script | 消息路由 + 断路器 + 速率限制 | 评论批量上报到后端 |
| Sidebar UI | 评论列表 + "生成回复"按钮 + 一键复制 | 完整交互流程可用 |
| Selector 热更新 | 从 `/api/selectors` 拉取配置 | 修改 DB 后插件自动使用新 selector |

### Week 3：可用性 + 部署

| 任务 | 说明 | 验收 |
|---|---|---|
| 用户注册/登录 | NextAuth.js（邮箱 + Google OAuth） | 注册登录流程完整 |
| 人设配置页面 | 填写关键词，AI 生成初版人设 | 配置保存后影响 AI 回复风格 |
| 部署到 Vercel | 环境变量配置，生产环境验证 | `vercel deploy` 成功 |
| 种子用户测试 | 邀请 10 个真实用户使用 | 收集反馈，记录问题 |

**Phase 1 验收标准**：10 个种子用户在真实小红书账号上完成首次 AI 辅助回复。

---

## 3. Phase 2：产品化（Week 4-8）

**目标**：提升易用性，验证付费意愿。根据 Phase 1 反馈调整优先级。

### Week 4-5：UI 重构 + Lead Scanner

| 任务 | 说明 |
|---|---|
| shadcn/ui 组件库接入 | 替换基础 UI 组件，提升视觉质量 |
| 评论列表优化 | 意向标签展示（hot/warm/cold/spam）、筛选、排序 |
| 关键词规则意向识别 | 问价/链接/求购关键词 → 自动打 `hot` 标签 |
| Lead Scanner 列表页 | 展示 hot/warm 评论，支持状态更新 |

### Week 6-7：抖音支持 + Inngest

| 任务 | 说明 |
|---|---|
| 抖音 content script | DOM 适配，selector 配置独立维护 |
| Inngest 接入 | 将意向评分改为异步 Inngest 函数 |
| SLA 提醒 | hot 评论超过 2h 未处理 → 邮件/浏览器通知 |
| 大促模式 | 手动开启，调整节流和优先队列 |

### Week 8：商业化

| 任务 | 说明 |
|---|---|
| 付费订阅 | 接入 Stripe，Basic/Pro 套餐 |
| 配额管理 | 按套餐限制 AI 调用次数，超额降级 |
| Onboarding 优化 | 根据 Phase 1 反馈改进引导流程 |

**Phase 2 验收标准**：首批 5 个付费用户，月留存率 ≥ 60%。

---

## 4. Phase 3：数据驱动迭代（Week 9+）

**根据用户反馈决定优先级，以下为候选功能：**

| 候选功能 | 触发条件 | 预估工作量 |
|---|---|---|
| DM Convertor（私信脚本） | ≥3 个用户明确需求 | 1 周 |
| Viral Analyzer（爆款分析） | ≥5 个用户明确需求 | 2 周 |
| 多账号权限管理（RBAC） | 有 MCN 客户需求 | 1 周 |
| 企业微信/钉钉通知集成 | ≥3 个用户明确需求 | 3 天 |
| 对外 API & Webhook | Agency 套餐客户需求 | 1 周 |
| 快手平台支持 | 用户请求量 | 3 天 |
| 数据报表 & 周报 | Pro 套餐用户需求 | 1 周 |

**Phase 3 验收标准**：付费用户数 ≥ 50，NPS ≥ 30。

---

## 5. 关键里程碑

| 日期 | 里程碑 | 验收标准 |
|---|---|---|
| Week 1 Fri | 后端 API 可用 | curl 测试全部通过 |
| Week 2 Fri | 插件可用 | 小红书评论抓取 + AI 回复完整流程 |
| Week 3 Fri | MVP 上线 | 10 个种子用户完成首次使用 |
| Week 5 Fri | Lead Scanner 上线 | hot 评论自动识别准确率 ≥ 80% |
| Week 8 Fri | 商业化上线 | 首批付费用户 |

---

## 6. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|---|---|---|
| 平台 DOM 结构变更 | 高 | 断路器 + selector 热更新，无需重新发布插件 |
| 平台风控升级 | 高 | 保持人工审核、随机延迟、速率限制 |
| AI 成本失控 | 中 | 默认 DeepSeek-V3，月度成本告警，自动降级 |
| 用户不付费 | 高 | Phase 1 先验证核心价值，Phase 2 再商业化 |
| Chrome 商店审核 | 中 | 提前准备隐私政策、权限说明文档 |

---

## 7. 已明确推迟的功能

以下功能在 Phase 3 之前**不开发**，避免过早投入：

- Kubernetes / ArgoCD 部署（Vercel 完全够用）
- Redis Stream + BullMQ（Inngest 替代）
- 表分区 / 物化视图（数据量不到瓶颈）
- 复杂 RBAC（MVP 阶段每用户即 owner）
- 自建监控栈（Prometheus + Grafana）
- 模型自训练 / 微调
- Firefox / Edge 插件支持
