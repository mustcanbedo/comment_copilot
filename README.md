# 言灵 Yanling

> 面向创作者与运营的 **评论区 AI 助手**：自动看评、识别高意向、生成回复与主跟评文案，减轻互动压力。

![Phase](https://img.shields.io/badge/Phase-1%20MVP-green)
![Go](https://img.shields.io/badge/Backend-Go%20+%20Gin-00ADD8)
![Plasmo](https://img.shields.io/badge/Plasmo-Chrome%20Extension-blue)
![PostgreSQL](https://img.shields.io/badge/Database-PostgreSQL-336791)

---

## 产品简介

Comment Copilot 是一个 Chrome 插件 + Go 后端的组合产品，帮助内容创作者与运营：

- **自动采集**笔记 / 视频下的评论（**小红书**、**哔哩哔哩**、**抖音** Web 页，DOM 解析，非爬虫接口）
- **识别意向**：高意向（问购买/价格）、中意向、普通、垃圾
- **AI 生成**符合账号人设的回复建议（DeepSeek-V3）
- **一键填入**：侧栏每条建议点「回复」后，自动在页内点「回复」并写入输入框（**小红书** / **哔哩哔哩** / **抖音**），用户确认后发送
- **排除自己的评论**：**小红书**依赖页内解析的登录身份（userId / 展示昵称与评论作者比对）；**抖音**依赖页内**当前账号主页 id**（`/user/` 路径段等）与评论作者链比对
- **滚动联动**：页面滚动时侧边栏同步高亮对应评论

### 合规说明

本产品采用「用户数字助理」模式：
- 仅读取页面上**用户可见**的公开内容（如评论、笔记展示区域，DOM 解析）
- AI 文案可**一键填入**输入框；**不自动发送**，须在平台内手动点击发送
- 不模拟登录、不调用平台官方未开放接口代发、不进行违背平台规则的批量自动化操作

---

## 文档

**完整索引、按角色阅读路径、架构审阅** → **[docs/README.md](docs/README.md)**

| 常用文档 | 说明 |
|----------|------|
| [docs/architecture-as-built.md](docs/architecture-as-built.md) | **已实现**后端 API、目录、数据流（与代码同步） |
| [docs/usage-flow.md](docs/usage-flow.md) | 使用逻辑、租户头、积分、合规 |
| [docs/plan-note-comment-api-independent-route.md](docs/plan-note-comment-api-independent-route.md) | 笔记跟评 AI：`POST /api/ai/note-comment` 执行单（已定案） |
| [docs/architecture-review-note-comment-and-docs.md](docs/architecture-review-note-comment-and-docs.md) | 架构审阅（跟评方案 + 文档健康度） |
| [docs/extension-packaging.md](docs/extension-packaging.md) | 插件打包与安装 |
| [docs/chrome-web-store.md](docs/chrome-web-store.md) | **Chrome 网上应用店**上架清单 |

更多（PRD、路线图、库表、方案对比等）见 [docs/README.md](docs/README.md)。

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 后端 | Go + Gin + GORM |
| 数据库 | PostgreSQL |
| AI | DeepSeek-V3 |
| Chrome 插件 | Plasmo Framework |
| 认证 | JWT（golang-jwt） |

---

## 项目结构

```
comment_copilot/
├── backend/                    # Go 后端
│   ├── cmd/server/main.go      # 入口
│   ├── cmd/migrate/main.go     # 迁移入口（执行 migrations）
│   ├── internal/
│   │   ├── handler/            # HTTP 处理器
│   │   ├── service/            # 业务逻辑
│   │   ├── repository/         # 数据库访问
│   │   ├── middleware/         # 鉴权、租户校验
│   │   ├── server/             # 路由注册
│   │   ├── db/                 # DB 连接与模型
│   │   └── config/             # 配置加载
│   ├── migrations/             # SQL 迁移文件（0001~0004）
│   ├── scripts/                # 数据脚本（如 backfill_points.sql）
│   ├── config.yaml             # 运行配置（本地）
│   └── config.yaml.example     # 配置模板
│
├── apps/extension/             # Chrome 插件 (Plasmo)
│   ├── contents/
│   │   ├── shared/
│   │   │   ├── platform-content-utils.ts  # 三端共用：ingest 去重、节流扫描、simpleHash、FillResult
│   │   │   └── platform-content-utils.test.ts
│   │   ├── xiaohongshu.ts      # 小红书
│   │   ├── bilibili.ts         # 哔哩哔哩
│   │   └── douyin.ts           # 抖音 Web 视频页
│   ├── sidepanel/
│   │   ├── index.tsx           # 侧边栏 UI（智言、存言、灵主、驭灵）
│   │   ├── login-view.tsx      # 登录/注册页
│   │   ├── legal-content.tsx   # 服务条款、隐私政策
│   │   ├── legal-modal.tsx     # 法律文档弹窗
│   │   └── style.css
│   ├── auth/
│   │   ├── Login.tsx           # 登录组件（备用）
│   │   └── Register.tsx        # 注册组件（备用）
│   ├── constants.test.ts       # URL / platform 判定单测
│   ├── vitest.config.ts
│   └── background.ts           # 消息路由 & API 调用
│
└── docs/                       # 文档
```

---

## 本地开发

### 环境要求

- Go 1.21+
- Node.js 18+
- npm

### 扩展单元测试（URL 判定与共用工具）

```bash
cp backend/config.yaml.example backend/config.yaml   # 填 database_url、deepseek_api_key、auth_secret
cd apps/extension && npm install
# macOS arm64 可选：npm install --platform=darwin --arch=arm64v8 sharp
```

| 命令 | 说明 |
|------|------|
| `npm run dev:backend` | 后端 `localhost:3000` |
| `npm run dev` | 扩展连本地 API（需与上并行） |
| `npm run dev:prod` | 扩展连 `.env.production` 线上 API |

扩展：`chrome://extensions/` → 开发者模式 → 加载已解压 → `apps/extension/.plasmo/chrome-mv3-dev`（保持 `npm run dev` 运行）。

**单测**：`cd apps/extension && npm test`

**抖音回复/跟评异常** → [docs/troubleshooting-douyin.md](docs/troubleshooting-douyin.md)

---

## 配置摘要

**`backend/config.yaml`**：`port`、`database_url`、`deepseek_api_key`、`auth_secret`、`auto_migrate`。积分字段见 `migrations/0004_users_points.sql`。

**扩展**：`apps/extension/.env.development` 中 `PLASMO_PUBLIC_API_URL=http://localhost:3000/api`；生产见 `.env.production`。

---

## 部署

```bash
cd backend && go build -o server ./cmd/server && ./server
cd apps/extension && npm run build   # → build/chrome-mv3-prod
```

打包上架细节见 [docs/extension-packaging.md](docs/extension-packaging.md)。

---

## License

MIT
