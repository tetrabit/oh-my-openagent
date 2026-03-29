# DONOTDO.md

## Pull Requests

We will **NOT** be submitting pull requests to either repository:

1. **oh-my-opencode** - https://github.com/code-yeongyu/oh-my-opencode
2. **OpenCode Platform** - https://github.com/code-yeongyu/opencode

## Rationale

While both repositories have issues that could be fixed with PRs:

- oh-my-opencode PR #1777 - Runtime fallback text pattern detection
- OpenCode Platform - Pass original error through to session.error events

...we are choosing NOT to contribute these changes back upstream.

## Reason

The user prefers to maintain local patches rather than engage with upstream repositories.

## Local Changes Maintained

- Patched `constants.ts` in oh-my-opencode with relaxed error patterns
- Manual package replacement in `~/.cache/opencode/node_modules/oh-my-opencode/`

## If Upstream Changes

If either repository merges relevant changes:
1. Test the upstream version first
2. If working, remove local patches
3. If not working, continue maintaining local patches
