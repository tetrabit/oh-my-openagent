declare const require: (name: string) => any
const { describe, test, expect, beforeEach, mock } = require("bun:test")
import { resolveSubagentExecution } from "./subagent-resolver"
import type { DelegateTaskArgs } from "./types"
import type { ExecutorContext } from "./executor-types"

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

function createExecutorContext(
  agentsFn: () => Promise<unknown>,
  overrides?: Partial<ExecutorContext>,
): ExecutorContext {
  const client = {
    app: {
      agents: agentsFn,
    },
  } as ExecutorContext["client"]

  return {
    client,
    manager: {} as ExecutorContext["manager"],
    directory: "/tmp/test",
    connectedProvidersOverride: null,
    availableModelsOverride: new Set(),
    ...overrides,
  }
}

describe("resolveSubagentExecution", () => {
  beforeEach(() => {
    mock.restore()
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

  test("returns a stable delegation error when subagent resolution throws", async () => {
    //#given
    const args = createBaseArgs({ subagent_type: "review" })
    const executorCtx = createExecutorContext(async () => {
      throw new Error("network timeout")
    })

    //#when
    const result = await resolveSubagentExecution(args, executorCtx, "sisyphus", "deep")

    //#then
    expect(result.error).toBe('Failed to delegate to agent "review": network timeout')
  })

  test("normalizes matched agent model string before returning categoryModel", async () => {
    //#given
    const args = createBaseArgs({ subagent_type: "oracle" })
    const executorCtx = createExecutorContext(
      async () => ([
        { name: "oracle", mode: "subagent", model: "openai/gpt-5.3-codex" },
      ]),
      {
        availableModelsOverride: new Set(["openai/gpt-5.3-codex"]),
      },
    )

    //#when
    const result = await resolveSubagentExecution(args, executorCtx, "sisyphus", "deep")

    //#then
    expect(result.error).toBeUndefined()
    expect(result.categoryModel).toEqual({ providerID: "openai", modelID: "gpt-5.3-codex" })
  })

  test("uses agent override fallback_models for subagent runtime fallback chain", async () => {
    //#given
    const args = createBaseArgs({ subagent_type: "explore" })
    const executorCtx = createExecutorContext(
      async () => ([
        { name: "explore", mode: "subagent", model: "quotio/claude-haiku-4-5" },
      ]),
      {
        connectedProvidersOverride: ["quotio"],
        agentOverrides: {
          explore: {
            fallback_models: ["quotio/gpt-5.2", "glm-5(max)"],
          },
        } as ExecutorContext["agentOverrides"],
      },
    )

    //#when
    const result = await resolveSubagentExecution(args, executorCtx, "sisyphus", "deep")

    //#then
    expect(result.error).toBeUndefined()
    expect(result.fallbackChain).toHaveLength(2)
    expect(result.fallbackChain?.[0]).toEqual({
      providers: ["quotio"],
      model: "gpt-5.2",
      variant: undefined,
    })
    expect(result.fallbackChain?.[1]).toEqual(
      expect.objectContaining({
        model: "glm-5",
        variant: "max",
      }),
    )
  })

  test("uses category fallback_models when agent override points at category", async () => {
    //#given
    const args = createBaseArgs({ subagent_type: "explore" })
    const executorCtx = createExecutorContext(
      async () => ([
        { name: "explore", mode: "subagent", model: "quotio/claude-haiku-4-5" },
      ]),
      {
        connectedProvidersOverride: ["anthropic"],
        agentOverrides: {
          explore: {
            category: "research",
          },
        } as ExecutorContext["agentOverrides"],
        userCategories: {
          research: {
            fallback_models: ["anthropic/claude-haiku-4-5"],
          },
        } as ExecutorContext["userCategories"],
      },
    )

    //#when
    const result = await resolveSubagentExecution(args, executorCtx, "sisyphus", "deep")

    //#then
    expect(result.error).toBeUndefined()
    expect(result.fallbackChain).toEqual([
      { providers: ["anthropic"], model: "claude-haiku-4-5", variant: undefined },
    ])
  })

  test("promotes object-style fallback model settings to categoryModel when subagent fallback becomes initial model", async () => {
    //#given
    const args = createBaseArgs({ subagent_type: "explore" })
    const executorCtx = createExecutorContext(
      async () => ([
        { name: "explore", mode: "subagent", model: "quotio/claude-haiku-4-5-unavailable" },
      ]),
      {
        connectedProvidersOverride: ["openai"],
        availableModelsOverride: new Set(["openai/gpt-5.4"]),
        agentOverrides: {
          explore: {
            fallback_models: [
              {
                model: "openai/gpt-5.4 high",
                variant: "low",
                reasoningEffort: "high",
                temperature: 0.2,
                top_p: 0.8,
                maxTokens: 2048,
                thinking: { type: "disabled" },
              },
            ],
          },
        } as ExecutorContext["agentOverrides"],
      },
    )

    //#when
    const result = await resolveSubagentExecution(args, executorCtx, "sisyphus", "deep")

    //#then
    expect(result.error).toBeUndefined()
    expect(result.categoryModel).toEqual({
      providerID: "openai",
      modelID: "gpt-5.4",
      variant: "low",
      reasoningEffort: "high",
      temperature: 0.2,
      top_p: 0.8,
      maxTokens: 2048,
      thinking: { type: "disabled" },
    })
  })

  test("does not apply object-style fallback settings when the subagent primary model matches directly", async () => {
    //#given
    const args = createBaseArgs({ subagent_type: "explore" })
    const executorCtx = createExecutorContext(
      async () => ([
        { name: "explore", mode: "subagent", model: "openai/gpt-5.4-preview" },
      ]),
      {
        availableModelsOverride: new Set(["openai/gpt-5.4-preview"]),
        agentOverrides: {
          explore: {
            fallback_models: [
              {
                model: "openai/gpt-5.4",
                variant: "low",
                reasoningEffort: "high",
              },
            ],
          },
        } as ExecutorContext["agentOverrides"],
      },
    )

    //#when
    const result = await resolveSubagentExecution(args, executorCtx, "sisyphus", "deep")

    //#then
    expect(result.error).toBeUndefined()
    expect(result.categoryModel).toEqual({
      providerID: "openai",
      modelID: "gpt-5.4-preview",
    })
  })

  test("matches promoted fallback settings after fuzzy model resolution", async () => {
    //#given
    const args = createBaseArgs({ subagent_type: "explore" })
    const executorCtx = createExecutorContext(
      async () => ([
        { name: "explore", mode: "subagent", model: "quotio/claude-haiku-4-5-unavailable" },
      ]),
      {
        availableModelsOverride: new Set(["openai/gpt-5.4-preview"]),
        connectedProvidersOverride: ["openai"],
        agentOverrides: {
          explore: {
            fallback_models: [
              {
                model: "openai/gpt-5.4",
                variant: "low",
                reasoningEffort: "high",
                temperature: 0.3,
                top_p: 0.4,
                maxTokens: 2222,
                thinking: { type: "disabled" },
              },
            ],
          },
        } as ExecutorContext["agentOverrides"],
      },
    )

    //#when
    const result = await resolveSubagentExecution(args, executorCtx, "sisyphus", "deep")

    //#then
    expect(result.error).toBeUndefined()
    expect(result.categoryModel).toEqual({
      providerID: "openai",
      modelID: "gpt-5.4-preview",
      variant: "low",
      reasoningEffort: "high",
      temperature: 0.3,
      top_p: 0.4,
      maxTokens: 2222,
      thinking: { type: "disabled" },
    })
  })

  test("prefers exact promoted fallback match over earlier fuzzy prefix match", async () => {
    //#given
    const args = createBaseArgs({ subagent_type: "explore" })
    const executorCtx = createExecutorContext(
      async () => ([
        { name: "explore", mode: "subagent", model: "quotio/claude-haiku-4-5-unavailable" },
      ]),
      {
        availableModelsOverride: new Set(["openai/gpt-5.4-preview"]),
        connectedProvidersOverride: ["openai"],
        agentOverrides: {
          explore: {
            fallback_models: [
              {
                model: "openai/gpt-5.4",
                variant: "low",
                reasoningEffort: "medium",
              },
              {
                model: "openai/gpt-5.4-preview",
                variant: "max",
                reasoningEffort: "high",
              },
            ],
          },
        } as ExecutorContext["agentOverrides"],
      },
    )

    //#when
    const result = await resolveSubagentExecution(args, executorCtx, "sisyphus", "deep")

    //#then
    expect(result.error).toBeUndefined()
    expect(result.categoryModel).toEqual({
      providerID: "openai",
      modelID: "gpt-5.4-preview",
      variant: "max",
      reasoningEffort: "high",
    })
  })

  test("matches promoted fallback settings when fuzzy resolution extends configured model without hyphen", async () => {
    //#given
    const args = createBaseArgs({ subagent_type: "explore" })
    const executorCtx = createExecutorContext(
      async () => ([
        { name: "explore", mode: "subagent", model: "quotio/claude-haiku-4-5-unavailable" },
      ]),
      {
        availableModelsOverride: new Set(["openai/gpt-5.4o"]),
        connectedProvidersOverride: ["openai"],
        agentOverrides: {
          explore: {
            fallback_models: [
              {
                model: "openai/gpt-5.4",
                variant: "low",
                reasoningEffort: "high",
              },
            ],
          },
        } as ExecutorContext["agentOverrides"],
      },
    )

    //#when
    const result = await resolveSubagentExecution(args, executorCtx, "sisyphus", "deep")

    //#then
    expect(result.error).toBeUndefined()
    expect(result.categoryModel).toEqual({
      providerID: "openai",
      modelID: "gpt-5.4o",
      variant: "low",
      reasoningEffort: "high",
    })
  })

  test("does not use unavailable matchedAgent.model as fallback for custom subagent", async () => {
    //#given
    const args = createBaseArgs({ subagent_type: "my-custom-agent" })
    const executorCtx = createExecutorContext(
      async () => ([
        { name: "my-custom-agent", mode: "subagent", model: "minimaxi/MiniMax-M2.7-highspeed" },
      ]),
      {
        availableModelsOverride: new Set(["minimaxi/MiniMax-M2.7"]),
      },
    )

    //#when
    const result = await resolveSubagentExecution(args, executorCtx, "sisyphus", "deep")

    //#then
    expect(result.error).toBeUndefined()
    expect(result.categoryModel?.modelID).not.toBe("MiniMax-M2.7-highspeed")
  })

  test("uses matchedAgent.model as fallback when model is available", async () => {
    //#given
    const args = createBaseArgs({ subagent_type: "my-custom-agent" })
    const executorCtx = createExecutorContext(
      async () => ([
        { name: "my-custom-agent", mode: "subagent", model: "minimaxi/MiniMax-M2.7-highspeed" },
      ]),
      {
        availableModelsOverride: new Set(["minimaxi/MiniMax-M2.7-highspeed"]),
      },
    )

    //#when
    const result = await resolveSubagentExecution(args, executorCtx, "sisyphus", "deep")

    //#then
    expect(result.error).toBeUndefined()
    expect(result.categoryModel).toEqual({ providerID: "minimaxi", modelID: "MiniMax-M2.7-highspeed" })
  })

  test("prefers the most specific prefix match when fallback entries share a prefix", async () => {
    //#given
    const args = createBaseArgs({ subagent_type: "explore" })
    const executorCtx = createExecutorContext(
      async () => ([
        { name: "explore", mode: "subagent", model: "quotio/claude-haiku-4-5-unavailable" },
      ]),
      {
        availableModelsOverride: new Set(["openai/gpt-4o-preview"]),
        connectedProvidersOverride: ["openai"],
        agentOverrides: {
          explore: {
            fallback_models: [
              {
                model: "openai/gpt-4",
                variant: "low",
                reasoningEffort: "medium",
              },
              {
                model: "openai/gpt-4o",
                variant: "max",
                reasoningEffort: "high",
              },
            ],
          },
        } as ExecutorContext["agentOverrides"],
      },
    )

    //#when
    const result = await resolveSubagentExecution(args, executorCtx, "sisyphus", "deep")

    //#then
    expect(result.error).toBeUndefined()
    expect(result.categoryModel).toEqual({
      providerID: "openai",
      modelID: "gpt-4o-preview",
      variant: "max",
      reasoningEffort: "high",
    })
  })
})
