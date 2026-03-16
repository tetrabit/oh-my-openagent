declare const require: (name: string) => any
const { describe, test, expect, beforeEach, afterEach, spyOn, mock } = require("bun:test")
import type { DelegateTaskArgs } from "./types"
import type { ExecutorContext } from "./executor-types"

let moduleImportCounter = 0
let resolveSubagentExecution: typeof import("./subagent-resolver").resolveSubagentExecution
let connectedProvidersCache: typeof import("../../shared/connected-providers-cache")
const logMock = mock(() => {})

function mockModuleVariants(
  specifier: string,
  filePath: string,
  moduleValue: unknown,
): void {
  const factory = () => moduleValue
  mock.module(specifier, factory)
  mock.module(new URL(filePath, import.meta.url).href, factory)
}

async function prepareSubagentResolverTestModules(): Promise<void> {
  mock.restore()
  moduleImportCounter += 1
  const sharedModelResolver = await import(`../../shared/model-resolver?test=${moduleImportCounter}`)
  const sharedModelAvailability = await import(`../../shared/model-availability?test=${moduleImportCounter}`)
  const sharedProviderTransform = await import(`../../shared/provider-model-id-transform?test=${moduleImportCounter}`)
  const sharedFallbackChainModule = await import(`../../shared/fallback-chain-from-models?test=${moduleImportCounter}`)
  connectedProvidersCache = await import(`../../shared/connected-providers-cache?test=${moduleImportCounter}`)
  mockModuleVariants("../../shared", "../../shared/index.ts", {
    normalizeSDKResponse: (result: unknown, fallback: unknown) => {
      if (Array.isArray(result)) {
        return result
      }

      if (
        result
        && typeof result === "object"
        && "data" in result
        && Array.isArray((result as { data?: unknown }).data)
      ) {
        return (result as { data: unknown[] }).data
      }

      return fallback
    },
  })
  mockModuleVariants("../../shared/model-resolver", "../../shared/model-resolver.ts", sharedModelResolver)
  mockModuleVariants("../../shared/model-availability", "../../shared/model-availability.ts", sharedModelAvailability)
  mockModuleVariants("../../shared/provider-model-id-transform", "../../shared/provider-model-id-transform.ts", sharedProviderTransform)
  mockModuleVariants("../../shared/fallback-chain-from-models", "../../shared/fallback-chain-from-models.ts", sharedFallbackChainModule)
  mockModuleVariants("../../shared/logger", "../../shared/logger.ts", { log: logMock })
  mockModuleVariants("../../shared/connected-providers-cache", "../../shared/connected-providers-cache.ts", connectedProvidersCache)
  const availableModelsModule = await import(`./available-models?test=${moduleImportCounter}`)
  const modelSelectionModule = await import(`./model-selection?test=${moduleImportCounter}`)
  mockModuleVariants("./available-models", "./available-models.ts", availableModelsModule)
  mockModuleVariants("./model-selection", "./model-selection.ts", modelSelectionModule)
  ;({ resolveSubagentExecution } = await import(`./subagent-resolver?test=${moduleImportCounter}`))
}

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
    ...overrides,
  }
}

describe("resolveSubagentExecution", () => {
  beforeEach(async () => {
    await prepareSubagentResolverTestModules()
    logMock.mockClear()
  })

  afterEach(() => {
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
    const cacheSpy = spyOn(connectedProvidersCache, "readProviderModelsCache").mockReturnValue({
      models: { openai: ["grok-3"] },
      connected: ["openai"],
      updatedAt: "2026-03-03T00:00:00.000Z",
    })
    const args = createBaseArgs({ subagent_type: "oracle" })
    const executorCtx = createExecutorContext(async () => ([
      { name: "oracle", mode: "subagent", model: "openai/gpt-5.3-codex" },
    ]))

    //#when
    const result = await resolveSubagentExecution(args, executorCtx, "sisyphus", "deep")

    //#then
    expect(result.error).toBeUndefined()
    expect(result.categoryModel).toEqual({ providerID: "openai", modelID: "gpt-5.3-codex" })
    cacheSpy.mockRestore()
  })

  test("uses agent override fallback_models for subagent runtime fallback chain", async () => {
    //#given
    const cacheSpy = spyOn(connectedProvidersCache, "readProviderModelsCache").mockReturnValue({
      models: { quotio: ["claude-haiku-4-5"] },
      connected: ["quotio"],
      updatedAt: "2026-03-03T00:00:00.000Z",
    })
    const args = createBaseArgs({ subagent_type: "explore" })
    const executorCtx = createExecutorContext(
      async () => ([
        { name: "explore", mode: "subagent", model: "quotio/claude-haiku-4-5" },
      ]),
      {
        agentOverrides: {
          explore: {
            fallback_models: ["quotio/gpt-5.2", "glm-5(max)"],
          },
        } as ExecutorContext["agentOverrides"],
      }
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
      })
    )
    cacheSpy.mockRestore()
  })

  test("uses category fallback_models when agent override points at category", async () => {
    //#given
    const cacheSpy = spyOn(connectedProvidersCache, "readProviderModelsCache").mockReturnValue({
      models: { anthropic: ["claude-haiku-4-5"] },
      connected: ["anthropic"],
      updatedAt: "2026-03-03T00:00:00.000Z",
    })
    const args = createBaseArgs({ subagent_type: "explore" })
    const executorCtx = createExecutorContext(
      async () => ([
        { name: "explore", mode: "subagent", model: "quotio/claude-haiku-4-5" },
      ]),
      {
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
      }
    )

    //#when
    const result = await resolveSubagentExecution(args, executorCtx, "sisyphus", "deep")

    //#then
    expect(result.error).toBeUndefined()
    expect(result.fallbackChain).toEqual([
      { providers: ["anthropic"], model: "claude-haiku-4-5", variant: undefined },
    ])
    cacheSpy.mockRestore()
  })
})
