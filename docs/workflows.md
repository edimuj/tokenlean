# Workflows

Common task-oriented recipes using tokenlean tools.

## Starting on an unfamiliar codebase

```bash
tl advise "understand this repo" # Pick the cheapest first commands
tl pack onboard                 # One compact onboarding briefing
tl structure                    # Get the lay of the land
tl entry                        # Find entry points
tl exports src/lib/             # Understand the public API
tl docs src/utils/              # Read documentation, not code
tl types src/types/             # Understand data shapes
tl schema                       # Understand the database
```

## Before refactoring a file

```bash
tl advise "refactor src/core/auth.ts" # Pick a safe refactor path
tl pack refactor src/core/auth.ts # One compact refactor briefing
tl pack refactor src/core/auth.ts --budget 1200 # Smaller briefing; lower-priority sections omitted
tl impact src/core/auth.ts      # What would break?
tl deps src/core/auth.ts        # What does it depend on?
tl related src/core/auth.ts     # Find the tests
tl coverage src/core/auth.ts    # Is it well tested?
tl complexity src/core/auth.ts  # How complex is it?
```

## Understanding a component

```bash
tl component src/Button.tsx     # Props, hooks, dependencies
tl symbols src/Button.tsx       # Function signatures (or src/ for all)
tl symbols src/ --filter function # Functions only across directory
tl history src/Button.tsx       # Recent changes
tl blame src/Button.tsx         # Who wrote what
```

## Finding technical debt

```bash
tl complexity src/ --threshold 15  # Complex functions
tl unused src/                     # Dead code
tl todo                            # Outstanding TODOs
tl hotspots                        # Frequently changed (unstable?)
```

## Security check before committing

```bash
tl secrets                         # Scan for hardcoded secrets
tl secrets --staged                # Only check staged files
tl secrets --min-severity high     # Only high severity issues
```

## Reviewing a PR

```bash
tl advise "review PR 123"        # Pick review commands
tl pack pr 123                   # One compact PR briefing
tl pack review                   # Current branch/staged review context
tl pr feature-branch               # Summary of branch changes
tl pr 123                          # GitHub PR #123 (needs gh CLI)
tl pr --full                       # Include files, stats, commits
tl gh pr digest -R owner/repo 123  # Full status: CI, reviews, comments, readiness
tl gh pr comments -R owner/repo 123 --unresolved  # Unresolved review threads
```

## Preparing a release

```bash
tl changelog --unreleased          # What's new since last tag
tl changelog v0.1.0..v0.2.0       # Between versions
tl changelog --format compact      # Quick summary
tl gh release notes -R owner/repo --tag v1.2.0 --dry-run  # Preview auto-changelog
tl gh release notes -R owner/repo --tag v1.2.0             # Create GitHub release
```

## Starting a new project

```bash
tl name coolproject awesomelib     # Check npm, GitHub, domains
tl name myapp -s                   # Suggest variations if taken
tl npm express fastify koa         # Compare framework options
```

## Running commands efficiently

```bash
tl advise "debug npm test"         # Pick debug commands
tl pack debug "npm test"           # Test output plus follow-up checks
tl run "npm test"                  # Summarize test results
tl run "npm run build"             # Extract build errors only
tl run "eslint src/"               # Summarize lint violations
tl run "npm test" --raw            # Full output with stdout/stderr preserved
tl run "npm test" --raw -j         # Raw JSON includes separate stdout/stderr fields
tl run "npm test" -j               # Structured JSON output
tl tail logs/app.log               # Collapse repeats + surface errors/warnings
tl tail logs/app.log -f            # Follow file updates with compact summaries
npm test 2>&1 | tl tail            # Summarize piped logs
```

## Looking up documentation

```bash
tl browse https://docs.example.com/api  # Fetch docs as markdown
tl context7 react "useEffect"           # Look up React docs via Context7
tl context7 nextjs "app router"         # Next.js docs
tl npm lodash --deps                    # Check package dependencies
tl npm chalk --versions                 # Version history
```

