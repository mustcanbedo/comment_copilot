# 侧栏「登录态 + 双 UI」重构步骤

目标：未登录/过期 → 显示登录页（图二）；已登录 → 显示主界面（图一：智言/存言 + 评论列表）。

---

## 一、现状简要

| 项 | 现状 |
|----|------|
| 侧栏入口 | `sidepanel/index.tsx` 直接渲染主面板，无登录判断 |
| Token | 未在扩展内持久化；后端 JWT 支持 `Authorization: Bearer` 与 Cookie |
| 后端鉴权 | `RequireAuth` 在 router 中被注释，所有接口目前未校验 token |
| 登录/注册组件 | `auth/Login.tsx`、`auth/Register.tsx` 存在，使用邮箱登录，后端当前为**手机号**登录 |

---

## 二、重构步骤（按顺序执行）

### 步骤 1：后端——开启鉴权并区分公开/受保护路由

- **文件**：`backend/internal/server/router.go`
- **操作**：
  - 对需要登录的路由加上 `middleware.RequireAuth(deps.AuthSecret)`。
  - 保持**公开**：`POST /api/auth/login`、`POST /api/auth/register`。
  - **受保护**（加在对应 group 上）：`GET /api/auth/me`、`GET/POST /api/comments`、`POST /api/ingest/comments`、`POST /api/ai/reply`、`GET/POST /api/settings/persona`、`GET /api/selectors` 等。
- **验证**：未带 token 请求 `GET /api/auth/me` 应返回 401。

---

### 步骤 2：扩展——统一登录凭证（邮箱 vs 手机号二选一）

当前后端是**手机号 + 密码**，扩展 Login/Register 是**邮箱**。

- **方案 A（推荐）**：后端增加「邮箱 + 密码」登录/注册（新接口或扩展现有 handler），扩展继续用邮箱。
- **方案 B**：扩展改为手机号 + 密码，与后端一致，Login/Register 表单项和接口字段改为 `phone`。

选定后，保证扩展请求体与后端 `binding` 一致（如 `email`/`phone`、`password`）。

---

### 步骤 3：扩展——Token 存储与「是否已登录」判断

- **存储**：使用 `@plasmohq/storage` 存 token。例如 key：`authToken`（或 `cc_token` 与后端命名一致）。
- **写入时机**：登录接口返回 `token` 后，`storage.set('authToken', data.token)`。
- **登出**：调用后端 `POST /api/auth/logout`（可选），并 `storage.remove('authToken')`。
- **读取**：侧栏挂载时 `storage.get('authToken')`，有值则认为「可能已登录」，无值则直接显示登录页。

---

### 步骤 4：扩展——用 /auth/me 校验 token 是否有效

- 有 token 时，在侧栏或包装组件内请求 `GET /api/auth/me`，Header：`Authorization: Bearer <token>`。
- **200**：视为已登录，展示主界面（图一）。
- **401** 或无 token：视为未登录或过期，展示登录页（图二）。
- 可选：在 background 或侧栏初始化时统一做一次校验，将「已登录」状态存到 storage 或 React state，避免每次渲染都请求。

---

### 步骤 5：侧栏入口——按登录态分支渲染

- **文件**：`sidepanel/index.tsx`（或拆成 `SidePanelRoot` + `LoginView` + `MainView`）。
- **逻辑**：
  - 状态：`authStatus: 'idle' | 'checking' | 'loggedOut' | 'loggedIn'`；可选 `user` 存 /auth/me 返回的用户信息。
  - 初次：`authStatus === 'idle'` 时调校验（读 token + 请求 /auth/me），置为 `checking`，结束后置为 `loggedOut` 或 `loggedIn`。
  - 渲染：
    - `loggedOut`（或无 token）→ 渲染**登录页**（图二样式）。
    - `loggedIn` → 渲染**主界面**（图一样式）。
- 登录页「登录」成功：存 token、设 `loggedIn`（或再调一次 /auth/me 取 user），界面切到主面板。

---

### 步骤 6：登录页 UI——对齐图二

