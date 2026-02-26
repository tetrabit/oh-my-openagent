import { APICallError } from "ai"
import { STATUS_CODES } from "http"
import { iife } from "@/util/iife"

export namespace ProviderError {
  // Adapted from overflow detection patterns in:
  // https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/utils/overflow.ts
  const OVERFLOW_PATTERNS = [
    /prompt is too long/i, // Anthropic
    /input is too long for requested model/i, // Amazon Bedrock
    /exceeds the context window/i, // OpenAI (Completions + Responses API message text)
    /input token count.*exceeds the maximum/i, // Google (Gemini)
    /maximum prompt length is \d+/i, // xAI (Grok)
    /reduce the length of the messages/i, // Groq
    /maximum context length is \d+ tokens/i, // OpenRouter, DeepSeek
    /exceeds the limit of \d+/i, // GitHub Copilot
    /exceeds the available context size/i, // llama.cpp server
    /greater than the context length/i, // LM Studio
    /context window exceeds limit/i, // MiniMax
    /exceeded model token limit/i, // Kimi For Coding, Moonshot
    /context[_ ]length[_ ]exceeded/i, // Generic fallback
  ]

  function isOpenAiErrorRetryable(e: APICallError) {
    const status = e.statusCode
    if (!status) return e.isRetryable
    // openai sometimes returns 404 for models that are actually available
    return status === 404 || e.isRetryable
  }

  // Providers not reliably handled in this function:
  // - z.ai: can accept overflow silently (needs token-count/context-window checks)
  function isOverflow(message: string) {
    if (OVERFLOW_PATTERNS.some((p) => p.test(message))) return true

    // Providers/status patterns handled outside of regex list:
    // - Cerebras: often returns "400 (no body)" / "413 (no body)"
    // - Mistral: often returns "400 (no body)" / "413 (no body)"
    return /^4(00|13)\s*(status code)?\s*\(no body\)/i.test(message)
  }

  function error(providerID: string, error: APICallError) {
    if (providerID.includes("github-copilot") && error.statusCode === 403) {
      return "Please reauthenticate with the copilot provider to ensure your credentials work properly with OpenCode."
    }

    return error.message
  }

  function message(providerID: string, e: APICallError) {
    return iife(() => {
      const msg = e.message
      if (msg === "") {
        if (e.responseBody) return e.responseBody
        if (e.statusCode) {
          const err = STATUS_CODES[e.statusCode]
          if (err) return err
        }
        return "Unknown error"
      }

      const transformed = error(providerID, e)
      if (transformed !== msg) {
        return transformed
      }
      if (!e.responseBody || (e.statusCode && msg !== STATUS_CODES[e.statusCode])) {
        return msg
      }

      try {
        const body = JSON.parse(e.responseBody)
        // try to extract common error message fields
        const errMsg = body.message || body.error || body.error?.message
        if (errMsg && typeof errMsg === "string") {
          return `${msg}: ${errMsg}`
        }
      } catch {}

      return `${msg}: ${e.responseBody}`
    }).trim()
  }

  function json(input: unknown) {
    if (typeof input === "string") {
      try {
        const result = JSON.parse(input)
        if (result && typeof result === "object") return result
        return undefined
      } catch {
        return undefined
      }
    }
    if (typeof input === "object" && input !== null) {
      return input
    }
    return undefined
  }

