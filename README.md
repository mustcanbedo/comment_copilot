# 💬 言灵 Yanling

> 小红书评论区 AI 助手 —— 自动采集评论、识别高意向用户、一键生成 AI 回复建议。

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
cd apps/extension && npm install && npm test
```

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

### 抖音「回复」填不进去时：控制台怎么配合排查

侧栏里**底部评论输入框往往一直存在**；点某条「回复」多是让**同一输入区**出现「回复@昵称」条，表示已关联到该评论，而不是一定多出一个新的 `textarea`。扩展会**先程序化点该条「回复」**（除非该条已是「回复中」且底栏已对上作者），再等绑定后写入。

**侧栏「已回复」与待处理列表**：**抖音 / 小红书 / B 站一致**——侧栏点「回复」且**成功写入页内输入框**后，该条即标为「已回复」并同步后端 `mark-replied`（视为已处理，与是否在平台内点击发送无关）。若你**未**经侧栏、纯手打发出回复，扩展仍会尝试用 DOM 自检（`domSelfReplied`）把主评标为已回复。

**抖音评论采集**：`querySelectorDeepWithin` 穿透 Shadow 时子节点**逆序入栈**，匹配顺序与文档顺序一致（先昵称区、正文，避免先命中右侧「4012分享回复」）；昵称优先 `comment-item-info-wrap` / `BT7MlqJC` 内主页链接（含 open shadow / 表情图 `alt`）；正文拒绝纯统计条。正文优先结构选择器 `.Vrj4Q3zT > .C7LroK_h` 与 `.C7LroK_h`，并做列表元数据后缀剥离（含尾部「展开N条回复」）。**评论 root**：`[class*=comment-item]` 会误把昵称条/头像/统计扫成独立根，内层过滤会丢掉整行 `data-e2e=comment-item`，故会先**剔除行内碎片根**，再取最内层行；**含主评 + `replyContainer` 的 `.EpsntdUI` 线程宿主**在内层过滤中**强制保留**，采集时只刮 `replyContainer` 外的主评列，避免发子回复后主楼从侧栏消失。楼主块在 `replyContainer` 之前**向前遍历兄弟节点**定位（展开子回复后中间可能插入按钮，不能只看 `previousElementSibling`）。**侧栏同步**：折叠/展开会改变可见 DOM，content 在每次节流扫描后比较「当前可见 `platformCommentId` 集合签名」，变化则发 `PAGE_COMMENTS_DOM_CHANGED` 触发侧栏重拉全量页内评论（不只依赖 ingest 新增）。**虚拟列表**：下拉后顶部评论可能从 DOM 卸载，content script 对同一 `postUrl` **累积**曾扫描到的 `platformCommentId`（有上限），`GET_ALL_PAGE_COMMENTS` 返回累积列表，避免首条从侧栏消失；换视频或整页 URL 变化时清空累积。

**智言「视频跟评」**：侧栏里点某条建议的「评论」，扩展会优先**模拟点击** `.comment-input-inner-container` 里带「留下你的精彩评论吧」的占位节点（与页面真实结构一致），再等 `contenteditable` 出现后写入；仍会兜底点击整块输入壳。若仍写不进去，**先手动点一下底部评论框**，再点侧栏「评论」一般即可；与回复某条评论的 `FILL_REPLY` 不同。

**抖音 URL 与侧栏**：独立视频页（`/video/{id}`）与带 `modal_id` 等参数的地址会识别为同一条视频；**信息流壳层**目前仅包含首页与 **`/jingxuan` / `/following` / `/friend` / `/explore`**（弹层未写入地址栏时也可进入「视频跟评」）。**搜索页、用户主页**等不会当作跟评上下文，以减少误扫与多余请求；侧栏对同一「帖子身份」的连续 `tabs.onUpdated` 会合并拉取。

若调试日志里 **`poll { editables: 0 }` 持续很久**：常见于精选 **`/jingxuan?modal_id=`** 弹层页——整页 DOM + 大量 Shadow 导致「全页深搜」在步数上限内**还没遍历到**右侧评论输入区。扩展已改为从**当前评论行**向上找侧栏级容器，再**只在该子树内**穿透 Shadow 收集输入框；请更新扩展并刷新页面后重试。

在 **抖音视频页**（不是侧栏）按 F12 打开开发者工具 → **Console**：

1. **打开扩展详细日志**（改完需刷新当前页）  
   `localStorage.setItem("yanling_debug_douyin_fill", "1")`  
   再点侧栏里某条的「回复」，控制台会出现以 `[CommentCopilot][douyin][fill]` 开头的步骤；把这一段**完整复制**发开发者。  
   关掉日志：`localStorage.removeItem("yanling_debug_douyin_fill")`

2. **看侧栏黄色提示里的英文**：如 `comment_not_found`、`reply_btn_not_found`、`reply_redirects_to_xigua`（该条只能去西瓜视频回，本页无输入框）、`composer_needs_manual_open`（需先在页面手动点「回复」）、`insert_failed`，与日志里的 `step` 对应。

3. **可选：看页面上有哪些可编辑框**（穿透一层 shadow，仅作参考）：

```js
(() => {
  const walk = (root, out, d = 0) => {
    if (d > 18) return;
    root.querySelectorAll?.("textarea, input[type=text], [contenteditable=true]").forEach((el) => {
      const r = el.getBoundingClientRect?.();
      if (!r || r.width < 2) return;
      out.push({
        tag: el.tagName,
        ph: el.placeholder || "",
        cls: (el.className && String(el.className).slice(0, 60)) || "",
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
      });
    });
    root.querySelectorAll?.("*").forEach((n) => n.shadowRoot && walk(n.shadowRoot, out, d + 1));
  };
  const o = [];
  walk(document, o);
  return o.sort((a, b) => b.bottom - a.bottom);
})();
```

4. **判断「页面上到底有没有可编辑框」**（扩展与页面共用同一 DOM；若这里也是 0，脚本同样扫不到）  
   - 先**手动**在评论里点一条的 **「回复」**，等底部出现输入条，**不要关**。  
   - 再在 Console 里执行下面整段，看 `total`：

```js
(() => {
  let light = 0,
    sh = 0,
    ifr = [];
  const ok = (el) => {
    const r = el.getBoundingClientRect?.();
    return r && r.width > 2 && r.height > 2;
  };
  const count = (root) => {
    let n = 0;
    root.querySelectorAll?.("textarea, input, [contenteditable]").forEach((el) => {
      if (ok(el)) n++;
    });
    return n;
  };
  light = count(document);
  const walk = (node, d) => {
    if (d > 22) return;
    if (node.shadowRoot) {
      sh += count(node.shadowRoot);
      node.shadowRoot.querySelectorAll("*").forEach((c) => walk(c, d + 1));
    }
    node.children?.forEach?.((c) => walk(c, d + 1));
  };
  walk(document.documentElement, 0);
  document.querySelectorAll("iframe").forEach((fr, i) => {
    try {
      const d = fr.contentDocument;
      ifr.push({ i, ok: !!d, n: d ? count(d) : null });
    } catch (e) {
      ifr.push({ i, ok: false, crossOrigin: true });
    }
  });
  return { light, openShadow: sh, iframeEditableCounts: ifr, total: light + sh + ifr.reduce((s, x) => s + (x.n || 0), 0) };
})();
```

- **`total > 0`**：输入区在 **light DOM**（或同源 iframe），扩展理论上能写入；若你**没**手动点「回复」时扩展一直 `editables: 0`，多半是 **抖音不认脚本触发的「回复」点击**，请先在该条评论下**手动**点「回复」打开输入条，再点侧栏「回复」。  
- **手动点回复后仍 `total === 0`**：输入区很可能在 **closed shadow** 或 **跨域 iframe**（`iframeEditableCounts` 里 `crossOrigin: true`）里，页面脚本也拿不到，需换方案。

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
