# Feature Behavior

## Pipeline behavior

The orchestrator runs these phases in order:

`INIT -> PLAN -> DISCOVER -> FIX -> INTEGRATE -> VERIFY -> PUBLISH -> DONE`

Expected behavior:

- Discovery agents run in parallel and remain read-only.
- Fix agents run in parallel with isolated worktrees.
- Integration merges fix branches into the integration branch.
- Verification runs on the merged result.
- Cleanup removes temporary worktrees and branches.

## Dashboard behavior

The terminal UI should provide:

- Active phase and completion progression
- Per-agent status and key metrics
- Token usage totals
- A recent activity log with error visibility

The user should not need to inspect raw logs to understand run state.

## Backend behavior

Supported backends are interchangeable through a common driver interface.

- Backend-specific argument quirks are handled in drivers.
- Malformed/missing output from one backend should not crash the whole run.
- Usage accounting must avoid double-counting.

## Git/worktree behavior

- Integration work is isolated from the user's normal branch state.
- Fix branches are merged with conflict handling that favors completed fixes.
- Cleanup is automatic unless explicitly disabled.

## Verification behavior

Verification should confirm merged fixes are still healthy and can apply minimal follow-up corrections if needed.

## Documentation maintenance behavior

When a change modifies product behavior or durable conventions:

1. Update this file and/or `product-intent.md`.
2. Keep notes concrete and future-useful.
3. Skip doc edits when the change is a one-off or non-durable detail.