  function extractTokenCounts(message: string, responseBody?: string) {
    const n = (value: string) => {
      const parsed = Number.parseInt(value.replaceAll(",", ""), 10)
      if (Number.isNaN(parsed)) return undefined
      return parsed
    }

    const parse = (text: string) => {
      const gt = text.match(/(\d[\d,]*)\s*tokens?\s*[>]\s*(\d[\d,]*)/i)
      if (gt) {
        return {
          currentTokens: n(gt[1]),
          maxTokens: n(gt[2]),
        }
      }

      const prompt = text.match(/prompt\s+(\d[\d,]*)\s*tokens?\s*exceeds?\s*(\d[\d,]*)/i)
      if (prompt) {
        return {
          currentTokens: n(prompt[1]),
          maxTokens: n(prompt[2]),
        }
      }

      const maxContext = text.match(/maximum context length is (\d[\d,]*) tokens.*?(\d[\d,]*)/i)
      if (maxContext) {
        return {
          currentTokens: n(maxContext[2]),
          maxTokens: n(maxContext[1]),
        }
      }

      const inputCount = text.match(/input token count.*?(\d[\d,]*).*?maximum.*?(\d[\d,]*)/i)
      if (inputCount) {
        return {
          currentTokens: n(inputCount[1]),
          maxTokens: n(inputCount[2]),
        }
      }

      const maxPrompt = text.match(/maximum prompt length is (\d[\d,]*)/i)
      if (maxPrompt) {
        return {
          maxTokens: n(maxPrompt[1]),
        }
      }

      const limit = text.match(/exceeds the limit of (\d[\d,]*)/i)
      if (limit) {
        return {
          maxTokens: n(limit[1]),
        }
      }
    }

    const body = json(responseBody)
    if (body) {
      const root = body as Record<string, unknown>
      const error = typeof root.error === "object" && root.error !== null
        ? (root.error as Record<string, unknown>)
        : undefined

      const current = [
        root.currentTokens,
        root.current_tokens,
        root.promptTokens,
        root.prompt_tokens,
        root.inputTokens,
        root.input_tokens,
        error?.currentTokens,
        error?.current_tokens,
        error?.promptTokens,
        error?.prompt_tokens,
        error?.inputTokens,
        error?.input_tokens,
      ]
        .flatMap((value) => (typeof value === "number" ? [value] : typeof value === "string" ? [n(value)] : []))
        .find((value) => value !== undefined)

      const max = [
        root.maxTokens,
        root.max_tokens,
        root.maximumTokens,
        root.maximum_tokens,
        root.contextWindow,
        root.context_window,
        error?.maxTokens,
        error?.max_tokens,
        error?.maximumTokens,
        error?.maximum_tokens,
        error?.contextWindow,
        error?.context_window,
      ]
        .flatMap((value) => (typeof value === "number" ? [value] : typeof value === "string" ? [n(value)] : []))
        .find((value) => value !== undefined)

      if (current !== undefined || max !== undefined) {
        return {
          currentTokens: current,
          maxTokens: max,
        }
      }

      const candidates = [
        typeof root.message === "string" ? root.message : undefined,
        typeof root.error === "string" ? root.error : undefined,
        typeof error?.message === "string" ? error.message : undefined,
        responseBody,
      ]

      for (const text of candidates) {
        if (!text) continue
        const info = parse(text)
        if (info) return info
      }
    }

    return parse(message)
  }

  export type ParsedStreamError =
    | {
        type: "context_overflow"
        message: string
        responseBody: string
        currentTokens?: number
        maxTokens?: number
      }
    | {
        type: "api_error"
        message: string
        isRetryable: false
        responseBody: string
      }

  export function parseStreamError(input: unknown): ParsedStreamError | undefined {
    const body = json(input)
    if (!body) return

    const responseBody = JSON.stringify(body)
    if (body.type !== "error") return

    switch (body?.error?.code) {
      case "context_length_exceeded":
        const m = typeof body?.error?.message === "string"
          ? body.error.message
          : "Input exceeds context window of this model"
        const tokenInfo = extractTokenCounts(m, responseBody)
        return {
          type: "context_overflow",
          message: m,
          responseBody,
          ...tokenInfo,
        }
      case "insufficient_quota":
        return {
          type: "api_error",
          message: "Quota exceeded. Check your plan and billing details.",
          isRetryable: false,
          responseBody,
        }
      case "usage_not_included":
        return {
          type: "api_error",
          message: "To use Codex with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus.",
          isRetryable: false,
          responseBody,
        }
      case "invalid_prompt":
        return {
          type: "api_error",
          message: typeof body?.error?.message === "string" ? body?.error?.message : "Invalid prompt.",
          isRetryable: false,
          responseBody,
        }
    }
  }

  export type ParsedAPICallError =
    | {
        type: "context_overflow"
        message: string
        responseBody?: string
        currentTokens?: number
        maxTokens?: number
      }
    | {
        type: "api_error"
        message: string
        statusCode?: number
        isRetryable: boolean
        responseHeaders?: Record<string, string>
        responseBody?: string
        metadata?: Record<string, string>
      }

  export function parseAPICallError(input: { providerID: string; error: APICallError }): ParsedAPICallError {
    const m = message(input.providerID, input.error)
    if (isOverflow(m)) {
      const tokenInfo = extractTokenCounts(m, input.error.responseBody)
      return {
        type: "context_overflow",
        message: m,
        responseBody: input.error.responseBody,
        ...tokenInfo,
      }
    }

    const metadata = input.error.url ? { url: input.error.url } : undefined
    return {
      type: "api_error",
      message: m,
      statusCode: input.error.statusCode,
      isRetryable: input.providerID.startsWith("openai")
        ? isOpenAiErrorRetryable(input.error)
        : input.error.isRetryable,
      responseHeaders: input.error.responseHeaders,
      responseBody: input.error.responseBody,
      metadata,
    }
  }
}
