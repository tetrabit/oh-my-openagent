# Bun Test Handoff

## Current status

`bun test` discovery has already been constrained to this package, but the full suite is still not green.

The current first focused blocker is in:

- [src/tools/delegate-task/tools.test.ts](/home/nullvoid/projects/oh-my-openagent/src/tools/delegate-task/tools.test.ts#L738)

Command to reproduce:

```bash
bun test src/tools/delegate-task/tools.test.ts --bail=1 --only-failures
```

Current failure:

```text
Expected to contain: "Model not configured"
Received: "Background task launched"
```

Failing test:

```text
sisyphus-task > category delegation config validation > returns clear error when no model can be resolved
```

## What was already fixed

Raw Bun discovery no longer recurses into the nested `oh-my-opencode/` snapshot.

Relevant files:

- [bunfig.toml](/home/nullvoid/projects/oh-my-openagent/bunfig.toml)
- [script/run-tests.ts](/home/nullvoid/projects/oh-my-openagent/script/run-tests.ts)
- [src/external-tests/bin-platform-root.test.ts](/home/nullvoid/projects/oh-my-openagent/src/external-tests/bin-platform-root.test.ts)
- [src/external-tests/build-binaries-root.test.ts](/home/nullvoid/projects/oh-my-openagent/src/external-tests/build-binaries-root.test.ts)
- [src/external-tests/build-schema-root.test.ts](/home/nullvoid/projects/oh-my-openagent/src/external-tests/build-schema-root.test.ts)

Several mock-leak and fresh-import issues were already stabilized across the suite, including `delegate-task`, `prometheus-md-only`, `runtime-fallback`, `context-window-fallback`, MCP OAuth, and skill MCP manager tests.

## Likely next work

The remaining hot spot is still [src/tools/delegate-task/tools.test.ts](/home/nullvoid/projects/oh-my-openagent/src/tools/delegate-task/tools.test.ts).

Most likely follow-up:

1. Continue converting any remaining `createDelegateTask` cases to fresh imports instead of cached `require("./tools")`.
2. Make the failing category-resolution path deterministic by explicitly mocking model resolution and executor behavior in the `no model can be resolved` case.
3. Re-run the focused file until it is green:

```bash
bun test src/tools/delegate-task/tools.test.ts --bail=1 --only-failures
```

4. Then re-run the wider suite:

```bash
bun test --bail=1 --only-failures
```

## Constraints and notes

- `td` is unavailable in this environment: `td: command not found`.
- Do not revert unrelated existing worktree changes.
- Existing modified files include [.gitignore](/home/nullvoid/projects/oh-my-openagent/.gitignore) and [assets/oh-my-opencode.schema.json](/home/nullvoid/projects/oh-my-openagent/assets/oh-my-opencode.schema.json).
- Existing untracked support files include [script/run-tests.ts](/home/nullvoid/projects/oh-my-openagent/script/run-tests.ts) and [src/external-tests/bin-platform-root.test.ts](/home/nullvoid/projects/oh-my-openagent/src/external-tests/bin-platform-root.test.ts).

## Suggested starting point

Open the failing block around [src/tools/delegate-task/tools.test.ts](/home/nullvoid/projects/oh-my-openagent/src/tools/delegate-task/tools.test.ts#L738) and compare it with the nearby category-resolution tests that were already converted to fresh imports and explicit resolver mocks. The current symptom suggests the test setup is still allowing the normal background launch path instead of forcing the unresolved-model error path.
