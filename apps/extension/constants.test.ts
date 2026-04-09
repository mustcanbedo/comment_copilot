import { describe, expect, it } from "vitest"
import {
  canonicalDouyinPostUrl,
  commentCopilotPlatformFromUrl,
  commentCopilotTabFetchDedupeKey,
  getCommentCopilotPageKind,
  isBilibiliVideoPageUrl,
  isCommentCopilotPageUrl,
  isDouyinModalSurfaceUrl,
  isDouyinVideoPageUrl,
  parseDouyinNumericVideoId,
  isXhsNotePageUrl,
} from "./constants"

describe("isXhsNotePageUrl", () => {
  it("matches explore and discovery item paths", () => {
    expect(isXhsNotePageUrl("https://www.xiaohongshu.com/explore/abc123")).toBe(true)
    expect(isXhsNotePageUrl("https://www.xiaohongshu.com/discovery/item/xyz9")).toBe(true)
  })
  it("rejects non-note pages", () => {
    expect(isXhsNotePageUrl("https://www.xiaohongshu.com/")).toBe(false)
    expect(isXhsNotePageUrl("https://www.bilibili.com/video/BV1")).toBe(false)
    expect(isXhsNotePageUrl("")).toBe(false)
  })
})

describe("isBilibiliVideoPageUrl", () => {
  it("matches BV and av", () => {
    expect(isBilibiliVideoPageUrl("https://www.bilibili.com/video/BV1a2b3c4d5e")).toBe(true)
    expect(isBilibiliVideoPageUrl("https://bilibili.com/video/av170001")).toBe(true)
  })
  it("rejects non-video", () => {
    expect(isBilibiliVideoPageUrl("https://www.bilibili.com/")).toBe(false)
    expect(isBilibiliVideoPageUrl("https://www.bilibili.com/bangumi/play/ep1")).toBe(false)
  })
})

describe("isDouyinVideoPageUrl", () => {
  it("matches /video/id", () => {
    expect(isDouyinVideoPageUrl("https://www.douyin.com/video/7123456789012345678")).toBe(true)
  })
  it("matches modal_id / aweme_id query (snowflake length)", () => {
    expect(isDouyinVideoPageUrl("https://www.douyin.com/jingxuan?modal_id=7123456789012345678")).toBe(true)
    expect(
      isDouyinVideoPageUrl("https://www.douyin.com/?aweme_id=7123456789012345678"),
    ).toBe(true)
  })
  it("rejects too-short numeric ids in query", () => {
    expect(isDouyinVideoPageUrl("https://www.douyin.com/?aweme_id=99")).toBe(false)
  })
  it("rejects without numeric id (strict video URL)", () => {
    expect(isDouyinVideoPageUrl("https://www.douyin.com/")).toBe(false)
    expect(isDouyinVideoPageUrl("https://www.douyin.com/jingxuan?foo=bar")).toBe(false)
    expect(isDouyinVideoPageUrl("https://www.douyin.com/jingxuan")).toBe(false)
  })
})

describe("parseDouyinNumericVideoId", () => {
  it("reads modal_id from hash", () => {
    expect(parseDouyinNumericVideoId("https://www.douyin.com/jingxuan#modal_id=7606935500858985771")).toBe(
      "7606935500858985771",
    )
  })
})

describe("isDouyinModalSurfaceUrl / getCommentCopilotPageKind", () => {
  it("treats jingxuan shell without modal_id as douyin context for sidebar", () => {
    expect(isDouyinModalSurfaceUrl("https://www.douyin.com/jingxuan")).toBe(true)
    expect(isDouyinVideoPageUrl("https://www.douyin.com/jingxuan")).toBe(false)
    expect(getCommentCopilotPageKind("https://www.douyin.com/jingxuan")).toBe("douyin-video")
    expect(isCommentCopilotPageUrl("https://www.douyin.com/jingxuan")).toBe(true)
  })
  it("does not treat search or user profile as modal feed shell", () => {
    expect(isDouyinModalSurfaceUrl("https://www.douyin.com/search/foo")).toBe(false)
    expect(isDouyinModalSurfaceUrl("https://www.douyin.com/user/MS4wLjABAAAA_test")).toBe(false)
    expect(getCommentCopilotPageKind("https://www.douyin.com/search/foo")).toBe(null)
  })
})

describe("commentCopilotTabFetchDedupeKey", () => {
  it("maps douyin URLs to canonical post for dedupe", () => {
    const a = "https://www.douyin.com/jingxuan?modal_id=7123456789012345678"
    const b = "https://www.douyin.com/video/7123456789012345678"
    expect(commentCopilotTabFetchDedupeKey(a)).toBe(commentCopilotTabFetchDedupeKey(b))
  })
  it("differs when douyin modal id changes", () => {
    const a = "https://www.douyin.com/jingxuan?modal_id=7123456789012345678"
    const c = "https://www.douyin.com/jingxuan?modal_id=7123456789012345679"
    expect(commentCopilotTabFetchDedupeKey(a)).not.toBe(commentCopilotTabFetchDedupeKey(c))
  })
})

describe("canonicalDouyinPostUrl", () => {
  it("normalizes query id to /video/id", () => {
    expect(canonicalDouyinPostUrl("https://www.douyin.com/jingxuan?modal_id=7123456789012345678")).toBe(
      "https://www.douyin.com/video/7123456789012345678",
    )
  })
  it("leaves /video/ path as canonical origin + path", () => {
    expect(canonicalDouyinPostUrl("https://www.douyin.com/video/7123456789012345678")).toBe(
      "https://www.douyin.com/video/7123456789012345678",
    )
  })
  it("returns original url when no video id (e.g. bare jingxuan)", () => {
    const u = "https://www.douyin.com/jingxuan"
    expect(canonicalDouyinPostUrl(u)).toBe(u)
  })
})

describe("getCommentCopilotPageKind / isCommentCopilotPageUrl", () => {
  it("returns single kind by priority xhs > bilibili > douyin", () => {
    expect(getCommentCopilotPageKind("https://www.xiaohongshu.com/explore/n1")).toBe("xhs-note")
    expect(getCommentCopilotPageKind("https://www.bilibili.com/video/BV1test")).toBe("bilibili-video")
    expect(getCommentCopilotPageKind("https://www.douyin.com/video/7123456789012345678")).toBe("douyin-video")
    expect(getCommentCopilotPageKind("https://example.com")).toBe(null)
    expect(isCommentCopilotPageUrl("https://www.douyin.com/video/7123456789012345678")).toBe(true)
    expect(isCommentCopilotPageUrl("https://google.com")).toBe(false)
  })
})

describe("commentCopilotPlatformFromUrl", () => {
  it("maps hosts", () => {
    expect(commentCopilotPlatformFromUrl("https://www.bilibili.com/video/BV1")).toBe("bilibili")
    expect(commentCopilotPlatformFromUrl("https://www.douyin.com/video/1")).toBe("douyin")
    expect(commentCopilotPlatformFromUrl("https://www.xiaohongshu.com/explore/x")).toBe("xiaohongshu")
    expect(commentCopilotPlatformFromUrl(null)).toBe("xiaohongshu")
  })
})
