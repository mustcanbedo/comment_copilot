# 插件打包与在 Windows 上安装

在任意电脑上打包好扩展后，把**打包结果**拷到 Windows，用 Chrome「加载已解压的扩展程序」即可使用（无需在 Windows 上安装 Node）。

---

## 方式一：拷贝整个构建目录（推荐）

### 1. 打包（在 Mac / Windows / Linux 任一即可）

在项目根目录或扩展目录执行：

```bash
# 在项目根目录
cd apps/extension
npm install
npm run build
```

打包完成后，产物在 **`apps/extension/build/chrome-mv3-prod`** 目录（一整个文件夹）。

### 2. 拷到 Windows

- 把 **`build/chrome-mv3-prod`** 整个文件夹拷贝到 Windows（U 盘、网盘、局域网共享等）。
- 在 Windows 上可以放在任意位置，例如：`D:\comment-copilot-extension`。

### 3. 在 Windows 的 Chrome 里安装

1. 打开 Chrome，地址栏输入：`chrome://extensions/`
2. 右上角打开 **「开发者模式」**
3. 点击 **「加载已解压的扩展程序」**
4. 选择你拷贝过去的 **`chrome-mv3-prod`** 文件夹（即包含 `manifest.json` 的那一层）
5. 安装完成后，插件会出现在扩展列表，可固定到工具栏使用。

---

## 方式二：打包成 zip 再在 Windows 解压

### 1. 打包并生成 zip

```bash
cd apps/extension
npm install
npm run build -- --zip
```

会在 `build/` 下生成 **`chrome-mv3-prod.zip`**。

### 2. 拷到 Windows 并解压

- 把 `chrome-mv3-prod.zip` 拷到 Windows，用系统自带的「解压到当前文件夹」解压。
- 在 Chrome 里同样选择 **「加载已解压的扩展程序」**，选中解压出来的**文件夹**（内含 `manifest.json` 的那一层）。

---

## 使用前注意

1. **后端地址**：插件请求的 API 地址由代码里的配置决定（如 `NEXT_PUBLIC_API_URL` 或写死的域名）。若你的 Web 部署在 Vercel，打包时无需改；若是本地/内网，需在打包前改好环境变量或配置再 `npm run build`。
2. **Tenant ID**：在 Web 端注册/登录后，到设置页复制「Tenant ID」，在插件里粘贴保存（若插件有设置页）。否则会使用默认租户，数据可能不对。
3. **Chrome 版本**：建议使用较新版本的 Chrome（支持 Manifest V3 和 Side Panel）。

---

## 常见问题

- **“无法加载扩展程序”**：确认选中的是**文件夹**（里面有 `manifest.json`），不是 zip 或上一级目录。
- **“清单文件缺失或不可读”**：路径不要包含中文或特殊字符；尽量用英文文件夹名。
- **想更新插件**：在 `apps/extension` 里重新 `npm run build`，把新的 `build/chrome-mv3-prod` 覆盖到 Windows 上的同目录，然后在 `chrome://extensions/` 页面点击该扩展的 **刷新** 图标即可。

---

## 本地运行 Web 与端口（含 Windows 报错）

### 默认端口是 3000，不是 1815

本项目的 **Web 端默认端口是 3000**，没有配置 1815。请用：

- **http://localhost:3000**  
- 或 **http://127.0.0.1:3000**

若你访问的是 **http://localhost:1815**，本机没有服务在 1815 上监听，就会一直报错（无法连接、连接被拒绝等）。

### 在 Windows 上正确跑起 Web

1. 在 **Windows** 上打开终端（PowerShell 或 CMD），进入 Web 目录并启动：

   ```bash
   cd web
   npm install
   npm run dev
   ```

2. 看到类似 `Local: http://localhost:3000` 后，在浏览器打开 **http://localhost:3000**（不要用 1815）。

3. 若 3000 被占用，可指定其他端口，例如 1815：

   ```bash
   npm run dev -- -p 1815
   ```

   这时才用 **http://localhost:1815**，并且要把 `web/.env.local` 里的 `NEXT_PUBLIC_API_URL` 改成 `http://localhost:1815/api`，插件开发时如需指向本地也要改成 1815。

### Windows 上仍然报错时

- **“无法访问此网站 / 连接被拒绝”**  
  - 确认在 `web` 目录下执行了 `npm run dev` 且没有报错退出。  
  - 确认访问的端口和终端里显示的端口一致（默认 3000）。

- **防火墙 / 杀毒软件**  
  - 若本机有防火墙或杀毒软件，可能拦截 Node 监听端口，可暂时允许 Node 或 `next dev` 访问网络后再试。

- **改用 127.0.0.1**  
  - 若 `localhost` 异常，可试 **http://127.0.0.1:3000**。

- **页面能打开但白屏 / 报应用错误**  
  - 多半是环境变量问题：在 `web` 目录下确认有 `.env.local`，且配置了 `DATABASE_URL`、`AUTH_SECRET`、`DEEPSEEK_API_KEY` 等（见 README 或 `web/.env.local.example` 若有）。  
  - 修改 `.env.local` 后需重新执行 `npm run dev`。
