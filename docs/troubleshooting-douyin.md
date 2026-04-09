# 抖音 Web：回复/跟评排查

> 侧栏与 content 脚本行为说明；调试命令在 **抖音视频页** Console 执行（非扩展侧栏）。

## 行为说明（摘要）

- 点某条「回复」常是**底部同一输入区**进入「回复@昵称」态，不一定出现新 `textarea`；扩展会先点该行「回复」再写入。
- 侧栏「已回复」：成功写入输入框后即标已回复并 `mark-replied`；纯手打回复扩展会尝试用 `domSelfReplied` 识别。
- **视频跟评**：优先点 `.comment-input-inner-container` 内「留下你的精彩评论吧」占位，再写 `contenteditable`；不行则先**手点一次底部评论框**再试侧栏「评论」。
- **URL**：`/video/{id}` 与 `modal_id` 等同一条视频；信息流壳层为 `/`、`/jingxuan`、`/following`、`/friend`、`/explore`；搜索/用户主页不当作跟评页。侧栏对同一帖子身份的 `tabs.onUpdated` 会合并拉取。

## `poll { editables: 0 }` 很久

常见于精选 `/jingxuan?modal_id=` 大 DOM；扩展已从评论行向上找侧栏容器再扫 Shadow。请先**更新扩展并刷新页面**。

## 打开详细日志

```js
localStorage.setItem("yanling_debug_douyin_fill", "1")
```

刷新后点侧栏「回复」，看 Console 里 `[CommentCopilot][douyin][fill]`。关掉：`localStorage.removeItem("yanling_debug_douyin_fill")`。

侧栏黄色提示英文：`comment_not_found`、`reply_btn_not_found`、`reply_redirects_to_xigua`、`composer_needs_manual_open`、`insert_failed` 等与日志 `step` 对应。

## Console：枚举可编辑框（参考）

```js
(() => {
  const walk = (root, out, d = 0) => {
    if (d > 18) return
    root.querySelectorAll?.("textarea, input[type=text], [contenteditable=true]").forEach((el) => {
      const r = el.getBoundingClientRect?.()
      if (!r || r.width < 2) return
      out.push({
        tag: el.tagName,
        ph: el.placeholder || "",
        cls: (el.className && String(el.className).slice(0, 60)) || "",
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
      })
    })
    root.querySelectorAll?.("*").forEach((n) => n.shadowRoot && walk(n.shadowRoot, out, d + 1))
  }
  const o = []
  walk(document, o)
  return o.sort((a, b) => b.bottom - a.bottom)
})()
```

## Console：统计 light / shadow / iframe 内可编辑数量

先**手动**点一条评论的「回复」，底部出现输入条后执行：

```js
(() => {
  let light = 0,
    sh = 0,
    ifr = []
  const ok = (el) => {
    const r = el.getBoundingClientRect?.()
    return r && r.width > 2 && r.height > 2
  }
  const count = (root) => {
    let n = 0
    root.querySelectorAll?.("textarea, input, [contenteditable]").forEach((el) => {
      if (ok(el)) n++
    })
    return n
  }
  light = count(document)
  const walk = (node, d) => {
    if (d > 22) return
    if (node.shadowRoot) {
      sh += count(node.shadowRoot)
      node.shadowRoot.querySelectorAll("*").forEach((c) => walk(c, d + 1))
    }
    node.children?.forEach?.((c) => walk(c, d + 1))
  }
  walk(document.documentElement, 0)
  document.querySelectorAll("iframe").forEach((fr, i) => {
    try {
      const d = fr.contentDocument
      ifr.push({ i, ok: !!d, n: d ? count(d) : null })
    } catch (e) {
      ifr.push({ i, ok: false, crossOrigin: true })
    }
  })
  return { light, openShadow: sh, iframeEditableCounts: ifr, total: light + sh + ifr.reduce((s, x) => s + (x.n || 0), 0) }
})()
```

- **`total > 0`**：扩展理论上能写到 DOM；未点「回复」就一直是 `editables: 0` 时，多为须**先手点**该行「回复」。
- **手动点回复后仍 `total === 0`**：可能在 closed shadow 或跨域 iframe，页面脚本也拿不到。

## 实现细节（采集/DOM）

抖音 `douyin.ts`：Shadow 穿透**逆序入栈**以保文档序；正文优先 `.Vrj4Q3zT > .C7LroK_h`；剔除评论行内碎片根、保留 `.EpsntdUI` 线程宿主；`PAGE_COMMENTS_DOM_CHANGED` 触发侧栏重拉；虚拟列表用 `postUrl` 维度累积 id。详见源码注释。
