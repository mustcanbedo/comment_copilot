---
name: build-chrome-extension
description: 使用 Plasmo 框架实现 Comment Copilot Chrome 插件，包含三层架构、消息通信、侧边栏 UI 和认证流程。当开发插件功能、搭建插件架构、实现插件 UI 或消息通信时使用。
---

# Chrome 插件开发（Plasmo）

## 三层职责（禁止混用）

| 层 | 路径 | 职责 | 禁止 |
|---|---|---|---|
| content | `apps/extension/content/` | DOM 解析、评论提取、注入浮层 | 直接调用外部 API |
| background | `apps/extension/background/` | API 通信、token 管理、消息路由 | 操作 DOM |
| sidebar | `apps/extension/sidebar/` | React UI、展示评论和回复 | 直接访问 DOM |

## 消息通信模式

```typescript
// content → background（发送采集到的评论）
chrome.runtime.sendMessage({ type: 'COMMENTS_COLLECTED', payload: comments });

// background → API（带 JWT）
chrome.storage.local.get('token', ({ token }) => {
  fetch(`${API_BASE}/ingest/comments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(encryptPayload(payload)),
  });
});

// background → sidebar（推送 AI 回复结果）
chrome.runtime.sendMessage({ type: 'AI_REPLY_READY', payload: reply });
```

## Plasmo 文件约定

```
apps/extension/
  contents/
    xiaohongshu.ts    # @match https://www.xiaohongshu.com/*
    douyin.ts         # @match https://www.douyin.com/*
  background.ts       # service worker
  sidepanel.tsx       # 侧边栏主入口
  popup.tsx           # 点击图标的弹窗（登录状态）
```

## 侧边栏 UI 组件结构

```typescript
// sidepanel.tsx
export default function SidePanel() {
  const [comments, setComments] = useState<Comment[]>([]);
  // 监听 background 推送
  useEffect(() => {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === 'COMMENTS_UPDATE') setComments(msg.payload);
    });
  }, []);
  return <CommentList comments={comments} />;
}
```

## 认证流程

1. popup 检测未登录 → 打开 web-admin 登录页
2. 登录成功后，web-admin 调用 `chrome.runtime.sendMessage({ type: 'AUTH_TOKEN', token })`
3. background 存入 `chrome.storage.local`，后续请求携带

## 本地开发

```bash
cd apps/extension
pnpm dev        # Plasmo 热重载
# 加载：chrome://extensions → 开发者模式 → 加载已解压 → build/chrome-mv3-dev
```
