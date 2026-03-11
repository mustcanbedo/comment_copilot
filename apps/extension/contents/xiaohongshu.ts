import type { PlasmoCSConfig } from "plasmo"

export const config: PlasmoCSConfig = {
  matches: ["https://www.xiaohongshu.com/*"]
}

interface ScrapedComment {
  platformCommentId: string
  authorName: string
  content: string
  commentedAt: string
}

const SELECTOR_COMMENT_ITEM = ".note-comment-card" // TODO: 根据真实 DOM 调整

function scrapeComments(): ScrapedComment[] {
  const nodes = document.querySelectorAll(SELECTOR_COMMENT_ITEM)
  const results: ScrapedComment[] = []
  nodes.forEach((node) => {
    const el = node as HTMLElement
    const author = el.querySelector(".author") as HTMLElement
    const content = el.querySelector(".content") as HTMLElement
    if (!author || !content) return
    results.push({
      platformCommentId: el.getAttribute("data-comment-id") || "",
      authorName: author.innerText.trim(),
      content: content.innerText.trim(),
      commentedAt: new Date().toISOString()
    })
  })
  return results
}

window.addEventListener("load", () => {
  setTimeout(() => {
    const comments = scrapeComments()
    if (!comments.length) return
    chrome.runtime.sendMessage({
      type: "COMMENTS_COLLECTED",
      payload: {
        platform: "xiaohongshu",
        comments
      }
    })
  }, 3000)
})
