# Contributing to Agent Review CLI

Thanks for your interest in contributing! This guide will help you get started.

## Getting Started

1. **Fork** the repo and clone your fork
2. Install dependencies:
   ```bash
   npm install
   ```
3. Build the project:
   ```bash
   npm run build
   ```
4. Link globally for local testing:
   ```bash
   npm link
   ```

## Development Workflow

### Building

```bash
npm run build        # Bundle with tsup (fast, no type-checking)
npm run type-check   # Run TypeScript compiler checks
```

**Important:** The build uses tsup (esbuild) which does **not** report TypeScript errors. Always run `npm run type-check` before submitting a PR.

### Testing locally

```bash
npm run type-check && npm run build && npm link
agent-review 3 -b claude-code -t "the auth module"
```

### Project structure

```
src/
  index.tsx          # CLI entry point (Commander + Ink app mount)
  orchestrator.ts    # Core pipeline — phases, agents, git, prompts
  dashboard.tsx      # Terminal UI components (Ink/React)
  types.ts           # Shared TypeScript types
bin/
  agent-review.js    # Thin entry shim that imports dist/index.js
docs/
  product-intent.md  # Product goals and non-goals
  feature-behavior.md # Expected pipeline behavior
```

## Submitting Changes

1. Create a branch from `main`
2. Make your changes
3. Run `npm run type-check` to ensure there are no TypeScript errors
4. Run `npm run build` to verify the build succeeds
5. Test your changes locally with `agent-review`
6. Open a pull request with a clear description of what changed and why

### PR Guidelines

- Keep PRs focused — one feature or fix per PR
- Include a description of what the change does and why
- If adding a new backend driver, follow the existing `BackendDriver` interface pattern
- If modifying the TUI, describe the visual change

## Adding a New Backend

To add support for a new AI coding agent:

1. Implement the `BackendDriver` interface in `orchestrator.ts`:
   - `checkVersion()` — verify the CLI is installed
   - `buildArgs()` — construct the command-line arguments
   - `parseStdoutLine()` — parse JSONL output for token tracking
2. Add the backend name to the `Backend` type in `types.ts`
3. Update the `BACKEND_LABEL` map in `dashboard.tsx`
4. Update the `parseBackend` function in `index.tsx`
5. Add detection logic in `detectAvailableBackends`

## Reporting Issues

- Use [GitHub Issues](https://github.com/Open-Document-Alliance/Agent-Review-CLI/issues)
- Include your Node.js version, OS, and which backend you're using
- Include the full error output if applicable

## Code Style

- TypeScript strict mode
- ESM modules
- Async/await (no callbacks)
- React hooks must be called unconditionally (no hooks after early returns)

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
