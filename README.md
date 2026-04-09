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

**完整索引、按角色阅读路径** → **[docs/README.md](docs/README.md)**

| 文档 | 说明 |
|------|------|
| [docs/architecture-as-built.md](docs/architecture-as-built.md) | 后端 API 架构、目录结构、数据流 |
| [docs/usage-flow.md](docs/usage-flow.md) | 使用流程、租户、积分、合规说明 |
| [docs/extension-packaging.md](docs/extension-packaging.md) | 插件打包与本地安装 |
| [docs/chrome-web-store.md](docs/chrome-web-store.md) | Chrome 网上应用店上架指南 |
| [docs/product-features.md](docs/product-features.md) | 功能说明 |

更多文档见 [docs/README.md](docs/README.md)。

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

## 快速开始

### 环境要求

- Go 1.21+
- Node.js 18+
- npm
- PostgreSQL

### 1. 克隆与安装

```bash
git clone https://github.com/your-username/comment_copilot.git
cd comment_copilot
npm install
```

### 2. 配置后端

```bash
cp backend/config.yaml.example backend/config.yaml
```

编辑 `backend/config.yaml`：

```yaml
port: "3000"
database_url: "postgresql://user:password@localhost:5432/dbname"
deepseek_api_key: "sk-your-deepseek-key"
auth_secret: "your-jwt-secret"
auto_migrate: true
```

### 3. 启动开发环境

**终端 A - 启动后端：**
```bash
npm run dev:backend
# 或: cd backend && go run ./cmd/server
```

**终端 B - 启动扩展：**
```bash
npm run dev
# 默认加载 apps/extension/.env.development，连接 localhost:3000
```

**Chrome 加载扩展：**
1. 打开 `chrome://extensions/`
2. 开启「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择 `apps/extension/.plasmo/chrome-mv3-dev`

### 常用命令

| 命令 | 说明 |
|------|------|
| `npm run dev:backend` | 启动后端服务 |
| `npm run dev` | 启动扩展开发模式 |
| `npm run dev:prod` | 扩展连接生产 API |
| `cd apps/extension && npm test` | 运行扩展单元测试 |

### 故障排查

- **抖音回复/跟评异常** → [docs/troubleshooting-douyin.md](docs/troubleshooting-douyin.md)
- **macOS arm64 sharp 报错** → `cd apps/extension && npm install --platform=darwin --arch=arm64v8 sharp`

---

## 环境变量配置

### 后端 (`backend/config.yaml`)

| 配置项 | 说明 |
|--------|------|
| `port` | 服务端口（默认 3000） |
| `database_url` | PostgreSQL 连接字符串 |
| `deepseek_api_key` | DeepSeek API 密钥（必填） |
| `auth_secret` | JWT 签名密钥 |
| `auto_migrate` | 是否自动执行数据库迁移 |

### 扩展 (`apps/extension/.env.development` 或 `.env.production`)

| 配置项 | 说明 |
|--------|------|
| `PLASMO_PUBLIC_API_URL` | 后端 API 地址 |
| `PLASMO_PUBLIC_FEEDBACK_EMAIL` | 反馈邮箱（可选） |
| `PLASMO_PUBLIC_GITHUB_REPO` | GitHub 仓库名，用于反馈链接（可选） |

---

## 生产部署

### 后端

```bash
cd backend
go build -o server ./cmd/server
./server
```

### 扩展

```bash
cd apps/extension

# 1. 创建生产配置
cp .env.production.example .env.production
# 编辑 .env.production 填入生产 API 地址

# 2. 构建商店包（会自动注入 host_permissions）
npm run package:store

# 产物：build/chrome-mv3-prod.zip
```

更多部署细节见 [docs/extension-packaging.md](docs/extension-packaging.md) 和 [docs/chrome-web-store.md](docs/chrome-web-store.md)。

---

## License

MIT
