import type { FallbackEntry } from "./model-requirements"
import { shouldRetryError } from "./model-error-classifier"
import { transformModelForProvider } from "./provider-model-id-transform"

type ExplicitModel = {
  providerID: string
  modelID: string
  variant?: string
}

type PromptArgs = {
  path: { id: string }
  body: Record<string, unknown> & {
    model?: { providerID: string; modelID: string }
    variant?: string
  }
}

function extractErrorName(error: unknown): string | undefined {
  if (error instanceof Error) return error.name
  if (typeof error === "object" && error !== null && typeof (error as { name?: unknown }).name === "string") {
    return (error as { name: string }).name
  }
  return undefined
}

function extractErrorMessage(error: unknown): string | undefined {
  if (!error) return undefined
  if (typeof error === "string") return error
  if (error instanceof Error) return error.message

  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>
    const candidates = [record.message, record.error, record.data, record.cause]
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.length > 0) return candidate
      if (typeof candidate === "object" && candidate !== null) {
        const nested = extractErrorMessage(candidate)
        if (nested) return nested
      }
    }
  }

  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function isRetryablePromptError(error: unknown): boolean {
  const errorInfo = {
    name: extractErrorName(error),
    message: extractErrorMessage(error),
  }

  if (shouldRetryError(errorInfo)) {
    return true
  }

  if (errorInfo.name === "MessageAbortedError" || errorInfo.name === "AbortError") {
    return shouldRetryError({ message: errorInfo.message })
  }

  return false
}

function getModelKey(model: ExplicitModel): string {
  return `${model.providerID}/${model.modelID}:${model.variant ?? ""}`
}

function withExplicitModel(promptArgs: PromptArgs, model: ExplicitModel): PromptArgs {
  const body = {
    ...promptArgs.body,
    model: {
      providerID: model.providerID,
      modelID: model.modelID,
    },
  }

  if (model.variant !== undefined) {
    body.variant = model.variant
  } else {
    delete body.variant
  }

  return {
    ...promptArgs,
    body,
  }
}

function getFallbackCandidates(fallbackChain: FallbackEntry[] | undefined): ExplicitModel[] {
  if (!fallbackChain || fallbackChain.length === 0) return []

  const candidates: ExplicitModel[] = []
  for (const entry of fallbackChain) {
    for (const provider of entry.providers) {
      candidates.push({
        providerID: provider,
        modelID: transformModelForProvider(provider, entry.model),
        variant: entry.variant,
      })
    }
  }
  return candidates
}

export async function sendPromptWithFallbackRetry(args: {
  promptArgs: PromptArgs
  currentModel?: ExplicitModel
  fallbackChain?: FallbackEntry[]
  sendPrompt: (promptArgs: PromptArgs) => Promise<void>
}): Promise<ExplicitModel & { usedFallback: boolean }> {
  try {
    await args.sendPrompt(args.promptArgs)
    if (args.currentModel) {
      return { ...args.currentModel, usedFallback: false }
    }
    const model = args.promptArgs.body.model
    return {
      providerID: model?.providerID ?? "",
      modelID: model?.modelID ?? "",
      variant: args.promptArgs.body.variant,
      usedFallback: false,
    }
  } catch (error) {
    if (!isRetryablePromptError(error)) {
      throw error
    }

    const tried = new Set<string>()
    if (args.currentModel) {
      tried.add(getModelKey(args.currentModel))
    }

    let lastError = error
    for (const candidate of getFallbackCandidates(args.fallbackChain)) {
      const candidateKey = getModelKey(candidate)
      if (tried.has(candidateKey)) {
        continue
      }
      tried.add(candidateKey)

      try {
        await args.sendPrompt(withExplicitModel(args.promptArgs, candidate))
        return {
          ...candidate,
          usedFallback: true,
        }
      } catch (candidateError) {
        if (!isRetryablePromptError(candidateError)) {
          throw candidateError
        }
        lastError = candidateError
      }
    }

    throw lastError
  }
}
