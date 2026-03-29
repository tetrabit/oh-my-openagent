import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { createAutoRetryHelpers } from "./auto-retry"
import type { HookDeps } from "./types"

function createDeps(
  toastCalls: Array<{ title: string; message: string; variant: string; duration: number }>,
  promptCalls: unknown[],
): HookDeps {
  return {
    ctx: {
      client: {
        session: {
          abort: async () => ({}),
          messages: async () => ({
            data: [{ info: { role: "user" }, parts: [{ type: "text", text: "retry this request" }] }],
          }),
          promptAsync: async (args: unknown) => {
            promptCalls.push(args)
            return {}
          },
        },
        tui: {
          showToast: async (opts) => {
            toastCalls.push({
              title: opts.body.title,
              message: opts.body.message,
              variant: opts.body.variant,
              duration: opts.body.duration,
            })
            return {}
          },
        },
      },
      directory: "/test/dir",
    },
    config: {
      enabled: true,
      retry_on_errors: [429, 503, 529],
      max_fallback_attempts: 3,
      cooldown_seconds: 60,
      timeout_seconds: 30,
      notify_on_fallback: false,
    },
    options: undefined,
    pluginConfig: {},
    sessionStates: new Map(),
    sessionLastAccess: new Map(),
    sessionRetryInFlight: new Set(),
    sessionAwaitingFallbackResult: new Set(),
    sessionFallbackTimeouts: new Map(),
    sessionTokenRefreshRetryCounts: new Map(),
  }
}

describe("createAutoRetryHelpers token refresh retry toast", () => {
  let sleepSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    sleepSpy = spyOn(Bun, "sleep").mockImplementation(async () => undefined)
  })

  afterEach(() => {
    sleepSpy.mockRestore()
  })

  it("shows a toast when scheduling a token refresh retry", async () => {
    const toastCalls: Array<{ title: string; message: string; variant: string; duration: number }> = []
    const promptCalls: unknown[] = []
    const deps = createDeps(toastCalls, promptCalls)
    const helpers = createAutoRetryHelpers(deps)

    const result = await helpers.retryCurrentModelAfterTokenRefreshFailure(
      "session-token-refresh-toast",
      "openai/gpt-5.4",
      undefined,
      "session.error",
    )

    expect(result).toBe("retry-dispatched")
    expect(promptCalls).toHaveLength(1)
    expect(toastCalls).toEqual([
      {
        title: "Token Refresh Retry",
        message: "Retrying gpt-5.4 in 0.5s (attempt 1/4).",
        variant: "warning",
        duration: 5000,
      },
    ])
  })
})
