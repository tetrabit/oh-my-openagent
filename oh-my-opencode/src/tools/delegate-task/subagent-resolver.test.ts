declare const require: (name: string) => any
const { describe, test, expect, beforeEach, afterEach, spyOn, mock } = require("bun:test")
import { resolveSubagentExecution } from "./subagent-resolver"
import type { DelegateTaskArgs } from "./types"
import type { ExecutorContext } from "./executor-types"
import * as logger from "../../shared/logger"

function createBaseArgs(overrides?: Partial<DelegateTaskArgs>): DelegateTaskArgs {
  return {
    description: "Run review",
    prompt: "Review the current changes",
    run_in_background: false,
    load_skills: [],
    subagent_type: "oracle",
    ...overrides,
  }
}

function createExecutorContext(agentsFn: () => Promise<unknown>): ExecutorContext {
  const client = {
    app: {
      agents: agentsFn,
    },
  } as ExecutorContext["client"]

  return {
    client,
    manager: {} as ExecutorContext["manager"],
    directory: "/tmp/test",
  }
}

describe("resolveSubagentExecution", () => {
  let logSpy: ReturnType<typeof spyOn> | undefined

  beforeEach(() => {
    mock.restore()
    logSpy = spyOn(logger, "log").mockImplementation(() => {})
  })

  afterEach(() => {
    logSpy?.mockRestore()
  })

  test("returns delegation error when agent discovery fails instead of silently proceeding", async () => {
    //#given
    const resolverError = new Error("agents API unavailable")
    const args = createBaseArgs()
    const executorCtx = createExecutorContext(async () => {
      throw resolverError
    })

    //#when
    const result = await resolveSubagentExecution(args, executorCtx, "sisyphus", "deep")

    //#then
    expect(result.agentToUse).toBe("")
    expect(result.categoryModel).toBeUndefined()
    expect(result.error).toBe("Failed to delegate to agent \"oracle\": agents API unavailable")
  })

  test("logs failure details when subagent resolution throws", async () => {
    //#given
    const args = createBaseArgs({ subagent_type: "review" })
    const executorCtx = createExecutorContext(async () => {
      throw new Error("network timeout")
    })

    //#when
    await resolveSubagentExecution(args, executorCtx, "sisyphus", "deep")

    //#then
    expect(logSpy).toHaveBeenCalledTimes(1)
    const callArgs = logSpy?.mock.calls[0]
    expect(callArgs?.[0]).toBe("[delegate-task] Failed to resolve subagent execution")
    expect(callArgs?.[1]).toEqual({
      requestedAgent: "review",
      parentAgent: "sisyphus",
      error: "network timeout",
    })
  })

  test("prefers agent override fallback_models over bundled fallback requirements", async () => {
    //#given
    const args = createBaseArgs({ subagent_type: "oracle" })
    const executorCtx = {
      ...createExecutorContext(async () => [
        {
          name: "oracle",
          mode: "subagent",
          model: { providerID: "openai", modelID: "gpt-5.2" },
        },
      ]),
      agentOverrides: {
        oracle: {
          fallback_models: [
            "google/gemini-3-pro-preview",
            "opencode/big-pickle",
          ],
        },
      },
    }

    //#when
    const result = await resolveSubagentExecution(args, executorCtx, "sisyphus", "deep")

    //#then
    expect(result.error).toBeUndefined()
    expect(result.fallbackChain).toEqual([
      { providers: ["google"], model: "gemini-3-pro-preview" },
      { providers: ["opencode"], model: "big-pickle" },
    ])
  })

  test("inherits fallback_models from the override category when agent fallback_models are unset", async () => {
    //#given
    const args = createBaseArgs({ subagent_type: "oracle" })
    const executorCtx = {
      ...createExecutorContext(async () => [
        {
          name: "oracle",
          mode: "subagent",
          model: { providerID: "openai", modelID: "gpt-5.2" },
        },
      ]),
      agentOverrides: {
        oracle: {
          category: "writing",
        },
      },
      userCategories: {
        writing: {
          fallback_models: [
            "google/gemini-3-flash-preview",
            "opencode/big-pickle",
          ],
        },
      },
    }

    //#when
    const result = await resolveSubagentExecution(args, executorCtx, "sisyphus", "deep")

    //#then
    expect(result.error).toBeUndefined()
    expect(result.fallbackChain).toEqual([
      { providers: ["google"], model: "gemini-3-flash-preview" },
      { providers: ["opencode"], model: "big-pickle" },
    ])
  })
})
