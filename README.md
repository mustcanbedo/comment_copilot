# 💬 Comment Copilot

> 小红书评论区 AI 助手 —— 自动采集评论、识别高意向用户、一键生成 AI 回复建议。

![Phase](https://img.shields.io/badge/Phase-1%20MVP-green)
![Next.js](https://img.shields.io/badge/Next.js-16-black)
![Plasmo](https://img.shields.io/badge/Plasmo-Chrome%20Extension-blue)
![Neon](https://img.shields.io/badge/Database-Neon%20DB-teal)

---

## 产品简介

Comment Copilot 是一个 Chrome 插件 + Web 控制台的组合产品，帮助小红书博主和运营人员：

- **自动采集**笔记下的评论（DOM 解析，非爬虫接口）
- **识别意向**：高意向（问购买/价格）、中意向、普通、垃圾
- **AI 生成**符合账号人设的回复建议（DeepSeek-V3）
- **一键填入**：点击建议自动填入小红书回复输入框，用户确认后发送
- **滚动联动**：页面滚动时侧边栏同步高亮对应评论

### 合规说明

本产品采用「用户数字助理」模式：
- 仅读取页面上**用户可见**的公开评论（DOM 解析）
- **不自动发送**任何内容，发送由用户手动确认
- 不模拟登录、不调用平台 API、不批量操作

---

## 文档索引

| 文档 | 说明 |
|------|------|
| [docs/usage-flow.md](docs/usage-flow.md) | 使用逻辑：插件为主、Web 为数据分析、身份绑定 |
| [docs/architecture-as-built.md](docs/architecture-as-built.md) | 已实现技术架构（API、目录、数据流） |
| [docs/architecture_comment_copilot.md](docs/architecture_comment_copilot.md) | 技术架构与演进（含规划） |
| [docs/comment_copilot_database_schema.md](docs/comment_copilot_database_schema.md) | 数据库表结构 |
| [docs/prd_comment_copilot.md](docs/prd_comment_copilot.md) | 产品需求文档 |
| [docs/roadmap_comment_copilot.md](docs/roadmap_comment_copilot.md) | 开发路线图 |
| [docs/code-review.md](docs/code-review.md) | 代码审查结论与建议 |
| [docs/extension-packaging.md](docs/extension-packaging.md) | 插件打包与在 Windows 上安装 |

---

## 技术栈

| 层级 | 技术 |
|------|------|
| Web 后端 | Next.js 16 (App Router) + TypeScript |
| 数据库 | Neon DB (Serverless PostgreSQL) |
| ORM | Drizzle ORM |
| AI | DeepSeek-V3 |
| Chrome 插件 | Plasmo Framework |
| 部署 | Vercel |
| 认证 | NextAuth.js v5 |

---

## 项目结构

```
comment_copilot/
├── web/                        # Next.js Web 应用
│   ├── src/
│   │   ├── app/
│   │   │   ├── api/
│   │   │   │   ├── ingest/comments/   # 评论入库
│   │   │   │   ├── ai/reply/          # AI 回复生成
│   │   │   │   ├── comments/          # 评论查询
│   │   │   │   ├── selectors/         # DOM 选择器热更新
│   │   │   │   ├── settings/persona/  # 人设配置
│   │   │   │   └── auth/              # NextAuth 路由
│   │   │   ├── dashboard/             # 评论控制台
│   │   │   ├── settings/              # 账号 & 人设设置
│   │   │   ├── login/                 # 登录页
│   │   │   └── register/              # 注册页
│   │   ├── db/
│   │   │   ├── schema.ts              # Drizzle 表结构
│   │   │   └── index.ts               # DB 连接
│   │   ├── auth.ts                    # NextAuth 配置
│   │   └── middleware.ts              # 路由保护
│   └── drizzle/                       # 数据库迁移文件
│
└── apps/extension/             # Chrome 插件 (Plasmo)
    ├── contents/
    │   └── xiaohongshu.ts      # 小红书 content script
    ├── sidepanel/
    │   ├── index.tsx           # 侧边栏 UI
    │   └── style.css
    └── background.ts           # 消息路由 & API 调用
```

---

## 本地开发

### 环境要求

- Node.js 18+
- npm 9+

### 1. 克隆项目

```bash
git clone https://github.com/mustcanbedo/comment_copilot.git
cd comment_copilot
```

### 2. 启动 Web 后端

```bash
cd web
npm install
# 或从仓库根目录：npm run dev:web

# 复制环境变量模板
cp .env.local.example .env.local
# 填写 DATABASE_URL、DEEPSEEK_API_KEY、AUTH_SECRET

# 执行数据库迁移
npx dotenv-cli -e .env.local -- npx drizzle-kit migrate

# 启动开发服务器
npm run dev
# → http://localhost:3000
```

### 3. 启动 Chrome 插件

```bash
cd apps/extension
npm install
npm run dev
# → 打开 Chrome → 扩展程序 → 加载已解压 → 选择 .plasmo/chrome-mv3-dev
```

### 4. 在小红书测试

1. 打开 [小红书](https://www.xiaohongshu.com) 任意笔记页面
2. 点击插件图标打开侧边栏
3. 评论会自动同步，点击「生成 AI 回复」即可

---

## 环境变量

### web/.env.local

```env
# Neon DB 连接串
DATABASE_URL=postgresql://...

# DeepSeek API Key
DEEPSEEK_API_KEY=sk-...

# NextAuth 密钥（openssl rand -base64 32）
AUTH_SECRET=...

# 插件 API 地址
NEXT_PUBLIC_API_URL=http://localhost:3000/api
```

### apps/extension/.env.development

```env
PLASMO_PUBLIC_API_URL=http://localhost:3000/api
```

---

## 数据库命令

```bash
cd web

# 生成迁移文件
npx dotenv-cli -e .env.local -- npx drizzle-kit generate

# 执行迁移
npx dotenv-cli -e .env.local -- npx drizzle-kit migrate

# 打开 Drizzle Studio（可视化查看数据）
npx dotenv-cli -e .env.local -- npx drizzle-kit studio
```

---

## 部署

### Web（Vercel）

```bash
cd web
vercel --prod
```

环境变量在 Vercel 控制台 → Settings → Environment Variables 中配置。

### 插件打包

```bash
cd apps/extension
npm run build
# → build/chrome-mv3-prod 目录，上传至 Chrome Web Store
```

---

## 使用逻辑（插件为主、Web 为数据分析）

- **博主日常**：用 Chrome 插件在小红书笔记页看评论、生成 AI 回复、一键填入并手动发送。
- **Web 后台**：注册/登录、设置人设、偶尔打开 Dashboard 做一段时间后的数据分析。
- **当前**：Web 登录与插件未打通，需在 Web 获取 Tenant ID 并在插件中绑定后，插件数据才归属该账号。  
  完整动线见 **[docs/usage-flow.md](docs/usage-flow.md)**。

---

## 开发路线图

| Phase | 状态 | 内容 |
|-------|------|------|
| Phase 1：极简 MVP | ✅ 完成 | 评论采集、AI 回复、侧边栏、Web 控制台、用户认证、Vercel 部署 |
| Phase 2：产品化 | 🚧 进行中 | Lead Scanner、意向识别、抖音支持、Stripe 付费 |
| Phase 3：数据驱动 | 📋 规划中 | DM 脚本、爆款分析、多账号管理、数据报表 |

---

## License

MIT
