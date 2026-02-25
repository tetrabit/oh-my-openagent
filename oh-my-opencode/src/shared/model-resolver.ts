import { AGENT_MODEL_REQUIREMENTS, CATEGORY_MODEL_REQUIREMENTS, type FallbackEntry } from "./model-requirements"
import { resolveModelPipeline } from "./model-resolution-pipeline"
import { MODEL_CONTEXT_WINDOWS } from "./model-context-windows"

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

function normalizeModel(model?: string): string | undefined {
	const trimmed = model?.trim()
	return trimmed || undefined
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

/**
 * Normalizes fallback_models config (which can be string or string[]) to string[]
 * Centralized helper to avoid duplicated normalization logic
 */
export function normalizeFallbackModels(models: string | string[] | undefined): string[] | undefined {
	if (!models) return undefined
	if (typeof models === "string") return [models]
	return models
}

export interface RuntimeFallbackInput {
  currentModel: { providerID: string; modelID: string }
  agent: string
  triedModels: Set<string>
  currentTokens?: number
}

export interface RuntimeFallbackResult {
  providerID: string
  modelID: string
  contextWindow: number
  source: "agent-fallback" | "category-fallback"
}

export function resolveRuntimeFallback(input: RuntimeFallbackInput): RuntimeFallbackResult | undefined {
  const chain = AGENT_MODEL_REQUIREMENTS[input.agent]?.fallbackChain
    ?? CATEGORY_MODEL_REQUIREMENTS["unspecified-high"]?.fallbackChain
    ?? []

  const currentKey = `${input.currentModel.providerID}/${input.currentModel.modelID}`

  let currentFound = false
  for (const entry of chain) {
    const entryKey = `${entry.providers[0]}/${entry.model}`
    if (entryKey === currentKey) {
      currentFound = true
      continue
    }
    
    // Skip if it is not found yet and currentKey exists in the chain
    if (!currentFound && chain.some(e => `${e.providers[0]}/${e.model}` === currentKey)) {
      continue
    }

    if (input.triedModels.has(entryKey)) continue

    const contextWindow = MODEL_CONTEXT_WINDOWS[entryKey]
    if (input.currentTokens && contextWindow && contextWindow <= input.currentTokens) continue

    return {
      providerID: entry.providers[0],
      modelID: entry.model,
      contextWindow: contextWindow ?? Infinity,
      source: "agent-fallback",
    }
  }

  return undefined
}

