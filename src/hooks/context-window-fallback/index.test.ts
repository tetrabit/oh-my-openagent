import { describe, expect, it } from "bun:test";
import { detectFallbackReason } from "./index";

describe("context-window-fallback detectFallbackReason", () => {
  it("detects context overflow errors", () => {
    // #given
    const error = {
      name: "ContextOverflowError",
      data: {
        message: "This message would exceed the model context window",
        currentTokens: 245000,
        maxTokens: 200000,
      },
    };

    // #when
    const result = detectFallbackReason(error);

    // #then
    expect(result).toBe("context_overflow");
  });

  it("detects non-retryable account rate limit message", () => {
    // #given
    const error = {
      name: "APIError",
      data: {
        message: "This request would exceed your account's rate limit. Please try again later.",
        isRetryable: false,
      },
    };

    // #when
    const result = detectFallbackReason(error);

    // #then
    expect(result).toBe("rate_limit");
  });

  it("detects HTTP 429 errors", () => {
    // #given
    const error = {
      name: "APIError",
      data: {
        message: "Too Many Requests",
        statusCode: 429,
      },
    };

    // #when
    const result = detectFallbackReason(error);

    // #then
    expect(result).toBe("rate_limit");
  });

  it("detects quota errors from response body", () => {
    // #given
    const error = {
      name: "APIError",
      data: {
        message: "API call failed",
        responseBody: JSON.stringify({
          error: {
            code: "insufficient_quota",
            message: "Quota exceeded.",
          },
        }),
      },
    };

    // #when
    const result = detectFallbackReason(error);

    // #then
    expect(result).toBe("rate_limit");
  });

  it("returns null for unrelated API errors", () => {
    // #given
    const error = {
      name: "APIError",
      data: {
        message: "The request payload is invalid.",
        statusCode: 400,
      },
    };

    // #when
    const result = detectFallbackReason(error);

    // #then
    expect(result).toBeNull();
  });
});
