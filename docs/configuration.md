# Configuration

## `.tokenleanrc.json`

Create in your project root or `~/.tokenleanrc.json` globally.

```json
{
  "output": {
    "maxLines": 100,
    "maxTokens": null
  },
  "skipDirs": [
    "generated",
    "vendor"
  ],
  "skipExtensions": [
    ".gen.ts"
  ],
  "importantDirs": [
    "domain",
    "core"
  ],
  "importantFiles": [
    "ARCHITECTURE.md"
  ],
  "externalContractFiles": [
    "src/my-copied-plugin.js"
  ],
  "unused": {
    "publicApiGlobs": [
      "sdk/src/**"
    ],
    "ignoreExports": [
      "PROVIDER_CATALOG",
      "src/api.mjs:internalButPublic"
    ]
  },
  "searchPatterns": {
    "hooks": {
      "description": "Find React hooks",
      "pattern": "use[A-Z]\\w+",
      "glob": "**/*.{ts,tsx}"
    }
  },
  "hotspots": {
    "days": 90
  },
  "structure": {
    "depth": 3
  },
  "cache": {
    "enabled": true,
    "ttl": 300,
    "maxSize": "100MB",
    "location": null
  }
}
```

Config values extend built-in defaults (they don't replace them).

### Output budgets

`output.maxLines` and `output.maxTokens` are production defaults for every CLI
that uses tokenlean's common output options. Command-line flags still override
them for a one-off call:

```bash
tl symbols src --max-lines 200 --max-tokens 12000
```

JSON output observes the same limits. When its primary result collection is
larger than `maxLines`, the response remains valid JSON and includes
`pagination` plus a `continuation` object. Continue a CLI page with the emitted
`continuation.cliArguments`, or an MCP page with
`continuation.arguments` (`offset` and `maxItems`). Nested arrays inside a
returned item are kept intact; pagination applies to one primary collection.

MCP calls default to 100 items and approximately 8,000 aggregate response
tokens when no tighter project/global output limit or request budget is
supplied. Read-only MCP callers can set `maxItems`, `maxTokens`, and `offset`;
configured limits act as ceilings, and continuations preserve the original
arguments so they can be invoked directly. Commands and mutations are
token-bounded but non-pageable, so a continuation can never replay a side
effect. The aggregate ceiling includes diagnostics and compatibility content.

`externalContractFiles` are project-relative paths copied/generated verbatim into another tool (so they can't import from your source). Their duplicate helpers are by-design, so `tl dupes`, `tl unused`, and `tl lookup` exclude them from their indexes by default. `tl dupes --include-contracts` opts them back in.

### Suppressing intentional unused exports (`unused`)

Library packages export public API that's consumed by external installers — code `tl unused`/`tl guard` can't see, so it flags those exports as unused forever. Mark them as intentional so guard stays green:

- **Inline** — add a `// tl-keep` (or `// tl-guard-ignore-unused`) comment on the export line or the line directly above it. Co-located and survives refactors:
  ```js
  export const PROVIDER_CATALOG = {...}; // tl-keep
  ```
- **`unused.publicApiGlobs`** — file globs whose exports are *all* treated as public API (e.g. an SDK's `sdk/src/**`). Supports `*`, `**`, `?`.
- **`unused.ignoreExports`** — specific exports to never flag. Each entry is a bare name (`"PROVIDER_CATALOG"`, matches that export in any file) or `"<glob>:<name>"` (`"src/api.mjs:foo"`, scopes the match to files matching the glob).

Suppressed exports are removed from the unused list but still counted — `tl unused --show-suppressed` lists them, and `tl guard` notes the count on a clean pass.

`publicApiGlobs` and `ignoreExports` belong under the `unused` section, but they're also honored if placed at the top level of `.tokenleanrc.json` (a common mistake) — tokenlean prints a one-line hint pointing you to the canonical spot and applies them anyway.

## Caching

tokenlean caches expensive operations with **git-based invalidation** — including ripgrep-backed searches, cached
JS/TS semantic facts for `tl symbols` and `tl snippet`, and the JS/TS dependency graph used by `tl deps` and
`tl impact`. Cache entries invalidate automatically on commits or file changes.

```bash
tl cache stats      # View cache statistics
tl cache clear      # Clear cache for current project
tl cache clear-all  # Clear all cached data
```

Disable with `TOKENLEAN_CACHE=0` or in config: `{"cache":{"enabled":false}}`
