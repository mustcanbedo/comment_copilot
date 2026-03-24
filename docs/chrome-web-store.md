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

- **必须与** `.env.production` 里 `PLASMO_PUBLIC_API_URL` 的 **origin 一致**（协议 + 主机 + **端口**；HTTPS 默认 443 时可不写端口）。  
  例：当前示例为 `https://47.103.100.114/api` → manifest 需含 `https://47.103.100.114/*`。若 API 在 `https://host:13000`，须声明 `https://host:13000/*`。改域名/IP/端口后同步改 `package.json` 与 `.env.production`。
- **三站页面**：保留 `https://www.xiaohongshu.com/*`、`https://www.bilibili.com/*`、`https://bilibili.com/*`、`https://www.douyin.com/*`。
- **本地开发**：可保留 `http://localhost:3000/*`；**提交商店的 zip 建议去掉 localhost**，只保留正式 API。

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

- 扩展内文案在 `apps/extension/sidepanel/legal-content.tsx`，**商店要的是可打开的 URL**。  
- 常见做法：  
  - 用 **GitHub Pages** / 官网静态页发布《隐私政策》《服务条款》全文；或  
  - 后端提供 `GET /privacy`、`GET /terms` 返回 HTML。  
- 在开发者控制台「隐私权做法」中填写该 URL，并与「数据安全」问卷一致（是否收集用户数据、是否加密传输等）。

---

## 4. 构建与上传包

```bash
cd apps/extension
# 确认 .env.production 中 PLASMO_PUBLIC_API_URL 与 package.json host_permissions 同源
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

### 5.1 本文档尚未逐条展开、但控制台常要求的项

上架时在开发者后台逐项核对（以 [Chrome Web Store 当前说明](https://developer.chrome.com/docs/webstore/) 为准）：

| 项 | 说明 |
|----|------|
| **隐私政策 HTTPS URL** | 仍缺独立页面时，**整条链路未闭环**（见 §3）。 |
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

- 解压安装与本地打包：[extension-packaging.md](extension-packaging.md)  
- 后端契约与部署：[architecture-as-built.md](architecture-as-built.md)  
- 功能清单（商店「说明」可摘录）：[product-features.md](product-features.md)  
- 根目录 [README.md](../README.md) 开发与配置摘要

---

## 8. 对照本文档，你还可能缺什么（汇总）

1. **公开隐私政策 URL**（HTTPS）— 商店硬门槛。  
2. **上架专用 zip**：去掉 `localhost` 的 `host_permissions`（若当前仍保留）。  
3. **截图与宣传图**— 按控制台尺寸现做。  
4. **审核备注 + 测试账号**— 登录型扩展强烈建议写清。  
5. **数据安全问卷**— 与隐私政策、实际行为（传评论文本、Token、调 AI）一致。  
6. **域名 + 证书（建议）**— 长期仍用裸 IP 时，接受可能被追问或要求补充材料的风险。  
7. **上架后 CORS**— 后端将 `chrome-extension://<扩展ID>` 加入白名单（见 [architecture-as-built.md](architecture-as-built.md) 与 `config.yaml` `cors_origins`）。
