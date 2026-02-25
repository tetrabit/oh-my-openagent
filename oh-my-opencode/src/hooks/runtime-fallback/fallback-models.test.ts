import { describe, expect, test } from "bun:test"
import { getFallbackModelsForSession } from "./fallback-models"
import type { OhMyOpenCodeConfig } from "../../config"

describe("runtime-fallback fallback-model resolution", () => {
  test("uses custom configured agent fallback models when agent is not detected", () => {
    const config: OhMyOpenCodeConfig = {
      agents: {
        hephaestus: {
          fallback_models: ["openai/gpt-5.3-codex", "openai/gpt-5.2"],
        },
      },
    }

    const result = getFallbackModelsForSession("ses_test_no_agent", undefined, config)
    expect(result).toEqual(["openai/gpt-5.3-codex", "openai/gpt-5.2"])
  })
})
