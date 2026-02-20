# Product Intent

## Purpose

`agent-review-cli` is an automated review-and-fix loop for codebases. It should let a user request a review once and receive:

1. Parallel issue discovery
2. Parallel fixes in isolated worktrees
3. Integrated verification on merged fixes
4. A clean publish flow with branch/PR output

## What "good" looks like

- The run is resilient to individual agent failures.
- The UI always reflects current pipeline state without guesswork.
- Git operations are safe, reproducible, and cleaned up after completion.
- Output artifacts make it easy to inspect what happened.

## Non-goals

- Replacing human product decisions
- Hiding failures or uncertain results
- Mutating unrelated repository state outside the run scope

## User-facing expectations

- A single command can start a full loop.
- Progress is visible in real time.
- Failures are attributed clearly to phase/agent.
- Final output includes what changed and how it was verified.

## Decision guidance for future changes

When adding or modifying behavior, prefer:

- Simpler, deterministic orchestration
- Better observability over silent automation
- Durable compatibility across supported agent backends
