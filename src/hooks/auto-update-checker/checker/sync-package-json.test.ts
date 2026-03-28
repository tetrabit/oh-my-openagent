import { describe, expect, it, mock, spyOn } from "bun:test"
import { randomUUID } from "node:crypto"
import * as nodeFs from "node:fs"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PluginEntryInfo } from "./plugin-entry"

const PACKAGE_NAME = "oh-my-opencode"

mock.module("../../../shared/logger", () => ({
  log: () => {},
}))

function resetTestCache(cacheDir: string, currentVersion = "3.10.0"): void {
  if (existsSync(cacheDir)) {
    rmSync(cacheDir, { recursive: true, force: true })
  }

  mkdirSync(cacheDir, { recursive: true })
  writeFileSync(
    join(cacheDir, "package.json"),
    JSON.stringify({ dependencies: { "oh-my-opencode": currentVersion, other: "1.0.0" } }, null, 2)
  )
}

function cleanupTestCache(cacheDir: string): void {
  if (existsSync(cacheDir)) {
    rmSync(cacheDir, { recursive: true, force: true })
  }
}

function readCachePackageJsonVersion(cacheDir: string): string | undefined {
  const content = readFileSync(join(cacheDir, "package.json"), "utf-8")
  const pkg = JSON.parse(content) as { dependencies?: Record<string, string> }
  return pkg.dependencies?.["oh-my-opencode"]
}

function createTestContext(initialVersion = "3.10.0"): {
  cacheDir: string
  syncOptions: { cacheDir: string; packageName: string }
  readVersion: () => string | undefined
  cleanup: () => void
} {
  const cacheDir = join(tmpdir(), `omo-sync-cache-${randomUUID()}`)
  resetTestCache(cacheDir, initialVersion)
  return {
    cacheDir,
    syncOptions: {
      cacheDir,
      packageName: PACKAGE_NAME,
    },
    readVersion: () => readCachePackageJsonVersion(cacheDir),
    cleanup: () => cleanupTestCache(cacheDir),
  }
}

async function importFreshSyncModule(): Promise<typeof import("./sync-package-json")> {
  return import(`./sync-package-json?test-${Date.now()}-${Math.random()}`)
}

