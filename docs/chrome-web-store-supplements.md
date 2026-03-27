# Chrome 网上应用店 — 上架辅助稿

> 对应 [chrome-web-store.md](chrome-web-store.md) 汇总项 **2 / 4 / 5 / 6**：工程内可脚本化的步骤 + 可直接粘贴/对照的文案与问卷要点。  
> **测试账号**与**商店控制台实际选项**须你方填写；若 Google 改版表单项，以控制台为准。

---

## 1. 上架专用 zip（不含 localhost）

日常 `package.json` 可保留 `http://localhost:3000/*` 便于本地开发；**提交商店的 zip** 须去掉该项。

在 `apps/extension` 下执行（脚本会临时改写 `package.json`、构建结束后自动还原）：

```bash
cd apps/extension
# 确认 .env.production 中 PLASMO_PUBLIC_API_URL 与「非 localhost」的 API host_permissions 一致
npm run package:store
```

产物仍为 **`build/chrome-mv3-prod.zip`**。上传前可解压检查根目录 `manifest.json` 的 `host_permissions` 中**无** `localhost`。

实现脚本：[apps/extension/scripts/package-for-store.mjs](../apps/extension/scripts/package-for-store.mjs)。

---

## 2. 商品说明文案（粘贴用）

以下与 [product-features.md](product-features.md) 一致取向；可按字数限制在控制台内微调。

### 2.1 短说明（摘要栏）

若控制台有字数上限，可优先用更短版本：

**较短**：言灵 Yanling 在小红书、哔哩哔哩、抖音网页端辅助阅读评论、生成回复与跟评建议；需注册账号并配合运营方后端服务，不自动代发。

**稍详**：言灵 Yanling 是 Chrome 侧栏扩展：在支持站点读取当前页可见评论与展示内容，同步至侧栏列表，由 AI 生成回复或主评建议并一键填入输入框；须登录与积分，不自动发帖。详见完整说明。

### 2.2 详细说明（商品页「说明」）

```
言灵 Yanling 面向内容创作者，在网页端辅助处理评论区工作。

【支持站点】
小红书、哔哩哔哩、抖音等（以安装时权限与当前版本为准）。

【主要功能】
• 侧栏展示与刷新当前页面的评论列表，与标签页切换联动。
• 按意向或状态筛选评论（如高意向、待处理）。
• 对单条评论生成 AI 回复建议，一键填入站点自带的回复框；不会自动点击发送。
• 对笔记/视频生成「主跟评」文案建议，填入底部评论输入区；同样需用户手动发送。
• 收藏与管理常用 AI 话术（存言）。
• 账户与积分展示、意见反馈入口。

【使用前提】
须使用邮箱等方式注册言灵账号，并连接运营方提供的后端 API（HTTPS）。积分用于 AI 调用等能力，以产品内展示为准。

【合规说明】
本产品为用户辅助工具：不宣称绕过平台安全机制、不批量自动代发。请遵守各第三方平台服务条款。向自有服务器传输的数据范围见公开隐私政策。

【半成品提示】
部分设置项或入口为占位或未完全接通支付等能力，以当前版本界面为准。
```

### 2.3 英文简介（可选）

**Short**: Yanling is a Chrome side panel helper for Xiaohongshu, Bilibili, and Douyin: it lists on-page comments, suggests replies or main comments via AI, and fills the site’s own input boxes—never auto-posts. Requires an account and operator-hosted API.

**Note**: 若商店只要求一种语言，可仅用中文说明。

---

## 3. 审核备注 + 测试账号（粘贴模板）

将下方整块粘贴到开发者控制台「审核备注 / 给审核员的信息」等字段，并**替换括号**内容。

```
【产品说明】
本扩展为 Manifest V3，单用途：在已声明的小红书 / 哔哩哔哩 / 抖音网页上，读取当前页面向用户已展示的可见内容，在侧栏展示评论列表，并调用我方 HTTPS 后端与第三方 AI（DeepSeek）生成文本建议；建议仅填入页面自带输入框，由用户手动发送，扩展不自动发帖。

【如何测试】
1. 安装扩展后，使用下方测试账号登录侧栏。
2. 在已登录对应平台账号的前提下，打开任意支持站点的内容详情页（含评论区域）。
3. 打开 Chrome 侧栏中的言灵面板，应能看到评论列表；选择评论可生成建议并尝试「填入」到页面输入框（无需实际发布）。

【测试账号】
邮箱：（请填写专用测试账号邮箱）
密码：（请填写）
说明：该账号仅供审核，内含测试积分/数据；请勿用于生产。

【隐私政策】
（粘贴 yanling 仓库隐私政策 URL）
https://github.com/mustcanbedo/yanling/blob/main/docs/privacy-policy.md

【远程代码】
扩展不包含运行时下载执行的远程脚本；业务逻辑为打包静态资源，仅通过 HTTPS 与自有 API 及 AI 接口交换 JSON。
```

**说明**：若暂时无法提供测试账号，须改写「如何测试」一节，写清无账号时审核员可见的界面范围（例如仅登录页/空状态），并接受可能被拒审或补件的风险。

---

## 4. 数据安全 / 隐私做法问卷（对照稿）

以下按常见 Google 控制台逻辑组织，**选项名称以你看到的英文/中文界面为准**。填写须与 [yanling 隐私政策](https://github.com/mustcanbedo/yanling/blob/main/docs/privacy-policy.md) 及实际行为一致。

| 主题 | 建议答法要点 |
|------|----------------|
| **是否处理用户数据** | 是。含账户邮箱（及可选昵称）、用户主动使用功能时涉及的页面可见文本（评论、链接等）、登录令牌在本地存储中的保存。 |
| **收集目的** | 提供账户与计费、侧栏评论展示与同步、生成 AI 建议、客服与安全保障等；不作无关营销售卖。 |
| **用户生成内容** | 是；评论文本等来自用户浏览情境下页面已展示内容，用于上述功能。 |
| **传输加密** | 与自有服务器通信为 HTTPS；向 DeepSeek 的调用为 HTTPS（与政策一致）。 |
| **是否与第三方共享** | 为生成建议，会将组装后的必要文本发送至 **DeepSeek**（第三方 AI）；基础设施云服务商可能接触托管数据。不在此列「出售用户数据给广告主」类场景。 |
| **用户删除 / 联系** | 政策中已提供邮件/产品内反馈路径；可答支持用户联系删除或按流程注销（与政策第六节一致）。 |
| **敏感权限** | `storage`、`tabs`/`activeTab`、`sidePanel`、`scripting`、声明站点的 `host_permissions`；与 manifest 及商店「权限说明」一致。 |

若控制台单独询问 **Health / Financial** 等类别，本产品一般均选「不收集」或「不适用」，除非你们实际扩展了相关功能。

---

## 5. 与 `PLASMO_PUBLIC_API_URL` 对齐自检

| 检查 | 说明 |
|------|------|
| `.env.production` | `PLASMO_PUBLIC_API_URL` 的 origin（协议+主机+端口）应对应 `package.json` 里**非 localhost** 的那条 `host_permissions`。 |
| 改 API 域名/IP | 同时改 `package.json`、`apps/extension/.env.production`，再执行 `npm run package:store` 打商店包。 |