- **内容**：Logo + 「Comment Copilot」+ 口号「用AI回复评论，把路人变成客户」、Google 登录按钮、「或使用邮箱登录」、邮箱 + 密码、忘记密码、登录按钮、底部「还没有账号? 免费注册」「服务条款」「隐私政策」。
- **实现**：可重写 `auth/Login.tsx` 为侧栏专用样式（去掉 Tailwind，用 `style.css` 或单独 `login.css`），或新建 `sidepanel/LoginView.tsx` 引用现有 Login 逻辑、只改 UI。
- **注册**：保留 `auth/Register.tsx`，登录页点「免费注册」可切到注册视图；注册成功后切回登录或直接写 token 并进入主界面（若后端注册即返回 token 则可直接进主界面）。

---

### 步骤 7：主界面 UI——对齐图一

- **Header 区**：
  - 左侧：Logo + 文案「智言」。
  - 右侧：**竖排导航**（自上而下）——「我」（个人）、「智言」（当前页，高亮）、「存言」（模板）。可做成图标 + 文案的竖条，贴右侧。
- **统计卡片**：保留「50 全部」「3 高意向」「47 待处理」的展示方式与数据来源。
- **筛选**：全部 / 高意向 / 待处理，样式与图一一致（如高亮为橙色）。
- **评论列表**：每条评论保留头像、昵称、意向标签、正文（含 emoji/图片）、**每条下方主按钮「生成 AI 回复」**（橙色），点击后展示 AI 建议与「回复」「重新生成」等。
- **样式**：主色橙色、白底、与图一一致的圆角与间距；竖导航可单独做一块固定右侧。

---

### 步骤 8：Background / API 请求统一带 Token

- 所有请求后端受保护接口时，从 storage 取 token，在 Header 中带 `Authorization: Bearer <token>`。
- 若在 background 里发请求（如 ingest、ai/reply），background 需能读同一 storage 的 token；Plasmo Storage 在 extension 内共享，直接 `storage.get('authToken')` 即可。
- 收到 401 时：可通知侧栏「登录已过期」（如通过 `chrome.runtime.sendMessage`），侧栏将 `authStatus` 设为 `loggedOut` 并切回登录页。

---

### 步骤 9：可选——「我」与「存言」

- **「我」**：点击后可在侧栏内切换为「个人/设置」视图（或将来跳转设置页），展示账号信息、退出登录等；退出时清 token、设 `loggedOut`，显示登录页。
- **「存言」**：对应模板 Tab，可沿用现有 Templates 相关状态与列表，仅把入口改为右侧竖导航的「存言」。

---

## 三、建议执行顺序小结

1. 后端：开启 RequireAuth、区分公开/受保护路由（步骤 1）。  
2. 后端或扩展：统一登录凭证邮箱/手机号（步骤 2）。  
3. 扩展：Token 存储 + /auth/me 校验 + 侧栏按登录态分支（步骤 3、4、5）。  
4. 扩展：登录页 UI（图二）（步骤 6）。  
5. 扩展：主界面 UI（图一）（步骤 7）。  
6. 扩展：请求头带 token、401 时回到登录页（步骤 8）。  
7. 可选：「我」「存言」行为与视图（步骤 9）。

---

## 四、文件改动清单（便于对照）

| 文件 | 改动要点 |
|------|----------|
| `backend/internal/server/router.go` | 为受保护路由加上 `RequireAuth` |
| `apps/extension/sidepanel/index.tsx` | 登录态 state、分支渲染 LoginView / MainView、/auth/me 校验 |
| `apps/extension/sidepanel/style.css` | 主界面图一样式（header、竖导航、统计、筛选、列表） |
| `apps/extension/auth/Login.tsx` 或新建 `sidepanel/LoginView.tsx` | 图二登录页 UI + 登录/注册切换 |
| `apps/extension/constants.ts` | 如需可加 `AUTH_TOKEN_KEY` 等常量 |
| `apps/extension/background.ts` | 请求 ingest、ai/reply 时从 storage 取 token 并带 Header |

按上述步骤从 1 做到 8，即可完成「未登录→登录页，已登录→图一主界面」的重构主线。
