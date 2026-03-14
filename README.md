# 💬 Comment Copilot

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
- 仅读取页面上**用户可见**的公开评论（DOM 解析）
- **不自动发送**任何内容，发送由用户手动确认
- 不模拟登录、不调用平台 API、不批量操作

---

## 文档索引

| 文档 | 说明 |
|------|------|
| [docs/usage-flow.md](docs/usage-flow.md) | 使用逻辑：插件为主、身份绑定流程 |
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
│   ├── internal/
│   │   ├── handler/            # HTTP 处理器
│   │   ├── service/            # 业务逻辑
│   │   ├── repository/         # 数据库访问
│   │   ├── middleware/         # 鉴权中间件
│   │   ├── server/             # 路由注册
│   │   ├── db/                 # DB 连接与模型
│   │   └── config/             # 配置加载
│   ├── migrations/             # SQL 迁移文件
│   ├── config.yaml             # 运行配置（本地）
│   └── config.yaml.example     # 配置模板
│
├── apps/extension/             # Chrome 插件 (Plasmo)
│   ├── contents/
│   │   └── xiaohongshu.ts      # 小红书 content script
│   ├── sidepanel/
│   │   ├── index.tsx           # 侧边栏 UI（虚拟列表）
│   │   └── style.css
│   ├── auth/
│   │   ├── Login.tsx           # 登录组件（备用，供后续插件内登录）
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
- pnpm

### 1. 克隆项目

```bash
git clone https://github.com/mustcanbedo/comment_copilot.git
cd comment_copilot
```

### 2. 启动 Go 后端

```bash
cd backend

# 复制配置模板并填写
cp config.yaml.example config.yaml
# 修改 config.yaml：填写 database_url、deepseek_api_key、auth_secret

# 设置国内 Go 镜像（中国大陆）
go env -w GOPROXY=https://goproxy.cn,direct
go env -w GONOSUMDB='*'

# 启动
go run ./cmd/server
# → Go backend running at http://localhost:3000/api
```

### 3. 启动 Chrome 插件

```bash
cd apps/extension
pnpm install

# macOS arm64 需额外修复 sharp
npm install --platform=darwin --arch=arm64v8 sharp

pnpm dev
# → 打开 Chrome → 扩展程序 → 加载已解压 → 选择 .plasmo/chrome-mv3-dev
```

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

### apps/extension/.env.development

```env
PLASMO_PUBLIC_API_URL=http://localhost:3000/api
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
pnpm build
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
