#!/usr/bin/env node
import React, { useEffect, useState } from 'react';
import { Command } from 'commander';
import { render } from 'ink';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { Dashboard } from './dashboard.js';
import { AgentReviewOrchestrator } from './orchestrator.js';
import type { Backend, OrchestratorConfig, RunSnapshot } from './types.js';

function parsePositiveInt(raw: string, label: string): number {
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function parseBackend(raw: string): Backend {
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'codex') return 'codex';
  if (normalized === 'claude-code' || normalized === 'claude' || normalized === 'cc') return 'claude-code';
  if (normalized === 'opencode' || normalized === 'oc') return 'opencode';
  if (normalized === 'mixed' || normalized === 'all') return 'mixed';
  throw new Error(`Unknown backend "${raw}". Supported: codex, claude-code, opencode, mixed`);
}

async function askForTargetPrompt(): Promise<string> {
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question('What should be reviewed? (describe the codebase area in natural language) ');
    return answer.trim() || 'current directory';
  } finally {
    rl.close();
  }
}

function DashboardApp({ orchestrator }: { orchestrator: AgentReviewOrchestrator }): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<RunSnapshot>(orchestrator.getSnapshot());

  useEffect(() => {
    return orchestrator.subscribe(setSnapshot);
  }, [orchestrator]);

  return <Dashboard snapshot={snapshot} />;
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name('agent-review')
    .description('Parallel agent-powered code review and fix orchestrator (supports Codex, Claude Code, OpenCode)')
    .argument('[instances]', 'Number of parallel agents')
    .option('-i, --instances <number>', 'Number of parallel agents')
    .option('-t, --target <prompt>', 'What to review (natural language or path)')
    .option('-b, --backend <name>', 'Agent backend: codex, claude-code, opencode, mixed (default: codex)')
    .option('-m, --model <name>', 'Model override for the backend')
    .option('--no-cleanup', 'Keep generated worktrees after run finishes')
    .option('--timeout <ms>', 'Overall timeout per agent in ms (default: 300000)')
    .option('--inactivity-timeout <ms>', 'Inactivity timeout per agent in ms (default: 120000)')
    .parse(process.argv);

  const opts = program.opts<{
    instances?: string;
    target?: string;
    backend?: string;
    model?: string;
    cleanup: boolean;
    timeout?: string;
    inactivityTimeout?: string;
  }>();

  const argInstances = program.args[0] as string | undefined;
  const rawInstances = opts.instances ?? argInstances ?? '2';
  const instances = parsePositiveInt(rawInstances, 'instances');
  const targetPrompt = opts.target?.trim() || (await askForTargetPrompt());
  const backend = parseBackend(opts.backend ?? 'codex');

  const config: OrchestratorConfig = {
    instances,
    targetPrompt,
    startCwd: process.cwd(),
    backend,
    model: opts.model?.trim() || undefined,
    cleanup: opts.cleanup,
    codexTimeoutMs: opts.timeout ? parsePositiveInt(opts.timeout, 'timeout') : undefined,
    codexInactivityTimeoutMs: opts.inactivityTimeout
      ? parsePositiveInt(opts.inactivityTimeout, 'inactivity-timeout')
      : undefined,
  };

  const orchestrator = new AgentReviewOrchestrator(config);
  const app = render(<DashboardApp orchestrator={orchestrator} />);
  const result = await orchestrator.run();

  await new Promise((resolve) => setTimeout(resolve, 250));
  app.unmount();

  if (result.success) {
    if (result.prUrl) {
      process.stdout.write(`\nPull request: ${result.prUrl}\n`);
    }
    if (result.integrationBranch) {
      process.stdout.write(`Branch: ${result.integrationBranch}\n`);
    }
    if (result.issueFile) {
      process.stdout.write(`Issue tracker: ${result.issueFile}\n`);
    }
    if (result.reportFile) {
      process.stdout.write(`Final report: ${result.reportFile}\n`);
    }
    if (result.integrationWorktree) {
      process.stdout.write(`Worktree: ${result.integrationWorktree}\n`);
    }
    return;
  }

  if (result.error) {
    process.stderr.write(`agent-review failed: ${result.error}\n`);
  }
  process.exitCode = 1;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`agent-review failed: ${message}\n`);
  process.exitCode = 1;
});