describe("syncCachePackageJsonToIntent", () => {
  describe("#given cache package.json with pinned semver version", () => {
    describe("#when opencode.json intent is latest tag", () => {
      it("#then updates package.json to use latest", async () => {
        const testContext = createTestContext()
        try {
          const { syncCachePackageJsonToIntent } = await importFreshSyncModule()

          const pluginInfo: PluginEntryInfo = {
            entry: "oh-my-opencode@latest",
            isPinned: false,
            pinnedVersion: "latest",
            configPath: "/tmp/opencode.json",
          }

          const result = syncCachePackageJsonToIntent(pluginInfo, testContext.syncOptions)

          expect(result.synced).toBe(true)
          expect(result.error).toBeNull()
          expect(testContext.readVersion()).toBe("latest")
        } finally {
          testContext.cleanup()
        }
      })
    })

    describe("#when opencode.json intent is next tag", () => {
      it("#then updates package.json to use next", async () => {
        const testContext = createTestContext()
        try {
          const { syncCachePackageJsonToIntent } = await importFreshSyncModule()

          const pluginInfo: PluginEntryInfo = {
            entry: "oh-my-opencode@next",
            isPinned: false,
            pinnedVersion: "next",
            configPath: "/tmp/opencode.json",
          }

          const result = syncCachePackageJsonToIntent(pluginInfo, testContext.syncOptions)

          expect(result.synced).toBe(true)
          expect(result.error).toBeNull()
          expect(testContext.readVersion()).toBe("next")
        } finally {
          testContext.cleanup()
        }
      })
    })

    describe("#when opencode.json has no version (implies latest)", () => {
      it("#then updates package.json to use latest", async () => {
        const testContext = createTestContext()
        try {
          const { syncCachePackageJsonToIntent } = await importFreshSyncModule()

          const pluginInfo: PluginEntryInfo = {
            entry: "oh-my-opencode",
            isPinned: false,
            pinnedVersion: null,
            configPath: "/tmp/opencode.json",
          }

          const result = syncCachePackageJsonToIntent(pluginInfo, testContext.syncOptions)

          expect(result.synced).toBe(true)
          expect(result.error).toBeNull()
          expect(testContext.readVersion()).toBe("latest")
        } finally {
          testContext.cleanup()
        }
      })
    })
  })

  describe("#given cache package.json already matches intent", () => {
    it("#then returns synced false with no error", async () => {
      const testContext = createTestContext("latest")
      try {
        const { syncCachePackageJsonToIntent } = await importFreshSyncModule()

        const pluginInfo: PluginEntryInfo = {
          entry: "oh-my-opencode@latest",
          isPinned: false,
          pinnedVersion: "latest",
          configPath: "/tmp/opencode.json",
        }

        const result = syncCachePackageJsonToIntent(pluginInfo, testContext.syncOptions)

        expect(result.synced).toBe(false)
        expect(result.error).toBeNull()
        expect(testContext.readVersion()).toBe("latest")
      } finally {
        testContext.cleanup()
      }
    })
  })

  describe("#given cache package.json does not exist", () => {
    it("#then returns file_not_found error", async () => {
      const testContext = createTestContext()
      try {
        testContext.cleanup()
        const { syncCachePackageJsonToIntent } = await importFreshSyncModule()

        const pluginInfo: PluginEntryInfo = {
          entry: "oh-my-opencode@latest",
          isPinned: false,
          pinnedVersion: "latest",
          configPath: "/tmp/opencode.json",
        }

        const result = syncCachePackageJsonToIntent(pluginInfo, testContext.syncOptions)

        expect(result.synced).toBe(false)
        expect(result.error).toBe("file_not_found")
      } finally {
        testContext.cleanup()
      }
    })
  })

  describe("#given plugin not in cache package.json dependencies", () => {
    it("#then returns plugin_not_in_deps error", async () => {
      const testContext = createTestContext()
      try {
        writeFileSync(
          join(testContext.cacheDir, "package.json"),
          JSON.stringify({ dependencies: { other: "1.0.0" } }, null, 2)
        )

        const { syncCachePackageJsonToIntent } = await importFreshSyncModule()

        const pluginInfo: PluginEntryInfo = {
          entry: "oh-my-opencode@latest",
          isPinned: false,
          pinnedVersion: "latest",
          configPath: "/tmp/opencode.json",
        }

        const result = syncCachePackageJsonToIntent(pluginInfo, testContext.syncOptions)

        expect(result.synced).toBe(false)
        expect(result.error).toBe("plugin_not_in_deps")
      } finally {
        testContext.cleanup()
      }
    })
  })

  describe("#given user explicitly changed from one semver to another", () => {
    it("#then updates package.json to new version", async () => {
      const testContext = createTestContext("3.9.0")
      try {
        const { syncCachePackageJsonToIntent } = await importFreshSyncModule()

        const pluginInfo: PluginEntryInfo = {
          entry: "oh-my-opencode@3.10.0",
          isPinned: true,
          pinnedVersion: "3.10.0",
          configPath: "/tmp/opencode.json",
        }

        const result = syncCachePackageJsonToIntent(pluginInfo, testContext.syncOptions)

        expect(result.synced).toBe(true)
        expect(result.error).toBeNull()
        expect(testContext.readVersion()).toBe("3.10.0")
      } finally {
        testContext.cleanup()
      }
    })
  })

  describe("#given cache package.json with other dependencies", () => {
    it("#then other dependencies are preserved when updating plugin version", async () => {
      const testContext = createTestContext()
      try {
        const { syncCachePackageJsonToIntent } = await importFreshSyncModule()

        const pluginInfo: PluginEntryInfo = {
          entry: "oh-my-opencode@latest",
          isPinned: false,
          pinnedVersion: "latest",
          configPath: "/tmp/opencode.json",
        }

        const result = syncCachePackageJsonToIntent(pluginInfo, testContext.syncOptions)

        expect(result.synced).toBe(true)
        expect(result.error).toBeNull()

        const content = readFileSync(join(testContext.cacheDir, "package.json"), "utf-8")
        const pkg = JSON.parse(content) as { dependencies?: Record<string, string> }
        expect(pkg.dependencies?.["other"]).toBe("1.0.0")
      } finally {
        testContext.cleanup()
      }
    })
  })

  describe("#given malformed JSON in cache package.json", () => {
    it("#then returns parse_error", async () => {
      const testContext = createTestContext()
      try {
        writeFileSync(join(testContext.cacheDir, "package.json"), "{ invalid json }")

        const { syncCachePackageJsonToIntent } = await importFreshSyncModule()

        const pluginInfo: PluginEntryInfo = {
          entry: "oh-my-opencode@latest",
          isPinned: false,
          pinnedVersion: "latest",
          configPath: "/tmp/opencode.json",
        }

        const result = syncCachePackageJsonToIntent(pluginInfo, testContext.syncOptions)

        expect(result.synced).toBe(false)
        expect(result.error).toBe("parse_error")
      } finally {
        testContext.cleanup()
      }
    })
  })

  describe("#given write permission denied", () => {
    it("#then returns write_error", async () => {
      const testContext = createTestContext("3.10.0")
      const writeFileSyncSpy = spyOn(nodeFs, "writeFileSync").mockImplementation((() => {
        throw new Error("EACCES: permission denied")
      }) as typeof nodeFs.writeFileSync)

      try {
        const { syncCachePackageJsonToIntent } = await importFreshSyncModule()

        const pluginInfo: PluginEntryInfo = {
          entry: "oh-my-opencode@latest",
          isPinned: false,
          pinnedVersion: "latest",
          configPath: "/tmp/opencode.json",
        }

        const result = syncCachePackageJsonToIntent(pluginInfo, testContext.syncOptions)

        expect(result.synced).toBe(false)
        expect(result.error).toBe("write_error")
      } finally {
        writeFileSyncSpy.mockRestore()
        testContext.cleanup()
      }
    })
  })

  describe("#given rename fails after successful write", () => {
    it("#then returns write_error and cleans up temp file", async () => {
      const testContext = createTestContext("3.10.0")
      const originalWriteFileSync = nodeFs.writeFileSync

      let tempFilePath: string | null = null

      const writeFileSyncSpy = spyOn(nodeFs, "writeFileSync").mockImplementation(
        ((path: Parameters<typeof nodeFs.writeFileSync>[0], data: Parameters<typeof nodeFs.writeFileSync>[1]) => {
          tempFilePath = String(path)
          return originalWriteFileSync(path, data)
        }) as typeof nodeFs.writeFileSync
      )
      const renameSyncSpy = spyOn(nodeFs, "renameSync").mockImplementation((() => {
        throw new Error("EXDEV: cross-device link not permitted")
      }) as typeof nodeFs.renameSync)

      try {
        const { syncCachePackageJsonToIntent } = await importFreshSyncModule()

        const pluginInfo: PluginEntryInfo = {
          entry: "oh-my-opencode@latest",
          isPinned: false,
          pinnedVersion: "latest",
          configPath: "/tmp/opencode.json",
        }

        const result = syncCachePackageJsonToIntent(pluginInfo, testContext.syncOptions)

        expect(result.synced).toBe(false)
        expect(result.error).toBe("write_error")
        expect(tempFilePath).not.toBeNull()
        expect(existsSync(tempFilePath!)).toBe(false)
      } finally {
        writeFileSyncSpy.mockRestore()
        renameSyncSpy.mockRestore()
        testContext.cleanup()
      }
    })
  })
})
