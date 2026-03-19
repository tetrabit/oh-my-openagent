declare const require: (name: string) => any
const { describe, test, expect, beforeEach, afterEach, mock } = require("bun:test")

let moduleImportCounter = 0

async function importResolveModelForDelegateTaskWithCacheState(input: {
	hasConnectedProvidersCache: boolean
	hasProviderModelsCache: boolean
}): Promise<typeof import("./model-selection").resolveModelForDelegateTask> {
	moduleImportCounter += 1
	const connectedProvidersCache = await import(`../../shared/connected-providers-cache?test=${moduleImportCounter}`)
	const mockedModule = {
		...connectedProvidersCache,
		hasConnectedProvidersCache: () => input.hasConnectedProvidersCache,
		hasProviderModelsCache: () => input.hasProviderModelsCache,
	}
	const normalizeModelName = (name: string) =>
		name
			.toLowerCase()
			.replace(/claude-(opus|sonnet|haiku)-(\d+)[.-](\d+)/g, "claude-$1-$2.$3")
	const realModelAvailability = await import(`../../shared/model-availability?test=${moduleImportCounter}`)
	const modelAvailability = {
		...realModelAvailability,
		fuzzyMatchModel: (target: string, available: Set<string>, providers?: string[]) => {
			let candidates = Array.from(available)
			if (providers && providers.length > 0) {
				const providerSet = new Set(providers)
				candidates = candidates.filter((model) => providerSet.has(model.split("/")[0]))
			}
			const targetNormalized = normalizeModelName(target)
			const matches = candidates.filter((model) => normalizeModelName(model).includes(targetNormalized))
			if (matches.length === 0) return null
			const exactMatch = matches.find((model) => normalizeModelName(model) === targetNormalized)
			if (exactMatch) return exactMatch
			const exactModelIdMatches = matches.filter((model) => normalizeModelName(model.split("/").slice(1).join("/")) === targetNormalized)
			if (exactModelIdMatches.length > 0) {
				return exactModelIdMatches.reduce((shortest, current) => current.length < shortest.length ? current : shortest)
			}
			return matches.reduce((shortest, current) => current.length < shortest.length ? current : shortest)
		},
	}
	mock.module("../../shared/connected-providers-cache", () => mockedModule)
	mock.module(new URL("../../shared/connected-providers-cache.ts", import.meta.url).href, () => mockedModule)
	mock.module("../../shared/model-availability", () => modelAvailability)
	mock.module(new URL("../../shared/model-availability.ts", import.meta.url).href, () => modelAvailability)
	return (await import(`./model-selection?test=${moduleImportCounter}`)).resolveModelForDelegateTask
}

	describe("resolveModelForDelegateTask", () => {
	beforeEach(() => {
		mock.restore()
	})

	afterEach(() => {
		mock.restore()
	})

	describe("#given no provider cache exists (pre-cache scenario)", () => {
		describe("#when availableModels is empty and no user model override", () => {
			test("#then returns undefined to let OpenCode use system default", async () => {
				const resolveModelForDelegateTask = await importResolveModelForDelegateTaskWithCacheState({
					hasConnectedProvidersCache: false,
					hasProviderModelsCache: false,
				})
				const result = resolveModelForDelegateTask({
					categoryDefaultModel: "anthropic/claude-sonnet-4-6",
					fallbackChain: [
						{ providers: ["anthropic"], model: "claude-sonnet-4-6" },
					],
					availableModels: new Set(),
					systemDefaultModel: "anthropic/claude-sonnet-4-6",
				})

				expect(result).toEqual({ skipped: true })
			})
		})

		describe("#when user explicitly set a model override", () => {
			test("#then returns the user model regardless of cache state", async () => {
				const resolveModelForDelegateTask = await importResolveModelForDelegateTaskWithCacheState({
					hasConnectedProvidersCache: false,
					hasProviderModelsCache: false,
				})
				const result = resolveModelForDelegateTask({
					userModel: "openai/gpt-5.4",
					categoryDefaultModel: "anthropic/claude-sonnet-4-6",
					fallbackChain: [
						{ providers: ["anthropic"], model: "claude-sonnet-4-6" },
					],
					availableModels: new Set(),
					systemDefaultModel: "anthropic/claude-sonnet-4-6",
				})

				expect(result).toEqual({ model: "openai/gpt-5.4" })
			})
		})

		describe("#when user set fallback_models but no cache exists", () => {
			test("#then returns undefined (skip fallback resolution without cache)", async () => {
				const resolveModelForDelegateTask = await importResolveModelForDelegateTaskWithCacheState({
					hasConnectedProvidersCache: false,
					hasProviderModelsCache: false,
				})
				const result = resolveModelForDelegateTask({
					userFallbackModels: ["openai/gpt-5.4", "google/gemini-3.1-pro"],
					categoryDefaultModel: "anthropic/claude-sonnet-4-6",
					fallbackChain: [
						{ providers: ["anthropic"], model: "claude-sonnet-4-6" },
					],
					availableModels: new Set(),
				})

				expect(result).toEqual({ skipped: true })
			})
		})
	})

	describe("#given provider cache exists", () => {
		describe("#when availableModels is empty (cache exists but empty)", () => {
			test("#then falls through to category default model (existing behavior)", async () => {
				const resolveModelForDelegateTask = await importResolveModelForDelegateTaskWithCacheState({
					hasConnectedProvidersCache: true,
					hasProviderModelsCache: true,
				})
				const result = resolveModelForDelegateTask({
					categoryDefaultModel: "anthropic/claude-sonnet-4-6",
					fallbackChain: [
						{ providers: ["anthropic"], model: "claude-sonnet-4-6" },
					],
					availableModels: new Set(),
					systemDefaultModel: "anthropic/claude-sonnet-4-6",
				})

				expect(result).toEqual({ model: "anthropic/claude-sonnet-4-6" })
			})
		})

		describe("#when availableModels has entries and category default matches", () => {
			test("#then resolves via fuzzy match (existing behavior)", async () => {
				const resolveModelForDelegateTask = await importResolveModelForDelegateTaskWithCacheState({
					hasConnectedProvidersCache: true,
					hasProviderModelsCache: true,
				})
				const result = resolveModelForDelegateTask({
					categoryDefaultModel: "anthropic/claude-sonnet-4-6",
					fallbackChain: [
						{ providers: ["anthropic"], model: "claude-sonnet-4-6" },
					],
					availableModels: new Set(["anthropic/claude-sonnet-4-6"]),
				})

				expect(result).toEqual({ model: "anthropic/claude-sonnet-4-6" })
			})
		})
	})

	describe("#given only connected providers cache exists (no provider-models cache)", () => {
		describe("#when availableModels is empty", () => {
			test("#then falls through to existing resolution (cache partially ready)", async () => {
				const resolveModelForDelegateTask = await importResolveModelForDelegateTaskWithCacheState({
					hasConnectedProvidersCache: true,
					hasProviderModelsCache: false,
				})
				const result = resolveModelForDelegateTask({
					categoryDefaultModel: "anthropic/claude-sonnet-4-6",
					fallbackChain: [
						{ providers: ["anthropic"], model: "claude-sonnet-4-6" },
					],
					availableModels: new Set(),
				})

				expect(result).toBeDefined()
			})
		})
	})
})
