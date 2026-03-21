# 💬 言灵 Yanling

> 小红书评论区 AI 助手 —— 自动采集评论、识别高意向用户、一键生成 AI 回复建议。

![Phase](https://img.shields.io/badge/Phase-1%20MVP-green)
![Go](https://img.shields.io/badge/Backend-Go%20+%20Gin-00ADD8)
![Plasmo](https://img.shields.io/badge/Plasmo-Chrome%20Extension-blue)
![PostgreSQL](https://img.shields.io/badge/Database-PostgreSQL-336791)

---

## 产品简介

Comment Copilot 是一个 Chrome 插件 + Go 后端的组合产品，帮助小红书博主和运营人员：

- **自动采集**笔记下的评论（DOM 解析，非爬虫接口）
- **识别意向**：高意向（问购买/价格）、中意向、普通、垃圾
- **AI 生成**符合账号人设的回复建议（DeepSeek-V3）
- **一键填入**：点击建议自动填入小红书回复输入框，用户确认后发送
- **滚动联动**：页面滚动时侧边栏同步高亮对应评论

### 合规说明

本产品采用「用户数字助理」模式：
- 仅读取页面上**用户可见**的公开内容（如评论、笔记展示区域，DOM 解析）
- AI 文案可**一键填入**输入框；**不自动发送**，须在平台内手动点击发送
- 不模拟登录、不调用平台官方未开放接口代发、不进行违背平台规则的批量自动化操作

---

## 文档索引

**完整索引、按角色阅读路径、架构审阅** → **[docs/README.md](docs/README.md)**

| 常用文档 | 说明 |
|----------|------|
| [docs/architecture-as-built.md](docs/architecture-as-built.md) | **已实现**后端 API、目录、数据流（与代码同步） |
| [docs/usage-flow.md](docs/usage-flow.md) | 使用逻辑、租户头、积分、合规 |
| [docs/plan-note-comment-api-independent-route.md](docs/plan-note-comment-api-independent-route.md) | 笔记跟评 AI：`POST /api/ai/note-comment` 执行单（已定案） |
| [docs/architecture-review-note-comment-and-docs.md](docs/architecture-review-note-comment-and-docs.md) | 架构审阅（跟评方案 + 文档健康度） |
| [docs/extension-packaging.md](docs/extension-packaging.md) | 插件打包与安装 |

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
│   │   └── xiaohongshu.ts      # 小红书 content script
│   ├── sidepanel/
│   │   ├── index.tsx           # 侧边栏 UI（智言、存言、灵主、驭灵）
│   │   ├── login-view.tsx      # 登录/注册页
│   │   ├── legal-content.tsx   # 服务条款、隐私政策
│   │   ├── legal-modal.tsx     # 法律文档弹窗
│   │   └── style.css
│   ├── auth/
│   │   ├── Login.tsx           # 登录组件（备用）
│   │   └── Register.tsx        # 注册组件（备用）
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

### 启动命令

| 场景 | 命令 | 说明 |
|------|------|------|
| **本地开发** | `npm run dev:backend` | 启动 Go 后端（localhost:3000） |
| | `npm run dev` | 启动插件开发模式，连本地 API |
| **联调线上** | `npm run dev:prod` | 启动插件开发模式，连线上 API（.env.production） |

本地开发需**两个终端**：先 `npm run dev:backend`，再 `npm run dev`。

### 首次配置

```bash
# 1. 后端配置
cp backend/config.yaml.example backend/config.yaml
# 编辑 config.yaml：填写 database_url、deepseek_api_key、auth_secret

# 2. 插件依赖
cd apps/extension && npm install
# macOS arm64 需额外：npm install --platform=darwin --arch=arm64v8 sharp
```

### 加载插件

Chrome → `chrome://extensions/` → 开发者模式 → 加载已解压 → 选择 `apps/extension/.plasmo/chrome-mv3-dev`。

开发时请保持 `npm run dev` 或 `npm run dev:prod` 运行。若未运行却加载了开发构建，控制台会出现 WebSocket 连接失败，可忽略或改用 `npm run build` 后加载 `build/chrome-mv3-prod`。

### 4. 在小红书测试

1. 打开 [小红书](https://www.xiaohongshu.com) 任意笔记页面
2. 点击插件图标打开侧边栏
3. 评论会自动同步，点击「生成 AI 回复」即可

---

## 配置说明

### backend/config.yaml

```yaml
port: "3000"
database_url: "postgresql://user:pass@host:port/dbname"
deepseek_api_key: "sk-..."
auth_secret: "your-secret-key"
auto_migrate: true   # 首次启动设为 true，自动建表
```

积分系统：首次部署需执行 `migrations/0004_users_points.sql` 添加积分字段；若使用 `auto_migrate: true`，GORM 会自动添加列，但建议手动执行该迁移以添加负余额 CHECK 约束。

### apps/extension 环境变量

| 文件 | 用途 | API 地址 |
|------|------|----------|
| `.env.development` | `npm run dev` 本地开发 | `http://localhost:3000/api` |
| `.env.production` | `npm run dev:prod` 联调线上、`npm run build` 打包 | 线上域名 |

```env
# .env.development
PLASMO_PUBLIC_API_URL=http://localhost:3000/api

# .env.production（联调线上时使用）
PLASMO_PUBLIC_API_URL=https://your-api-domain.com/api
# PLASMO_PUBLIC_GITHUB_REPO=owner/yanling
```

---

## 部署

### 后端

```bash
cd backend
go build -o server ./cmd/server
./server
```

### 插件打包

```bash
cd apps/extension
npm run build
# → build/chrome-mv3-prod 目录，上传至 Chrome Web Store
```

详见 [docs/extension-packaging.md](docs/extension-packaging.md)。

---

## 开发路线图

| Phase | 状态 | 内容 |
|-------|------|------|
| Phase 1：极简 MVP | ✅ 完成 | 评论采集、AI 回复、侧边栏、Go 后端、用户认证 |
| Phase 2：产品化 | 🚧 进行中 | Lead Scanner、意向识别、抖音支持、Stripe 付费 |
| Phase 3：数据驱动 | 📋 规划中 | DM 脚本、爆款分析、多账号管理、数据报表 |

---

## License

MIT
