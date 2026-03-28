import { describe, expect, test } from "bun:test"
import { selectFallbackProviderWithConnectedProviders, shouldRetryError } from "./model-error-classifier"

describe("model-error-classifier", () => {
  test("treats overloaded retry messages as retryable", () => {
    //#given
    const error = { message: "Provider is overloaded" }

    //#when
    const result = shouldRetryError(error)

    //#then
    expect(result).toBe(true)
  })

  test("treats cooling-down auto-retry messages as retryable", () => {
    //#given
    const error = {
      message:
        "All credentials for model claude-opus-4-6-thinking are cooling down [retrying in ~5 days attempt #1]",
    }

    //#when
    const result = shouldRetryError(error)

    //#then
    expect(result).toBe(true)
  })

  test("selectFallbackProvider prefers first connected provider in preference order", () => {
    //#given
    const connectedProviders = ["anthropic", "nvidia"]

    //#when
    const provider = selectFallbackProviderWithConnectedProviders(
      ["anthropic", "nvidia"],
      "nvidia",
      connectedProviders,
    )

    //#then
    expect(provider).toBe("anthropic")
  })

  test("selectFallbackProvider falls back to next connected provider when first is disconnected", () => {
    //#given
    const connectedProviders = ["nvidia"]

    //#when
    const provider = selectFallbackProviderWithConnectedProviders(
      ["anthropic", "nvidia"],
      undefined,
      connectedProviders,
    )

    //#then
    expect(provider).toBe("nvidia")
  })

  test("selectFallbackProvider uses provider preference order when cache is missing", () => {
    //#given - no cache file

    //#when
    const provider = selectFallbackProviderWithConnectedProviders(
      ["anthropic", "nvidia"],
      "nvidia",
      undefined,
    )

    //#then
    expect(provider).toBe("anthropic")
  })

  test("selectFallbackProvider uses connected preferred provider when fallback providers are unavailable", () => {
    //#given
    const connectedProviders = ["provider-x"]

    //#when
    const provider = selectFallbackProviderWithConnectedProviders(
      ["provider-y"],
      "provider-x",
      connectedProviders,
    )

    //#then
    expect(provider).toBe("provider-x")
  })

  test("treats FreeUsageLimitError (PascalCase name) as retryable by name", () => {
    //#given
    const error = { name: "FreeUsageLimitError" }

    //#when
    const result = shouldRetryError(error)

    //#then
    expect(result).toBe(true)
  })

  test("treats freeusagelimiterror (lowercase name) as retryable by name", () => {
    //#given
    const error = { name: "freeusagelimiterror" }

    //#when
    const result = shouldRetryError(error)

    //#then
    expect(result).toBe(true)
  })
})
