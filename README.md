# Agent Review CLI

Orchestrate parallel AI agents to review, fix, and integrate code changes across your codebase — all from a single command.

```
agent-review 4 -b claude-code -t "the authentication module"
```

```
┌──────────────────────────────────────────────────────────────────┐
│   AGENT REVIEW  via Claude Code              elapsed 2m 34s     │
│   run a1b2c3d4                               phase FIXING       │
│   main → src/auth, src/middleware                                │
└──────────────────────────────────────────────────────────────────┘
  ○ INIT ━━ ○ PLAN ━━ ● DISCOVER ━━ ◉ FIX ━━ ○ INTEGRATE ━━ ...

┌─ Issues ─────┐ ┌─ Agents ─────┐ ┌─ Tokens ─────┐
│ Found     12 │ │ Running    4 │ │ Input   240K │
│ Fixed      7 │ │ Done       2 │ │ Cached   89K │
│ Open       5 │ │ Failed     0 │ │ Output   45K │
└──────────────┘ └──────────────┘ └──────────────┘
```

## Features

- **Multi-agent parallelism** — spawn N agents that work simultaneously in isolated git worktrees
- **Full pipeline** — plan, discover, fix, integrate, verify, and publish a PR
- **Backend-agnostic** — swap between [Codex](https://github.com/openai/codex), [Claude Code](https://github.com/anthropics/claude-code), [OpenCode](https://github.com/sst/opencode), or mix them all
- **Live terminal dashboard** — real-time Ink-powered TUI with phase tracking, token usage, and per-agent status
- **Smart file partitioning** — directory-aware splitting keeps related files together for coherent reviews
- **Automatic integration** — merges agent branches, resolves conflicts, runs verification, opens a PR
- **Zero config** — point it at a repo and describe what to review in natural language

## Prerequisites

You need **Node.js 20+** and at least one supported AI coding agent installed:

| Backend | CLI | Install |
|---------|-----|---------|
| Codex | `codex` | `npm i -g @openai/codex` |
| Claude Code | `claude` | `npm i -g @anthropic-ai/claude-code` |
| OpenCode | `opencode` | `npm i -g opencode` |

You also need [`gh`](https://cli.github.com/) (GitHub CLI) if you want automatic PR creation.

## Install

```bash
npm install -g agent-review-cli
```

Or run directly with npx:

```bash
npx agent-review-cli 3 -b claude-code -t "the payments module"
```

## Usage

```bash
agent-review [instances] [options]
```

### Arguments

| Argument | Description |
|----------|-------------|
| `instances` | Number of parallel agents (default: 2) |

### Options

| Flag | Description |
|------|-------------|
| `-i, --instances <n>` | Number of parallel agents |
| `-t, --target <prompt>` | What to review — natural language or path |
| `-b, --backend <name>` | Backend: `codex`, `claude-code`, `opencode`, `mixed` (default: `codex`) |
| `-m, --model <name>` | Model override for the backend |
| `--no-cleanup` | Keep generated worktrees after the run |
| `--timeout <ms>` | Overall timeout per agent in ms (default: 300000) |
| `--inactivity-timeout <ms>` | Inactivity timeout per agent in ms (default: 120000) |

If `-t` is not provided, you'll be prompted interactively.

### Examples

```bash
# Review the whole repo with 4 Codex agents
agent-review 4

# Review a specific area with Claude Code
agent-review 3 -b claude-code -t "the API routes in src/api"

# Mix backends for variety
agent-review 6 -b mixed -t "error handling across the app"

# Keep worktrees for inspection
agent-review 2 -b opencode -t "database queries" --no-cleanup
```

## How It Works

```
INIT → PLAN → DISCOVER → FIX → INTEGRATE → VERIFY → PUBLISH → DONE
```

1. **Init** — resolves git root, current branch, creates a shared worktree
2. **Plan** — identifies target directories from your natural language prompt
3. **Discover** — N agents scan the codebase in parallel (read-only), finding bugs and issues with severity scores
4. **Fix** — N agents fix discovered issues in parallel, each in its own isolated git worktree
5. **Integrate** — merges all fix branches into a single integration branch with conflict resolution
6. **Verify** — a final agent runs type-checks, builds, and tests on the merged result
7. **Publish** — rebases onto the default branch, pushes, and creates a PR via `gh`

All temporary worktrees and branches are cleaned up automatically when the run finishes.

## Output

Run data is saved to `.agent-review/runs/<run-id>/`:

| File | Contents |
|------|----------|
| `issues.json` | All discovered issues with status, severity, and fix details |
| `final-report.md` | Verification summary and unresolved risks |

The CLI also prints the PR URL, branch name, and report path when the run completes.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, project structure, and how to add new backend drivers.

## License

[MIT](LICENSE)
