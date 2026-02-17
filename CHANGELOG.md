# Changelog

All notable changes to tokenlean are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.15.3] - 2026-02-17

### Fixed
- `tl-snippet` now shows available symbols when a definition isn't found (eliminates the common agent pattern of failed snippet → separate tl-symbols call)

## [0.15.2] - 2026-02-17

### Fixed
- `tl-browse` auto-retries without `Accept: text/markdown` on HTTP 406 (fixes GitHub URLs and other sites that reject markdown content negotiation)
- `tl-browse` extracts `<main>` or `<article>` content before HTML conversion, removing site chrome (nav bars, sidebars, footers)
- `tl-browse` ignores `script`, `style`, `svg`, `noscript`, `form` tags during HTML conversion

## [0.15.0] - 2026-02-15

### Added
- **Agent Skills** — three ready-made workflows following the [Agent Skills](https://agentskills.io) spec:
  - `code-review` — PR review with blast radius, complexity, and targeted code reading
  - `explore-codebase` — understand an unfamiliar project in minutes
  - `safe-refactor` — rename, move, or extract code with impact verification
- `tl-prompt` restructured around core tools and decision rules (when to use tl-* vs. just reading the file)
- README: Essential tools tier (open by default), Agent Skills section

## [0.14.0] - 2026-02-14

### Added
- `tl-browse` — Fetch any URL as clean markdown (native markdown via Cloudflare, HTML conversion fallback)

## [0.13.0] - 2026-02-12

### Added
- `tl-analyze` — Composite file profile: chains symbols + deps + impact + complexity + related into one compact view
- `tl-snippet` — Extract function/class body by name (supports `Class.method` and `file:method` syntax)

### Fixed
- Shell injection eliminated across all git/rg calls via `src/shell.mjs` (`gitCommand`/`rgCommand` wrappers using `spawnSync` with array args)
- Unescaped `filePath` in `tl-analyze` subprocess invocation
- `tl-hotspots` days parameter validated as integer
- `tl-flow` now supports `Class.method` and `file:method` qualified name syntax
- `tl-flow` single-file search fixed (rg `-H` flag)
- `tl-unused` no longer crashes with ENOTDIR when given a single file
- Symlink loop protection in `traverse.mjs` (tracks real paths via `realpathSync`)

## [0.10.0] - 2026-02-05

### Added
- `tl-run` — Smart command runner with token-efficient output summaries
- `tl-npm` — Quick npm package lookup and comparison
- `tl-style` — Detect coding conventions from actual code
- `tl-stack` — Auto-detect project technology stack
- `tl-example` — Find diverse usage examples of a symbol or pattern
- `tl-context7` — Look up library docs via Context7 API
- `tl-playwright` — Headless browser content extraction

## [0.9.1] - 2026-02-04

### Changed
- Added mascot image (squirrel collecting tokens)
- Polished README with badges, navigation, and workflow examples

## [0.9.0] - 2026-02-01

### Added
- `tl-docs` — Extract JSDoc/TSDoc documentation from source files

### Fixed
- Executable permissions on all CLI tools

## [0.8.0] - 2026-02-01

### Added
- `tl-changelog` — Generate changelog from git commits

## [0.7.0] - 2026-02-01

### Added
- `tl-pr` — Summarize PR/branch changes for review

## [0.6.0] - 2026-02-01

### Added
- `tl-secrets` — Find hardcoded secrets and API keys in source code

## [0.5.0] - 2026-02-01

### Added
- `tl-schema` — Extract database schema from ORMs and migrations

## [0.4.0] - 2026-02-01

### Added
- `tl-name` — Check name availability across npm, GitHub, and domains
- `src/traverse.mjs` — Fast file system traversal module

### Changed
- Performance optimizations for `tl-structure` and `tl-context` using new traversal module

## [0.3.0] - 2026-01-31

### Added
- `tl-cache` — Manage ripgrep result cache (stats, clear, clear-all)
- `src/cache.mjs` — Disk-based LRU cache with git-based invalidation
- Cache integration for `tl-related`, `tl-search`, `tl-unused`, `tl-impact`, `tl-todo`, `tl-entry`
- Cache configuration in `.tokenleanrc.json`

## [0.2.0] - 2026-01-31

### Added
- 19 new tools: `tl-api`, `tl-blame`, `tl-complexity`, `tl-config`, `tl-coverage`, `tl-deps`, `tl-entry`, `tl-env`, `tl-exports`, `tl-flow`, `tl-history`, `tl-hotspots`, `tl-impact`, `tl-prompt`, `tl-routes`, `tl-symbols`, `tl-todo`, `tl-types`, `tl-unused`
- `src/output.mjs` — Shared output module with common flags (`-l`, `-t`, `-j`, `-q`, `-h`)
- `src/project.mjs` — Shared project module for file categorization and language detection
- JSON output mode for all tools

### Changed
- All original tools refactored to use shared modules
- Consistent flag support across all tools

## [0.1.0] - 2026-01-30

### Added
- Initial release with 6 tools: `tl-search`, `tl-context`, `tl-structure`, `tl-diff`, `tl-related`, `tl-component`
- Project renamed from `claude-search` to `tokenlean`

[Unreleased]: https://github.com/edimuj/tokenlean/compare/v0.10.0...HEAD
[0.10.0]: https://github.com/edimuj/tokenlean/compare/v0.9.1...v0.10.0
[0.9.1]: https://github.com/edimuj/tokenlean/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/edimuj/tokenlean/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/edimuj/tokenlean/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/edimuj/tokenlean/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/edimuj/tokenlean/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/edimuj/tokenlean/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/edimuj/tokenlean/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/edimuj/tokenlean/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/edimuj/tokenlean/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/edimuj/tokenlean/releases/tag/v0.1.0
