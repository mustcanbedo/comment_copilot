/**
 * 三端 content script 共用：ingest 去重、fingerprint 哈希。
 * 平台特有 DOM 逻辑仍留在 xiaohongshu / bilibili / douyin 各自文件内。
 */

/** 生成稳定短字符串（评论 id 兜底 fingerprint），与历史实现一致 */
export function simpleHash(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

export type PlatformCommentLike = { platformCommentId: string }

const DEFAULT_SEEN_MAX = 3000
const TRIM_TARGET_RATIO = 0.7

/**
 * 评论 ingest 去重：同一标签内已上报过的 platformCommentId 不再重复发 COMMENTS_COLLECTED；
 * 超过上限时按当前批次 keep 集合淘汰旧 id（与 bilibili/douyin 原逻辑一致）。
 */
export function createCommentIngestDeduper(maxSize: number = DEFAULT_SEEN_MAX) {
  const seenIds = new Set<string>()

  function trimSeenIds(keep: Set<string>) {
    if (seenIds.size <= maxSize) return
    for (const id of seenIds) {
      if (!keep.has(id)) seenIds.delete(id)
      if (seenIds.size <= maxSize * TRIM_TARGET_RATIO) break
    }
  }

  return {
    /** 返回本批中首次出现的评论（并已记入 seen） */
    collectFresh<T extends PlatformCommentLike>(comments: T[]): T[] {
      const fresh: T[] = []
      const keep = new Set<string>()
      for (const c of comments) {
        keep.add(c.platformCommentId)
        if (!seenIds.has(c.platformCommentId)) {
          seenIds.add(c.platformCommentId)
          fresh.push(c)
        }
      }
      trimSeenIds(keep)
      return fresh
    },
    clear() {
      seenIds.clear()
    },
  }
}

/** 侧栏 / background 约定的填入结果（不含扩展字段，便于 TS 收窄） */
export type ContentFillResult = {
  ok: boolean
  error?: string
  step?: string
}

export type ThrottledScanOptions = {
  /** 用于 `console.error` 前缀，如 `xhs` / `bilibili` / `douyin` */
  label?: string
}

/**
 * MutationObserver 用节流扫描：窗口内多次 DOM 变动只执行一次 `scan`。
 * `scan` 可为 sync 或 async。须同时兜住：
 * - 同步 throw（`Promise.resolve(scan())` 的 `.catch` **接不到**，因 throw 发生在入参求值阶段）
 * - async 内未捕获的 rejection
 * 行为与原先各端手写 `setTimeout + void promise` 一致，仅集中错误处理。
 */
export function createThrottledScan(
  throttleMs: number,
  scan: () => void | Promise<void>,
  options?: ThrottledScanOptions
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const label = options?.label ?? "content"
  return () => {
    if (timer != null) return
    timer = setTimeout(() => {
      timer = null
      void (async () => {
        try {
          await scan()
        } catch (e) {
          console.error(`[CommentCopilot][${label}] throttled scan`, e)
        }
      })()
    }, throttleMs)
  }
}
