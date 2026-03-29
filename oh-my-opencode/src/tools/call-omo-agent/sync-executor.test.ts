const { describe, test, expect, mock } = require("bun:test")

describe("executeSync", () => {
  test("passes question=false via tools parameter to block question tool", async () => {
    //#given
    const { executeSync } = require("./sync-executor")

    const deps = {
      createOrGetSession: mock(async () => ({ sessionID: "ses-test-123", isNew: true })),
      waitForCompletion: mock(async () => {}),
      processMessages: mock(async () => "agent response"),
    }

    let promptArgs: any
    const promptAsync = mock(async (input: any) => {
      promptArgs = input
      return { data: {} }
    })

    const args = {
      subagent_type: "explore",
      description: "test task",
      prompt: "find something",
    }

    const toolContext = {
      sessionID: "parent-session",
      messageID: "msg-1",
      agent: "sisyphus",
      abort: new AbortController().signal,
      metadata: mock(async () => {}),
    }

    const ctx = {
      client: {
        session: { promptAsync },
      },
    }

    //#when
    await executeSync(args, toolContext, ctx as any, deps)

    //#then
    expect(promptAsync).toHaveBeenCalled()
    expect(promptArgs.body.tools.question).toBe(false)
  })

  test("passes task=false via tools parameter", async () => {
    //#given
    const { executeSync } = require("./sync-executor")

    const deps = {
      createOrGetSession: mock(async () => ({ sessionID: "ses-test-123", isNew: true })),
      waitForCompletion: mock(async () => {}),
      processMessages: mock(async () => "agent response"),
    }

    let promptArgs: any
    const promptAsync = mock(async (input: any) => {
      promptArgs = input
      return { data: {} }
    })

    const args = {
      subagent_type: "librarian",
      description: "search docs",
      prompt: "find docs",
    }

    const toolContext = {
      sessionID: "parent-session",
      messageID: "msg-2",
      agent: "sisyphus",
      abort: new AbortController().signal,
      metadata: mock(async () => {}),
    }

    const ctx = {
      client: {
        session: { promptAsync },
      },
    }

    //#when
    await executeSync(args, toolContext, ctx as any, deps)

    //#then
    expect(promptAsync).toHaveBeenCalled()
    expect(promptArgs.body.tools.task).toBe(false)
  })

  test("retries prompt startup with explicit fallback models when the initial model aborts", async () => {
    //#given
    const { executeSync } = require("./sync-executor")

    const promptCalls: any[] = []
    const deps = {
      createOrGetSession: mock(async () => ({ sessionID: "ses-test-123", isNew: true })),
      waitForCompletion: mock(async () => {}),
      processMessages: mock(async () => "agent response"),
      promptWithModelSuggestionRetry: mock(async (_client: any, input: any) => {
        promptCalls.push(input)
        if (promptCalls.length === 1) {
          const error = new Error("rate limit while sending prompt")
          error.name = "MessageAbortedError"
          throw error
        }
      }),
    }

    const args = {
      subagent_type: "explore",
      description: "test task",
      prompt: "find something",
    }

    const toolContext = {
      sessionID: "parent-session",
      messageID: "msg-1",
      agent: "sisyphus",
      abort: new AbortController().signal,
      metadata: mock(async () => {}),
    }

    const ctx = {
      client: {
        session: {
          promptAsync: mock(async () => ({ data: {} })),
        },
      },
    }

    //#when
    const result = await executeSync(
      args,
      toolContext,
      ctx as any,
      deps as any,
      {
        fallbackChain: [
          { providers: ["opencode"], model: "gpt-5-nano" },
          { providers: ["anthropic"], model: "claude-haiku-4-5" },
        ],
      },
    )

    //#then
    expect(result).toContain("agent response")
    expect(promptCalls).toHaveLength(2)
    expect(promptCalls[1].body.model).toEqual({
      providerID: "opencode",
      modelID: "gpt-5-nano",
    })
  })
})
