import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  createCommentIngestDeduper,
  createThrottledScan,
  simpleHash,
} from "./platform-content-utils"

describe("simpleHash", () => {
  it("returns non-empty deterministic string", () => {
    expect(simpleHash("hello")).toBe(simpleHash("hello"))
    expect(simpleHash("hello").length).toBeGreaterThan(0)
    expect(simpleHash("a")).not.toBe(simpleHash("b"))
  })
})

describe("createCommentIngestDeduper", () => {
  it("emits only new ids", () => {
    const d = createCommentIngestDeduper(100)
    type Row = { platformCommentId: string; v: number }
    expect(d.collectFresh<Row>([{ platformCommentId: "a", v: 1 }])).toEqual([{ platformCommentId: "a", v: 1 }])
    expect(d.collectFresh<Row>([{ platformCommentId: "a", v: 2 }])).toEqual([])
    expect(d.collectFresh<Row>([{ platformCommentId: "b", v: 1 }])).toEqual([{ platformCommentId: "b", v: 1 }])
  })

  it("clear resets state", () => {
    const d = createCommentIngestDeduper(100)
    d.collectFresh([{ platformCommentId: "x" }])
    d.clear()
    expect(d.collectFresh([{ platformCommentId: "x" }])).toEqual([{ platformCommentId: "x" }])
  })
})

describe("createThrottledScan", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("coalesces rapid triggers into one run", async () => {
    let n = 0
    const run = createThrottledScan(
      100,
      () => {
        n++
      },
      { label: "t" },
    )
    run()
    run()
    run()
    expect(n).toBe(0)
    await vi.advanceTimersByTimeAsync(100)
    expect(n).toBe(1)
  })

  it("await async scan before next window", async () => {
    let phase = 0
    const run = createThrottledScan(50, async () => {
      phase++
      await Promise.resolve()
    })
    run()
    await vi.advanceTimersByTimeAsync(50)
    expect(phase).toBe(1)
    run()
    await vi.advanceTimersByTimeAsync(50)
    expect(phase).toBe(2)
  })

  it("logs on async rejection without throwing", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const run = createThrottledScan(
      30,
      async () => {
        throw new Error("boom")
      },
      { label: "test" },
    )
    run()
    await vi.advanceTimersByTimeAsync(30)
    await Promise.resolve()
    await Promise.resolve()
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })

  it("logs on synchronous throw from non-async scan", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const run = createThrottledScan(20, () => {
      throw new Error("sync-boom")
    })
    run()
    await vi.advanceTimersByTimeAsync(20)
    await Promise.resolve()
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })
})
