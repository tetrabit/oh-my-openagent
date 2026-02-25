/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test"
import { parseAnthropicTokenLimitError } from "./parser"

describe("parseAnthropicTokenLimitError", () => {
  it("#given a standard token limit error string #when parsing #then extracts tokens", () => {
    //#given
    const error = "prompt is too long: 250000 tokens > 200000 maximum"

    //#when
    const result = parseAnthropicTokenLimitError(error)

    //#then
    expect(result).not.toBeNull()
    expect(result!.currentTokens).toBe(250000)
    expect(result!.maxTokens).toBe(200000)
  })

  it("#given a non-token-limit error #when parsing #then returns null", () => {
    //#given
    const error = { message: "internal server error" }

    //#when
    const result = parseAnthropicTokenLimitError(error)

    //#then
    expect(result).toBeNull()
  })

  it("#given null input #when parsing #then returns null", () => {
    //#given
    const error = null

    //#when
    const result = parseAnthropicTokenLimitError(error)

    //#then
    expect(result).toBeNull()
  })

  it("#given a proxy error with non-standard structure #when parsing #then returns null without crashing", () => {
    //#given
    const proxyError = {
      data: [1, 2, 3],
      error: "string-not-object",
      message: "Failed to process error response",
    }

    //#when
    const result = parseAnthropicTokenLimitError(proxyError)

    //#then
    expect(result).toBeNull()
  })

  it("#given a circular reference error #when parsing #then returns null without crashing", () => {
    //#given
    const circular: Record<string, unknown> = { message: "prompt is too long" }
    circular.self = circular

    //#when
    const result = parseAnthropicTokenLimitError(circular)

    //#then
    expect(result).not.toBeNull()
  })

  it("#given an error where data.responseBody has invalid JSON #when parsing #then handles gracefully", () => {
    //#given
    const error = {
      data: { responseBody: "not valid json {{{" },
      message: "prompt is too long with 300000 tokens exceeds 200000",
    }

    //#when
    const result = parseAnthropicTokenLimitError(error)

    //#then
    expect(result).not.toBeNull()
    expect(result!.currentTokens).toBe(300000)
    expect(result!.maxTokens).toBe(200000)
  })

  it("#given an error with data as a string (not object) #when parsing #then does not crash", () => {
    //#given
    const error = {
      data: "some-string-data",
      message: "token limit exceeded",
    }

    //#when
    const result = parseAnthropicTokenLimitError(error)

    //#then
    expect(result).not.toBeNull()
  })

  it("#given model_max_prompt_tokens_exceeded style message #when parsing #then extracts token counts", () => {
    //#given
    const error = {
      message: "prompt token count of 173954 exceeds the limit of 128000",
      data: {
        responseBody:
          '{"error":{"message":"prompt token count of 173954 exceeds the limit of 128000","code":"model_max_prompt_tokens_exceeded"}}',
      },
    }

    //#when
    const result = parseAnthropicTokenLimitError(error)

    //#then
    expect(result).not.toBeNull()
    expect(result!.currentTokens).toBe(173954)
    expect(result!.maxTokens).toBe(128000)
  })
})
