# Chrome 网上应用店上架指南

面向 **言灵 Yanling**（Plasmo / Manifest V3）上架 Google Chrome Web Store 的检查清单与操作顺序。

---

## 1. 前置条件

| 项 | 说明 |
|----|------|
| **开发者账号** | [Chrome Web Store Developer Program](https://chrome.google.com/webstore/devconsole) 一次性注册费 **5 美元**（信用卡） |
| **生产后端** | 须与 `host_permissions` + `PLASMO_PUBLIC_API_URL` 一致；**上架商店时** Google 强烈建议 **HTTPS + 域名**（见 §2.1） |
| **隐私政策 URL** | 商店**强制**：可匿名访问的 **HTTPS** 页面，内容与扩展数据收集一致 |

---

## 2. 清单（`manifest`）与权限

### 2.1 `host_permissions`

- **必须与** `.env.production` 里的 `PLASMO_PUBLIC_API_URL` **同源**（含协议、主机、端口）。  
  例如正式服为 `http://47.103.100.114:13000/api`，则 manifest 中需有 `http://47.103.100.114:13000/*`（当前仓库已按此保留示例；IP 变更时请同步改 `package.json`）。
- **三站页面**：保留 `https://www.xiaohongshu.com/*`、`https://www.bilibili.com/*`、`https://bilibili.com/*`、`https://www.douyin.com/*`。
- **本地开发**：可保留 `http://localhost:3000/*`；**提交 Chrome 商店的 zip 里建议去掉 localhost**，只保留正式 API，避免多余权限引发追问。

**上架审核提示**：正式环境若仅为 **`http://` + 裸 IP**，部分审核会被要求改为 **HTTPS + 域名**（证书可用 Let’s Encrypt + Nginx 反代）。侧载/企业策略分发则通常不受商店规则限制，但仍建议上 TLS 以保护 Token 与评论内容传输。

### 2.2 商店后台「权限说明」

用简短中文（或英文）说明为何需要每项权限，例如：

- **storage**：保存登录 Token、租户 ID、本地设置。  
- **tabs / activeTab**：识别当前标签页 URL，仅在支持站点与侧栏联动时使用。  
- **sidePanel**：打开侧边栏界面。  
- **scripting**：在已声明的匹配页注入 content script（读可见 DOM、填入输入框）。  
- **各 host**：仅访问小红书/B 站/抖音页面与你的后端 API，用于采集可见评论与调用 AI 服务。

---

## 3. 隐私政策与服务条款

- 扩展内文案在 `apps/extension/sidepanel/legal-content.tsx`，**商店要的是可打开的 URL**。  
- 常见做法：  
  - 用 **GitHub Pages** / 官网静态页发布《隐私政策》《服务条款》全文；或  
  - 后端提供 `GET /privacy`、`GET /terms` 返回 HTML。  
- 在开发者控制台「隐私权做法」中填写该 URL，并与「数据安全」问卷一致（是否收集用户数据、是否加密传输等）。

---

## 4. 构建与上传包

```bash
cd apps/extension
# 确认 .env.production 中 PLASMO_PUBLIC_API_URL 为生产 HTTPS
npm run build
npm run package
```

上传 **`build/chrome-mv3-prod.zip`**（不要上传解压后的文件夹）。

版本号：在 `package.json` 的 `version` 与商店「新版本」保持一致（建议上架前改为 `1.0.0` 等语义化版本）。

---

## 5. 商店素材（建议提前准备）

| 素材 | 常见规格 |
|------|-----------|
| 详细说明 | 简短介绍 + 功能列表 + 「需配合言灵账号与后端服务」 |
| 屏幕截图 | 至少 1 张，常用 **1280×800** 或 **640×400**（以控制台当前要求为准） |
| 小图标 | 已配置 `assets/yanling_icon_*.png`；商店可能还要求 **128×128** 推广图等 |
| 支持/反馈链接 | 已支持通过 `PLASMO_PUBLIC_FEEDBACK_URL` / GitHub Issues（须公网可访问） |

---

## 6. 审核与合规（摘要）

- **单用途**：扩展只做「在指定站点辅助阅读评论、生成建议、填入输入框」，不宣称爬虫绕盾、批量代发。  
- **远程代码**：勿在运行时拉取可执行脚本；当前栈为打包进扩展的静态资源 + HTTPS API JSON，一般符合要求。  
- **用户数据**：登录态存 `chrome.storage`，说明用途；向自有后端传评论文本、人设等需在隐私政策中写明。  
- 各平台 ToS：产品内已提示用户遵守小红书/B 站/抖音规则；商店说明中可一句带过「须遵守第三方平台服务条款」。

---

## 7. 相关文档

- 解压安装与本地打包：[extension-packaging.md](extension-packaging.md)  
- 后端契约与部署：[architecture-as-built.md](architecture-as-built.md)  
- 根目录 [README.md](../README.md) 开发与配置摘要
