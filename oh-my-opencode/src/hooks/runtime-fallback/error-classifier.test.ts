import { describe, expect, test } from "bun:test"
import { classifyErrorType, isRetryableError } from "./error-classifier"

describe("runtime-fallback error classifier", () => {
  test("treats token refresh failures as retryable recovery candidates", () => {
    const error = {
      name: "UnknownError",
      data: {
        message: "Error: Token refresh failed: 400",
      },
    }

    expect(classifyErrorType(error)).toBe("token_refresh_failed")
    expect(isRetryableError(error, [400, 429, 503, 529])).toBe(true)
  })

  test("classifies invalid grant refresh failures separately", () => {
    const error = {
      name: "TokenRefreshError",
      message: "Token refresh failed: 400 invalid_grant refresh token revoked",
    }

    expect(classifyErrorType(error)).toBe("token_refresh_auth_failed")
  })
})
