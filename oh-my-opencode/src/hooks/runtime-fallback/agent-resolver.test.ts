import { describe, expect, test } from "bun:test"
import { normalizeAgentNameWithKnown } from "./agent-resolver"

describe("runtime-fallback agent resolver", () => {
  test("normalizes custom configured agent names", () => {
    const result = normalizeAgentNameWithKnown("Hephaestus-Custom", ["hephaestus-custom"])
    expect(result).toBe("hephaestus-custom")
  })

  test("still normalizes built-in agent names", () => {
    const result = normalizeAgentNameWithKnown("Sisyphus-Junior", [])
    expect(result).toBe("sisyphus-junior")
  })
})