## GitHub batch operations

```bash
# View an issue with all its sub-issues (one API call)
tl gh issue view -R owner/repo 434              # Bodies truncated to 5 lines
tl gh issue view -R owner/repo 434 --no-body    # Compact: titles + labels only
tl gh issue view -R owner/repo 434 --full       # Complete bodies

# Create issues in bulk from JSON
echo '[{"title":"Bug A","labels":["bug"]},{"title":"Bug B"}]' | \
  tl gh issue create-batch -R owner/repo --project edimuj/1

# Create an epic with sub-issues
echo '{"title":"Epic","children":[{"title":"Task 1"},{"title":"Task 2"}]}' | \
  tl gh issue create-tree -R owner/repo --project edimuj/1

# Sprint cleanup — close a batch with comment
tl gh issue close-batch -R owner/repo 10 11 12 -c "Sprint complete"

# Label triage
tl gh issue label-batch -R owner/repo --add "P1" --remove "triage" 5 6 7

# Land a PR (wait for CI, merge, close linked issues, delete branch)
tl gh pr land -R owner/repo 123 --method squash
```

## Extracting web content

```bash
tl browse https://example.com/docs        # Fast: native markdown or HTML conversion
tl browse https://example.com -t 2000     # Limit to ~2000 tokens
tl playwright example.com                 # Full: headless browser (JS-rendered pages)
tl playwright example.com -s "h1,h2,h3"  # Extract headings only
tl playwright example.com --screenshot p  # Save screenshot
```

## Measuring token savings

```bash
# run without install
npx --package tokenlean tl-audit --latest                  # Direct binary invocation via npx (binary name)
npx tokenlean audit --all --savings                        # Package entrypoint via npx

# provider-aware sessions
tl audit --provider claude --latest                       # Claude Code only
tl audit --codex --latest                                 # Codex only
tl audit --latest --savings                               # Auto-detect provider; combined summary
tl audit --all --plan                                     # Prioritized recommendations
tl audit --all --plan --github -R owner/repo              # Create a GitHub issue from the plan
tl audit --all --plan --github -R owner/repo --github-project owner/1 # Add issue to a project board

# output detail levels
tl audit --all --savings                                  # Summary only, across all matching sessions
tl audit -n 5 --verbose --savings                         # Add per-session detail
tl audit session.jsonl                                    # Analyze a specific session file
```

`tl audit` analyzes both Codex and Claude Code sessions:
- **Opportunities** — tokens wasted on large file reads, verbose build output, raw grep/cat/tail
- **Savings** (with `--savings`) — tokens already saved by tokenlean usage, with capture rate
- **Plan** (with `--plan`) — prioritized actions based on the highest saveable categories
- Add `--verbose` for per-session breakdown

```
Summary (270 sessions: 180 Claude Code, 90 Codex)
  Still saveable:     496k of 661k (75%)
  By provider:
  Claude Code       180 sessions     341k saveable     1.5M saved
  Codex              90 sessions     155k saveable     820k saved
  Already saved:      2.3M (531 tokenlean uses)
  Capture rate:       82% of potential savings realized
```

Install hooks to automatically nudge agents toward token-efficient alternatives:

```bash
# Claude Code — PreToolUse hooks (nudge toward better tools)
tl hook install claude-code        # Install hooks (auto-detects claude-rig)
tl hook install claude-code --global   # Force install to ~/.claude/
tl hook install claude-code --rig dev  # Install to a specific rig
tl hook status claude-code         # Check what's active
tl hook uninstall claude-code      # Remove hooks

# Open Code — plugin (auto-wraps commands with tl run/tl browse)
tl hook install opencode           # Install plugin to ~/.config/opencode/plugins/
tl hook status opencode            # Check if installed
tl hook uninstall opencode         # Remove plugin
```
