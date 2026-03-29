const { describe, test, expect, mock, beforeEach, afterEach } = require("bun:test")
// Ensure clean mock state to prevent contamination from other test files in the same worker
mock.restore()
describe("task tool metadata awaiting", () => {
  beforeEach(() => { mock.restore() })
  afterEach(() => { mock.restore() })
  test("executeBackgroundTask awaits ctx.metadata before returning", async () => {
    // given
    const { executeBackgroundTask } = await import("./executor")
    let metadataResolved = false
    const abort = new AbortController()

    const ctx: ToolContextWithMetadata = {
      sessionID: "ses_parent",
      messageID: "msg_parent",
      agent: "sisyphus",
      abort: abort.signal,
      metadata: async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 50))
        metadataResolved = true
      },
    }

    const args: DelegateTaskArgs = {
      load_skills: [],
      description: "Test task",
      prompt: "Do something",
      run_in_background: true,
      subagent_type: "explore",
    }

    const executorCtx = {
      manager: {
        launch: async () => ({
          id: "task_1",
          description: "Test task",
          prompt: "Do something",
          agent: "explore",
          status: "pending",
          sessionID: "ses_child",
        }),
        getTask: () => undefined,
      },
    } as any

    const parentContext = {
      sessionID: "ses_parent",
      messageID: "msg_parent",
    }

    // when
    const result = await executeBackgroundTask(
      args,
      ctx,
      executorCtx,
      parentContext,
      "explore",
      undefined,
      undefined,
    )

    // then
    expect(result).toContain("Background task launched")
    expect(metadataResolved).toBe(true)
  })
})
