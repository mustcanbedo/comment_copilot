# 插件打包与安装

在任意电脑上打包好扩展后，把**打包结果**拷到目标机器，用 Chrome「加载已解压的扩展程序」即可使用（目标机器无需安装 Node 或 Go）。

---

## 本地开发模式（实时调试）

```bash
cd apps/extension
npm install

# macOS arm64 需额外修复 sharp
npm install --platform=darwin --arch=arm64v8 sharp

npm run dev
# → 打开 Chrome → chrome://extensions/ → 开发者模式 → 加载已解压 → 选择 .plasmo/chrome-mv3-dev
```

---

## 打包生产版本

### 方式一：直接使用构建目录（推荐）

```bash
cd apps/extension
npm run build
```

产物在 **`apps/extension/build/chrome-mv3-prod`** 目录。

把这个文件夹拷到目标机器（U 盘、网盘、局域网共享等），在 Chrome 里：

1. 打开 `chrome://extensions/`
2. 右上角打开「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择 `chrome-mv3-prod` 文件夹（内含 `manifest.json` 的那一层）

### 方式二：打包成 zip

```bash
cd apps/extension
npm run package
```

会在 `build/` 下生成 `chrome-mv3-prod.zip`，拷到目标机器解压后同上操作。

---

## 提交 Chrome 网上应用店

注册开发者账号、改 `host_permissions`、隐私政策 URL、打包 zip 等完整步骤见 **[chrome-web-store.md](chrome-web-store.md)**。

---

## 使用前注意

1. **后端地址**：插件请求的 API 地址由 `.env.production` 里的 `PLASMO_PUBLIC_API_URL` 决定。打包前确认已填写正确的后端地址（本地开发用 `http://localhost:3000/api`，线上用部署后的域名）。

2. **意见反馈**：Chrome 商店要求可公开访问的支持链接。默认跳转 `https://github.com/mustcanbedo/yanling/issues`，可在 `.env.production` 中配置 `PLASMO_PUBLIC_GITHUB_REPO` 或 `PLASMO_PUBLIC_FEEDBACK_URL` 自定义。

3. **登录**：首次使用需注册账号并登录，Token 会保存在插件本地 storage 中，之后自动携带。

4. **Chrome 版本**：建议使用较新版本的 Chrome（支持 Manifest V3 和 Side Panel）。

---

## 常见问题

- **"无法加载扩展程序"**：确认选中的是**文件夹**（里面有 `manifest.json`），不是 zip 或上一级目录。
- **"清单文件缺失或不可读"**：路径不要包含中文或特殊字符；尽量用英文文件夹名。
- **更新插件**：重新 `npm run build`，把新的 `build/chrome-mv3-prod` 覆盖到目标机器，然后在 `chrome://extensions/` 点击该扩展的**刷新**图标即可。
- **macOS arm64 sharp 报错**：运行 `npm install --platform=darwin --arch=arm64v8 sharp` 修复。

---

## 启动 Go 后端

插件需要配合 Go 后端使用。本地启动方式：

```bash
cd backend

# 首次：复制配置并填写
cp config.yaml.example config.yaml

# 设置国内镜像（中国大陆）
go env -w GOPROXY=https://goproxy.cn,direct
go env -w GONOSUMDB='*'

# 启动
go run ./cmd/server
# → Go backend running at http://localhost:3000/api
```

`config.yaml` 配置项：

```yaml
port: "3000"
database_url: "postgresql://user:pass@host:port/dbname"
deepseek_api_key: "sk-..."
auth_secret: "your-secret-key"
auto_migrate: true
```
