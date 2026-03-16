declare const require: (name: string) => any
const { describe, test, expect, beforeEach, afterEach, spyOn, mock } = require("bun:test")
import type { ExecutorContext } from "./executor-types"

let moduleImportCounter = 0
let resolveCategoryExecution: typeof import("./category-resolver").resolveCategoryExecution
let connectedProvidersCache: typeof import("../../shared/connected-providers-cache")

function mockModuleVariants(
	specifier: string,
	filePath: string,
	moduleValue: unknown,
): void {
	const factory = () => moduleValue
	mock.module(specifier, factory)
	mock.module(new URL(filePath, import.meta.url).href, factory)
}

async function prepareCategoryResolverTestModules(): Promise<void> {
	mock.restore()
	moduleImportCounter += 1
	const sharedModelResolver = await import(`../../shared/model-resolver?test=${moduleImportCounter}`)
	const sharedModelAvailability = await import(`../../shared/model-availability?test=${moduleImportCounter}`)
	const sharedLogger = await import(`../../shared/logger?test=${moduleImportCounter}`)
	connectedProvidersCache = await import(`../../shared/connected-providers-cache?test=${moduleImportCounter}`)
	mockModuleVariants("../../shared/model-resolver", "../../shared/model-resolver.ts", sharedModelResolver)
	mockModuleVariants("../../shared/model-availability", "../../shared/model-availability.ts", sharedModelAvailability)
	mockModuleVariants("../../shared/logger", "../../shared/logger.ts", sharedLogger)
	mockModuleVariants("../../shared/connected-providers-cache", "../../shared/connected-providers-cache.ts", connectedProvidersCache)
	const categoriesModule = await import(`./categories?test=${moduleImportCounter}`)
	const availableModelsModule = await import(`./available-models?test=${moduleImportCounter}`)
	const modelSelectionModule = await import(`./model-selection?test=${moduleImportCounter}`)
	mockModuleVariants("./categories", "./categories.ts", categoriesModule)
	mockModuleVariants("./available-models", "./available-models.ts", availableModelsModule)
	mockModuleVariants("./model-selection", "./model-selection.ts", modelSelectionModule)
	;({ resolveCategoryExecution } = await import(`./category-resolver?test=${moduleImportCounter}`))
}

describe("resolveCategoryExecution", () => {
	let connectedProvidersSpy: ReturnType<typeof spyOn> | undefined
	let providerModelsSpy: ReturnType<typeof spyOn> | undefined

	beforeEach(async () => {
		await prepareCategoryResolverTestModules()
		connectedProvidersSpy = spyOn(connectedProvidersCache, "readConnectedProvidersCache").mockReturnValue(null)
		providerModelsSpy = spyOn(connectedProvidersCache, "readProviderModelsCache").mockReturnValue(null)
	})

	afterEach(() => {
		connectedProvidersSpy?.mockRestore()
		providerModelsSpy?.mockRestore()
		mock.restore()
	})

	const createMockExecutorContext = (): ExecutorContext => ({
		client: {} as any,
		manager: {} as any,
		directory: "/tmp/test",
		userCategories: {},
		sisyphusJuniorModel: undefined,
	})

	test("uses explicit user category model when present", async () => {
		//#given
		const args = {
			category: "deep",
			prompt: "test prompt",
			description: "Test task",
			run_in_background: false,
			load_skills: [],
			blockedBy: undefined,
			enableSkillTools: false,
		}
		const executorCtx = createMockExecutorContext()
		executorCtx.userCategories = {
			deep: {
				model: "openai/gpt-5.3-codex",
				variant: "medium",
			},
		}
		const inheritedModel = undefined
		const systemDefaultModel = "anthropic/claude-sonnet-4-6"

		//#when
		const result = await resolveCategoryExecution(args, executorCtx, inheritedModel, systemDefaultModel)

		//#then
		expect(result.error).toBeUndefined()
		expect(result.categoryModel).toEqual({ providerID: "openai", modelID: "gpt-5.3-codex", variant: "medium" })
	})

	test("returns 'unknown category' error for truly unknown categories", async () => {
		//#given
		const args = {
			category: "definitely-not-a-real-category-xyz123",
			prompt: "test prompt",
			description: "Test task",
			run_in_background: false,
			load_skills: [],
			blockedBy: undefined,
			enableSkillTools: false,
		}
		const executorCtx = createMockExecutorContext()
		const inheritedModel = undefined
		const systemDefaultModel = "anthropic/claude-sonnet-4-6"

		//#when
		const result = await resolveCategoryExecution(args, executorCtx, inheritedModel, systemDefaultModel)

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
			blockedBy: undefined,
			enableSkillTools: false,
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
})
