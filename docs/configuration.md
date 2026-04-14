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
