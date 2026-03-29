import { describe, expect, test } from "bun:test"
import { parsePluginEntry } from "./parse-plugin-entry"

const PACKAGE_NAME = "oh-my-opencode"

describe("parsePluginEntry", () => {
  test("returns unpinned for bare package name", () => {
    const pluginInfo = parsePluginEntry(["oh-my-opencode"], PACKAGE_NAME)

    expect(pluginInfo).not.toBeNull()
    expect(pluginInfo?.isPinned).toBe(false)
    expect(pluginInfo?.pinnedVersion).toBeNull()
  })

  test("returns unpinned for latest dist-tag", () => {
    const pluginInfo = parsePluginEntry(["oh-my-opencode@latest"], PACKAGE_NAME)

    expect(pluginInfo).not.toBeNull()
    expect(pluginInfo?.isPinned).toBe(false)
    expect(pluginInfo?.pinnedVersion).toBe("latest")
  })

  test("returns unpinned for beta dist-tag", () => {
    const pluginInfo = parsePluginEntry(["oh-my-opencode@beta"], PACKAGE_NAME)

    expect(pluginInfo).not.toBeNull()
    expect(pluginInfo?.isPinned).toBe(false)
    expect(pluginInfo?.pinnedVersion).toBe("beta")
  })

  test("returns pinned for explicit semver", () => {
    const pluginInfo = parsePluginEntry(["oh-my-opencode@3.5.2"], PACKAGE_NAME)

    expect(pluginInfo).not.toBeNull()
    expect(pluginInfo?.isPinned).toBe(true)
    expect(pluginInfo?.pinnedVersion).toBe("3.5.2")
  })
})
