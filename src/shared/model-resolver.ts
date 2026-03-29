import type { FallbackEntry } from "./model-requirements"
import { AGENT_MODEL_REQUIREMENTS, CATEGORY_MODEL_REQUIREMENTS } from "./model-requirements"
import { fuzzyMatchModel } from "./model-availability"
import { transformModelForProvider } from "./provider-model-id-transform"
import type { FallbackModelObject } from "../config/schema/fallback-models"
import { normalizeModel } from "./model-normalization"
import { resolveModelPipeline } from "./model-resolution-pipeline"
import { KNOWN_VARIANTS } from "./known-variants"

export type ModelResolutionInput = {
	userModel?: string
	inheritedModel?: string
	systemDefault?: string
}

export type ModelSource =
	| "override"
	| "category-default"
	| "provider-fallback"
	| "system-default"

export type ModelResolutionResult = {
	model: string
	source: ModelSource
	variant?: string
}

export type ExtendedModelResolutionInput = {
	uiSelectedModel?: string
	userModel?: string
	userFallbackModels?: string[]
	categoryDefaultModel?: string
	fallbackChain?: FallbackEntry[]
	availableModels: Set<string>
	systemDefaultModel?: string
}

export type RuntimeFallbackReason = "context_overflow" | "rate_limit"

export type RuntimeFallbackResolutionInput = {
	currentModel: string
	agent?: string
	fallbackChain?: FallbackEntry[]
	availableModels: Set<string>
	triedModels: Set<string>
	requiredTokens?: number
	reason: RuntimeFallbackReason
}

export type RuntimeFallbackResolutionResult = {
	model: string
	source: "runtime-fallback"
	variant?: string
}

function normalizeResolvedModel(model: string): string {
	const trimmed = model.trim().toLowerCase()
	const [provider, ...rest] = trimmed.split("/")
	if (!provider || rest.length === 0) {
		return trimmed
	}

	const modelID = rest.join("/").replace(/\.(\d+)/g, "-$1")
	return `${provider}/${modelID}`
}

function hasTriedModel(triedModels: Set<string>, model: string): boolean {
	const normalized = normalizeResolvedModel(model)
	for (const triedModel of triedModels) {
		if (normalizeResolvedModel(triedModel) === normalized) {
			return true
		}
	}
	return false
}

function getRuntimeFallbackChain(
	agent: string | undefined,
	fallbackChain: FallbackEntry[] | undefined,
): FallbackEntry[] | undefined {
	if (fallbackChain && fallbackChain.length > 0) {
		return fallbackChain
	}

	const normalizedAgent = agent?.trim().toLowerCase()
	if (!normalizedAgent) {
		return undefined
	}

	return (
		AGENT_MODEL_REQUIREMENTS[normalizedAgent]?.fallbackChain
		?? CATEGORY_MODEL_REQUIREMENTS[normalizedAgent]?.fallbackChain
	)
}

function resolveFallbackCandidate(
	fallbackChain: FallbackEntry[],
	args: {
		availableModels: Set<string>
		currentModel: string
		currentProvider: string | undefined
		triedModels: Set<string>
		allowSameProvider: boolean
	},
): RuntimeFallbackResolutionResult | undefined {
	for (const entry of fallbackChain) {
		for (const provider of entry.providers) {
			if (!args.allowSameProvider && args.currentProvider && provider === args.currentProvider) {
				continue
			}

			if (args.availableModels.size > 0) {
				const match = fuzzyMatchModel(`${provider}/${entry.model}`, args.availableModels, [provider])
				if (!match) {
					continue
				}
				if (normalizeResolvedModel(match) === normalizeResolvedModel(args.currentModel)) {
					continue
				}
				if (hasTriedModel(args.triedModels, match)) {
					continue
				}
				return {
					model: match,
					source: "runtime-fallback",
					variant: entry.variant,
				}
			}

			const candidate = `${provider}/${transformModelForProvider(provider, entry.model)}`
			if (normalizeResolvedModel(candidate) === normalizeResolvedModel(args.currentModel)) {
				continue
			}
			if (hasTriedModel(args.triedModels, candidate)) {
				continue
			}
			return {
				model: candidate,
				source: "runtime-fallback",
				variant: entry.variant,
			}
		}
	}

	return undefined
}


export function resolveModel(input: ModelResolutionInput): string | undefined {
	return (
		normalizeModel(input.userModel) ??
		normalizeModel(input.inheritedModel) ??
		input.systemDefault
	)
}

export function resolveModelWithFallback(
	input: ExtendedModelResolutionInput,
): ModelResolutionResult | undefined {
	const { uiSelectedModel, userModel, userFallbackModels, categoryDefaultModel, fallbackChain, availableModels, systemDefaultModel } = input
	const resolved = resolveModelPipeline({
		intent: { uiSelectedModel, userModel, userFallbackModels, categoryDefaultModel },
		constraints: { availableModels },
		policy: { fallbackChain, systemDefaultModel },
	})

	if (!resolved) {
		return undefined
	}

	return {
		model: resolved.model,
		source: resolved.provenance,
		variant: resolved.variant,
	}
}

export function resolveRuntimeFallback(
	input: RuntimeFallbackResolutionInput,
): RuntimeFallbackResolutionResult | undefined {
	const fallbackChain = getRuntimeFallbackChain(input.agent, input.fallbackChain)
	if (!fallbackChain || fallbackChain.length === 0) {
		return undefined
	}

	const currentProvider = normalizeModel(input.currentModel)?.split("/")[0]

	if (input.reason === "rate_limit") {
		const alternateProviderMatch = resolveFallbackCandidate(fallbackChain, {
			availableModels: input.availableModels,
			currentModel: input.currentModel,
			currentProvider,
			triedModels: input.triedModels,
			allowSameProvider: false,
		})
		if (alternateProviderMatch) {
			return alternateProviderMatch
		}
	}

	return resolveFallbackCandidate(fallbackChain, {
		availableModels: input.availableModels,
		currentModel: input.currentModel,
		currentProvider,
		triedModels: input.triedModels,
		allowSameProvider: true,
	})
}

/**
 * Normalizes fallback_models config to a mixed array.
 * Accepts string, string[], or mixed arrays of strings and FallbackModelObject entries.
 */
export function normalizeFallbackModels(
	models: string | (string | FallbackModelObject)[] | undefined,
): (string | FallbackModelObject)[] | undefined {
	if (!models) return undefined
	if (typeof models === "string") return [models]
	return models
}

/**
 * Extracts plain model strings from a mixed fallback models array.
 * Object entries are flattened to "model" or "model(variant)" strings.
 * Use this when consumers need string[] (e.g., resolveModelForDelegateTask).
 */
export function flattenToFallbackModelStrings(
	models: (string | FallbackModelObject)[] | undefined,
): string[] | undefined {
	if (!models) return undefined
	return models.map((entry) => {
		if (typeof entry === "string") return entry
		const variant = entry.variant
		if (variant) {
			// Strip any supported inline variant syntax before appending explicit override.
			// Supports both parenthesized and space-suffix forms so we don't emit
			// invalid strings like "provider/model high(low)".
			const model = entry.model
				.replace(/\([^()]+\)\s*$/, "")
				.replace(/\s+([a-z][a-z0-9_-]*)\s*$/i, (match, suffix) => {
					const normalized = String(suffix).toLowerCase()
					return KNOWN_VARIANTS.has(normalized)
						? ""
						: match
				})
				.trim()
			return `${model}(${variant})`
		}
		// No explicit variant — preserve model string as-is (including any inline variant)
		return entry.model
	})
}
