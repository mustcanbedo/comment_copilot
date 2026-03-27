# Chrome 网上应用店上架指南

面向 **言灵 Yanling**（Plasmo / Manifest V3）上架 Google Chrome Web Store 的检查清单与操作顺序。

---

## 1. 前置条件

| 项 | 说明 |
|----|------|
| **开发者账号** | [Chrome Web Store Developer Program](https://chrome.google.com/webstore/devconsole) 一次性注册费 **5 美元**（信用卡） |
| **生产后端** | 须与 `host_permissions` + `PLASMO_PUBLIC_API_URL` 一致；**上架商店时** Google 强烈建议 **HTTPS + 域名**（见 §2.1） |
| **隐私政策 URL** | 商店**强制**：可匿名访问的 **HTTPS** 页面，内容与扩展数据收集一致。**已具备**：[言灵仓库《隐私政策》](https://github.com/mustcanbedo/yanling/blob/main/docs/privacy-policy.md)（GitHub 以 HTTPS 渲染，匿名可读；须保持与 `legal-content.tsx` 正文同步） |

---

## 2. 清单（`manifest`）与权限

### 2.1 `host_permissions`

- **必须与** `.env.production` 里 `PLASMO_PUBLIC_API_URL` 的 **origin 一致**（协议 + 主机 + **端口**；HTTPS 默认 443 时可不写端口）。  
  例：当前示例为 `https://47.103.100.114/api` → manifest 需含 `https://47.103.100.114/*`。若 API 在 `https://host:13000`，须声明 `https://host:13000/*`。改域名/IP/端口后同步改 `package.json` 与 `.env.production`。
- **三站页面**：保留 `https://www.xiaohongshu.com/*`、`https://www.bilibili.com/*`、`https://bilibili.com/*`、`https://www.douyin.com/*`。
- **本地开发**：可保留 `http://localhost:3000/*`；**提交商店的 zip 须去掉 localhost**（见 §4 的 `npm run package:store` 与 [chrome-web-store-supplements.md](chrome-web-store-supplements.md) §1）。

**上架审核提示**：**裸 IP** 有时仍可过审，但可能被追问；**域名 + HTTPS** 更稳妥。若 API 曾用 HTTP，数据安全问卷须如实填写加密情况。

### 2.2 商店后台「权限说明」

用简短中文（或英文）说明为何需要每项权限，例如：

- **storage**：保存登录 Token、租户 ID、本地设置。  
- **tabs / activeTab**：识别当前标签页 URL，仅在支持站点与侧栏联动时使用。  
- **sidePanel**：打开侧边栏界面。  
- **scripting**：在已声明的匹配页注入 content script（读可见 DOM、填入输入框）。  
- **各 host**：仅访问小红书/B 站/抖音页面与你的后端 API，用于采集可见评论与调用 AI 服务。

---

## 3. 隐私政策与服务条款

- **扩展内正文**：`apps/extension/sidepanel/legal-content.tsx`（与公开政策须一致）。  
- **商店「隐私权做法」URL（当前用法）**：[https://github.com/mustcanbedo/yanling/blob/main/docs/privacy-policy.md](https://github.com/mustcanbedo/yanling/blob/main/docs/privacy-policy.md) — 公开仓库、HTTPS、无需登录即可阅读。若审核方更偏好「独立域名页面」，可再增加 GitHub Pages / 官网 HTML，但非必须前提。  
- **《服务条款》**：当前全文可在安装包内「驭灵」法律文档查看；若控制台**单独索要服务条款 URL**，可在 yanling 增加 `docs/terms-of-service.md`（或后端 `GET /terms`）并填同一类公开链接。  
- 在开发者控制台填写隐私政策 URL 后，**「数据安全」问卷**须与政策一致（邮箱、用户生成内容、传至自有后端与 DeepSeek、HTTPS 等）。

---

## 4. 构建与上传包

**提交 Chrome 网上应用店**（manifest 不含 `localhost`）：

```bash
cd apps/extension
# 确认 .env.production 中 PLASMO_PUBLIC_API_URL 与 package.json 中非 localhost 的 API host 一致
npm run package:store
```

**仅本地验证**（可含 `localhost`）：`npm run build` → `npm run package`。

上传 **`build/chrome-mv3-prod.zip`**（不要上传解压后的文件夹）。脚本说明见 [chrome-web-store-supplements.md](chrome-web-store-supplements.md) §1。

版本号：在 `package.json` 的 `version` 与商店「新版本」保持一致（建议上架前改为 `1.0.0` 等语义化版本）。

---

## 5. 商店素材（建议提前准备）

| 素材 | 常见规格 |
|------|-----------|
| 详细说明 | 简短介绍 + 功能列表 + 「需配合言灵账号与后端服务」 |
| 屏幕截图 | 至少 1 张，常用 **1280×800** 或 **640×400**（以控制台当前要求为准） |
| 小图标 | 已配置 `assets/yanling_icon_*.png`；商店可能还要求 **128×128** 推广图等 |
| 支持/反馈链接 | 已支持通过 `PLASMO_PUBLIC_FEEDBACK_URL` / GitHub Issues（须公网可访问） |

### 5.1 本文档尚未逐条展开、但控制台常要求的项

上架时在开发者后台逐项核对（以 [Chrome Web Store 当前说明](https://developer.chrome.com/docs/webstore/) 为准）：

| 项 | 说明 |
|----|------|
| **隐私政策 HTTPS URL** | **已覆盖**：使用 [yanling `docs/privacy-policy.md` 的 blob 链接](https://github.com/mustcanbedo/yanling/blob/main/docs/privacy-policy.md)（见 §3）。上架前再点一次确认无需登录、内容为最新。 |
| **数据安全问卷** | 是否收集邮箱、用户生成内容、用途、是否与第三方共享等；须与隐私政策一致。 |
| **测试账号（强烈建议）** | 扩展需登录才能用：在审核「备注」提供**只读测试账号**，或说明无账号时的可见范围，减少拒审。 |
| **商品说明语言** | 至少一种语言完整「说明」；面向全球可再加英文简介。 |
| **分类 / 单用途** | 选对类别；单用途描述与 §6 一致，避免「万能工具」表述。 |
| **官网 / 商品 URL（可选）** | 有官网可填，增强可信度。 |
| **欧盟地区** | 若面向欧盟用户，核对交易者身份、联系方式等披露要求（以控制台提示为准）。 |
| **宣传图尺寸** | 除截图外，商店可能要求 **440×280**、**920×680**、**1400×560** 等，以**上传页实时要求**为准。 |

---

## 6. 审核与合规（摘要）

- **单用途**：扩展只做「在指定站点辅助阅读评论、生成建议、填入输入框」，不宣称爬虫绕盾、批量代发。  
- **远程代码**：勿在运行时拉取可执行脚本；当前栈为打包进扩展的静态资源 + HTTPS API JSON，一般符合要求。  
- **用户数据**：登录态存 `chrome.storage`，说明用途；向自有后端传评论文本、人设等需在隐私政策中写明。  
- 各平台 ToS：产品内已提示用户遵守小红书/B 站/抖音规则；商店说明中可一句带过「须遵守第三方平台服务条款」。

---

## 7. 相关文档

- 公开隐私政策（商店 URL）：[yanling `docs/privacy-policy.md`](https://github.com/mustcanbedo/yanling/blob/main/docs/privacy-policy.md)  
- 解压安装与本地打包：[extension-packaging.md](extension-packaging.md)  
- 后端契约与部署：[architecture-as-built.md](architecture-as-built.md)  
- 功能清单（商店「说明」可摘录）：[product-features.md](product-features.md)  
- **上架辅助稿**（zip 脚本、说明文案、审核备注、数据安全对照）：[chrome-web-store-supplements.md](chrome-web-store-supplements.md)  
- 根目录 [README.md](../README.md) 开发与配置摘要

---

## 8. 对照本文档，你还可能缺什么（汇总）

### 已就绪（相对此前清单）

- **公开隐私政策 URL**：已可用 [yanling 隐私政策](https://github.com/mustcanbedo/yanling/blob/main/docs/privacy-policy.md)；商店「隐私权做法」可直接填此链接（与 §3、`legal-content.tsx` 保持同步即可）。

### 仍须你方在控制台 / 工程里完成

1. **Chrome 开发者账号**（5 美元）与**首次提审包**上传。  
2. **上架专用 zip**：使用 `npm run package:store`（见 §4、[chrome-web-store-supplements.md](chrome-web-store-supplements.md) §1）；并确认 `PLASMO_PUBLIC_API_URL` 与 manifest 中非 localhost 的 API 权限同源。  
3. **截图与宣传图**— 按上传页实时尺寸准备（见 §5.1「宣传图尺寸」）。  
4. **商品说明文案**— 已起草可粘贴稿：[chrome-web-store-supplements.md](chrome-web-store-supplements.md) §2（可按字数微调）。  
5. **审核备注 + 测试账号**— 模板见 [chrome-web-store-supplements.md](chrome-web-store-supplements.md) §3；**邮箱与密码须你方创建并填入**。  
6. **数据安全问卷**— 对照稿见 [chrome-web-store-supplements.md](chrome-web-store-supplements.md) §4；须在控制台逐项勾选并与隐私政策一致。  
7. **上架后 CORS**— 取得正式扩展 ID 后，后端将 `chrome-extension://<扩展ID>` 写入白名单（见 [architecture-as-built.md](architecture-as-built.md) 与 `config.yaml` `cors_origins`）。

### 可选 / 风险项（非「缺 URL」类）

- **API 裸 IP + HTTPS**：仍可能被追问；长期建议 **域名 + 证书**（§2.1）。  
- **服务条款独立 URL**：若审核或地区披露要求单独链接，再补 `docs/terms-of-service.md` 或静态页（§3）。  
- **欧盟交易者信息**：若面向欧盟分发，按控制台提示补全联系方式等（§5.1）。
