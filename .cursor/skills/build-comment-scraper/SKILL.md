---
name: build-comment-scraper
description: 实现 Chrome 插件侧的评论抓取功能，包括各平台 DOM 选择器、MutationObserver、IndexedDB 去重、加密上报和限流策略。当实现评论采集、DOM 解析、插件 content script、上报逻辑时使用。
---

# 评论抓取（Content Script）

## 平台 DOM 选择器（随版本可能变化，需加监控）

```typescript
const SELECTORS = {
  xiaohongshu: {
    commentList: '.comments-container .comment-item',
    author: '.user-name',
    content: '.comment-content',
    commentId: '[data-comment-id]', // attr: data-comment-id
  },
  douyin: {
    commentList: '.comment-item-wrapper',
    author: '.user-name',
    content: '.text',
    commentId: '[data-e2e="comment-item"]', // attr: data-comment-id
  },
};
```

## 抓取流程

```
MutationObserver 监听评论列表 DOM 增量
  ↓
解析结构化字段（id, author, content, timestamp, parentId）
  ↓
本地去重（Bloom Filter / Set 检查 platform_comment_id）
  ↓
写入 IndexedDB 缓冲区
  ↓
定时批量（≤50条）AES-GCM 加密 → POST /ingest/comments
  ↓
失败：指数退避重试，离线时缓存至 IndexedDB
```

## MutationObserver 实现

```typescript
const observer = new MutationObserver(throttle((mutations) => {
  const newNodes = mutations.flatMap(m => Array.from(m.addedNodes));
  const comments = newNodes
    .filter(n => n.matches?.(SELECTORS[platform].commentList))
    .map(parseCommentNode);
  if (comments.length) bufferAndSend(comments);
}, 2000)); // 节流 2s，高峰期 5s

observer.observe(document.querySelector('.comments-container'), {
  childList: true, subtree: true
});
```

## 上报数据结构

```typescript
interface IngestPayload {
  videoId: string;         // 从当前页面 URL 解析
  platform: string;
  comments: Array<{
    platformCommentId: string;
    parentCommentId?: string;
    authorName: string;
    authorId: string;
    content: string;
    commentedAt: string;   // ISO 8601
  }>;
  idempotencyKey: string;  // `${videoId}:${batchIndex}`
}
```

## 限流与降级

- 默认 1 请求 / 2s；账号被限流时切换为 1 请求 / 10s
- 高峰模式：只采集意向关键词命中的评论（本地关键词库过滤）
- 平台返回 429/banned → 立即暂停，通过 `chrome.runtime.sendMessage` 告警

## 去重策略

```typescript
// IndexedDB 存储已上报的 platformCommentId Set，TTL 7天
const seen = await idb.get<Set<string>>('reported_ids');
const newComments = comments.filter(c => !seen.has(c.platformCommentId));
```
