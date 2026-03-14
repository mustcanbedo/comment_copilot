# Comment Copilot Web

`web` 是前端 + API 网关层。后端业务逻辑已重构到 `web/backend-go`（Gin + GORM + Viper/YAML）。

## 目录

- `src/app`: Next.js 页面
- `src/app/api`: API 代理层（转发到 Go 后端）
- `backend-go`: Gin + GORM 后端（数据库与业务逻辑）

## 启动

1. 安装前端依赖

```bash
cd web
npm install
```

2. 配置并启动 Go 后端

```bash
cd backend-go
cp config.yaml.example config.yaml
# 填写 database_url / deepseek_api_key / auth_secret
go mod tidy
go run ./cmd/server
```

默认监听：`http://localhost:3001`

3. 启动 Next.js

```bash
cd web
npm run dev
```

默认监听：`http://localhost:3000`

## 环境变量

Next API 代理默认转发到 `http://localhost:3001`。  
可通过 `web/.env.local` 设置：

```env
GO_API_BASE_URL=http://localhost:3001
```

## 说明

- 后端数据库迁移配置为“无物理外键”
- 认证使用 Go 后端 JWT（HttpOnly Cookie：`cc_token`）
