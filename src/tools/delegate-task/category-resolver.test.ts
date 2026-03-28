declare const require: (name: string) => any
const { describe, test, expect, beforeEach, mock } = require("bun:test")
import { resolveCategoryExecution } from "./category-resolver"
import type { ExecutorContext } from "./executor-types"

function createMockExecutorContext(): ExecutorContext {
  return {
    client: {} as ExecutorContext["client"],
    manager: {} as ExecutorContext["manager"],
    directory: "/tmp/test",
    connectedProvidersOverride: null,
    availableModelsOverride: new Set(),
    userCategories: {},
    sisyphusJuniorModel: undefined,
  }
}

describe("resolveCategoryExecution", () => {
  beforeEach(() => {
    mock.restore()
  })

  test("uses explicit user category model when present", async () => {
    //#given
    const args = {
      category: "deep",
      prompt: "test prompt",
      description: "Test task",
      run_in_background: false,
      load_skills: [],
    }
    const executorCtx = createMockExecutorContext()
    executorCtx.userCategories = {
      deep: {
        model: "openai/gpt-5.3-codex",
        variant: "medium",
      },
    }

    //#when
    const result = await resolveCategoryExecution(args, executorCtx, undefined, "anthropic/claude-sonnet-4-6")

    //#then
    expect(result.error).toBeUndefined()
    expect(result.categoryModel).toEqual({ providerID: "openai", modelID: "gpt-5.3-codex", variant: "medium" })
  })

  test("uses built-in category model when category cache is not ready on first run", async () => {
    //#given
    const args = {
      category: "deep",
      prompt: "test prompt",
      description: "Test task",
      run_in_background: false,
      load_skills: [],
    }
    const executorCtx = createMockExecutorContext()
    executorCtx.userCategories = {
      deep: {},
    }

    //#when
    const result = await resolveCategoryExecution(args, executorCtx, undefined, "anthropic/claude-sonnet-4-6")

    //#then
    expect(result.error).toBeUndefined()
    expect(result.actualModel).toBe("openai/gpt-5.3-codex")
    expect(result.categoryModel).toEqual({ providerID: "openai", modelID: "gpt-5.3-codex", variant: "medium" })
    expect(result.agentToUse).toBeDefined()
  })

  test("returns 'unknown category' error for truly unknown categories", async () => {
    //#given
    const args = {
      category: "definitely-not-a-real-category-xyz123",
      prompt: "test prompt",
      description: "Test task",
      run_in_background: false,
      load_skills: [],
    }
    const executorCtx = createMockExecutorContext()

    //#when
    const result = await resolveCategoryExecution(args, executorCtx, undefined, "anthropic/claude-sonnet-4-6")

    //#then
    expect(result.error).toBeDefined()
    expect(result.error).toContain("Unknown category")
    expect(result.error).toContain("definitely-not-a-real-category-xyz123")
  })

  test("uses category fallback_models for background/runtime fallback chain", async () => {
    //#given
    const args = {
      category: "deep",
      prompt: "test prompt",
      description: "Test task",
      run_in_background: false,
      load_skills: [],
    }
    const executorCtx = createMockExecutorContext()
    executorCtx.userCategories = {
      deep: {
        model: "quotio/claude-opus-4-6",
        fallback_models: ["quotio/kimi-k2.5", "openai/gpt-5.2(high)"],
      },
    }

    //#when
    const result = await resolveCategoryExecution(args, executorCtx, undefined, "anthropic/claude-sonnet-4-6")

    //#then
    expect(result.error).toBeUndefined()
    expect(result.fallbackChain).toEqual([
      { providers: ["quotio"], model: "kimi-k2.5", variant: undefined },
      { providers: ["openai"], model: "gpt-5.2", variant: "high" },
    ])
  })

  test("promotes object-style fallback model settings to categoryModel when fallback becomes initial model", async () => {
    //#given
    const args = {
      category: "deep",
      prompt: "test prompt",
      description: "Test task",
      run_in_background: false,
      load_skills: [],
    }
    const executorCtx = createMockExecutorContext()
    executorCtx.connectedProvidersOverride = ["openai"]
    executorCtx.availableModelsOverride = new Set(["openai/gpt-5.4"])
    executorCtx.userCategories = {
      deep: {
        fallback_models: [
          {
            model: "openai/gpt-5.4 high",
            variant: "low",
            reasoningEffort: "high",
            temperature: 0.4,
            top_p: 0.7,
            maxTokens: 4096,
            thinking: { type: "disabled" },
          },
        ],
      },
    }

    //#when
    const result = await resolveCategoryExecution(args, executorCtx, undefined, "anthropic/claude-sonnet-4-6")

    //#then
    expect(result.error).toBeUndefined()
    expect(result.actualModel).toBe("openai/gpt-5.4")
    expect(result.categoryModel).toEqual({
      providerID: "openai",
      modelID: "gpt-5.4",
      variant: "low",
      reasoningEffort: "high",
      temperature: 0.4,
      top_p: 0.7,
      maxTokens: 4096,
      thinking: { type: "disabled" },
    })
  })

  test("does not apply object-style fallback settings when the configured primary model matches directly", async () => {
    //#given
    const args = {
      category: "deep",
      prompt: "test prompt",
      description: "Test task",
      run_in_background: false,
      load_skills: [],
    }
    const executorCtx = createMockExecutorContext()
    executorCtx.connectedProvidersOverride = ["openai"]
    executorCtx.availableModelsOverride = new Set(["openai/gpt-5.4-preview"])
    executorCtx.userCategories = {
      deep: {
        model: "openai/gpt-5.4-preview",
        fallback_models: [
          {
            model: "openai/gpt-5.4",
            variant: "low",
            reasoningEffort: "high",
          },
        ],
      },
    }

    //#when
    const result = await resolveCategoryExecution(args, executorCtx, undefined, "anthropic/claude-sonnet-4-6")

    //#then
    expect(result.error).toBeUndefined()
    expect(result.actualModel).toBe("openai/gpt-5.4-preview")
    expect(result.categoryModel).toEqual({
      providerID: "openai",
      modelID: "gpt-5.4-preview",
      variant: "medium",
    })
  })

  test("matches promoted fallback settings after fuzzy model resolution", async () => {
    //#given
    const args = {
      category: "deep",
      prompt: "test prompt",
      description: "Test task",
      run_in_background: false,
      load_skills: [],
    }
    const executorCtx = createMockExecutorContext()
    executorCtx.connectedProvidersOverride = ["openai"]
    executorCtx.availableModelsOverride = new Set(["openai/gpt-5.4-preview"])
    executorCtx.userCategories = {
      deep: {
        fallback_models: [
          {
            model: "openai/gpt-5.4",
            variant: "low",
            reasoningEffort: "high",
            temperature: 0.6,
            top_p: 0.5,
            maxTokens: 1234,
            thinking: { type: "disabled" },
          },
        ],
      },
    }

    //#when
    const result = await resolveCategoryExecution(args, executorCtx, undefined, "anthropic/claude-sonnet-4-6")

    //#then
    expect(result.error).toBeUndefined()
    expect(result.actualModel).toBe("openai/gpt-5.4-preview")
    expect(result.categoryModel).toEqual({
      providerID: "openai",
      modelID: "gpt-5.4-preview",
      variant: "low",
      reasoningEffort: "high",
      temperature: 0.6,
      top_p: 0.5,
      maxTokens: 1234,
      thinking: { type: "disabled" },
    })
  })

  test("prefers exact promoted fallback match over earlier fuzzy prefix match", async () => {
    //#given
    const args = {
      category: "deep",
      prompt: "test prompt",
      description: "Test task",
      run_in_background: false,
      load_skills: [],
    }
    const executorCtx = createMockExecutorContext()
    executorCtx.connectedProvidersOverride = ["openai"]
    executorCtx.availableModelsOverride = new Set(["openai/gpt-5.4-preview"])
    executorCtx.userCategories = {
      deep: {
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
    }

    //#when
    const result = await resolveCategoryExecution(args, executorCtx, undefined, "anthropic/claude-sonnet-4-6")

    //#then
    expect(result.error).toBeUndefined()
    expect(result.actualModel).toBe("openai/gpt-5.4-preview")
    expect(result.categoryModel).toEqual({
      providerID: "openai",
      modelID: "gpt-5.4-preview",
      variant: "max",
      reasoningEffort: "high",
    })
  })

  test("matches promoted fallback settings when fuzzy resolution extends configured model without hyphen", async () => {
    //#given
    const args = {
      category: "deep",
      prompt: "test prompt",
      description: "Test task",
      run_in_background: false,
      load_skills: [],
    }
    const executorCtx = createMockExecutorContext()
    executorCtx.connectedProvidersOverride = ["openai"]
    executorCtx.availableModelsOverride = new Set(["openai/gpt-5.4o"])
    executorCtx.userCategories = {
      deep: {
        fallback_models: [
          {
            model: "openai/gpt-5.4",
            variant: "low",
            reasoningEffort: "high",
          },
        ],
      },
    }

    //#when
    const result = await resolveCategoryExecution(args, executorCtx, undefined, "anthropic/claude-sonnet-4-6")

    //#then
    expect(result.error).toBeUndefined()
    expect(result.actualModel).toBe("openai/gpt-5.4o")
    expect(result.categoryModel).toEqual({
      providerID: "openai",
      modelID: "gpt-5.4o",
      variant: "low",
      reasoningEffort: "high",
    })
  })

  test("prefers the most specific prefix match when fallback entries share a prefix", async () => {
    //#given
    const args = {
      category: "deep",
      prompt: "test prompt",
      description: "Test task",
      run_in_background: false,
      load_skills: [],
    }
    const executorCtx = createMockExecutorContext()
    executorCtx.connectedProvidersOverride = ["openai"]
    executorCtx.availableModelsOverride = new Set(["openai/gpt-4o"])
    executorCtx.userCategories = {
      deep: {
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
    }

    //#when
    const result = await resolveCategoryExecution(args, executorCtx, undefined, "anthropic/claude-sonnet-4-6")

    //#then
    expect(result.error).toBeUndefined()
    expect(result.actualModel).toBe("openai/gpt-4o")
    expect(result.categoryModel).toEqual({
      providerID: "openai",
      modelID: "gpt-4o",
      variant: "max",
      reasoningEffort: "high",
    })
  })
})
