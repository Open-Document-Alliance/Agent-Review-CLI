import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import {
  type AgentSnapshot,
  type Backend,
  type CodexExecResult,
  type DiscoveryOutput,
  type FixOutput,
  type IssueRecord,
  type IssueSeverity,
  type IssueStore,
  type OrchestratorConfig,
  type OrchestratorResult,
  type RunSnapshot,
  type TokenUsage,
  type VerificationOutput,
} from './types.js';

const REVIEWABLE_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.json', '.md', '.mdx',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.dart', '.php',
  '.cs', '.scala', '.c', '.h', '.cpp', '.cc', '.hpp', '.sql', '.yml',
  '.yaml', '.toml', '.sh', '.zsh',
]);

const BINARY_FILE_PATTERN =
  /\.(png|jpe?g|gif|webp|ico|bmp|svgz?|pdf|woff2?|ttf|eot|zip|gz|tgz|7z|mp3|mp4|mov|avi|wasm|jar|class|dll|so|dylib|exe)$/i;

const IGNORED_PATH_SEGMENTS = [
  '/node_modules/', '/dist/', '/build/', '/coverage/',
  '/.next/', '/.turbo/', '/.git/', '/vendor/',
];

type WorktreeSpec = {
  label: string;
  branch: string;
  path: string;
};

type DiscoverySchema = {
  summary: string;
  issues: Array<{
    title: string;
    description: string;
    suggested_fix: string;
    severity: IssueSeverity;
    location: { file: string; line: number | null };
    confidence: number | null;
  }>;
};

const EMPTY_USAGE: TokenUsage = { input: 0, cachedInput: 0, output: 0 };
const RETRYABLE_CODEX_FAILURES = [
  'failed to install system skills',
  'no last agent message',
  'wrote empty content',
  'stream disconnected before completion',
];

class VerificationFailure extends Error {}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeSlashes(input: string): string {
  return input.replaceAll(path.sep, '/');
}

function isInsidePath(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function parseJson<T>(raw: string): T {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('Expected JSON content but got empty string');
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      throw new Error('Unable to parse JSON payload');
    }
    return JSON.parse(trimmed.slice(start, end + 1)) as T;
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; allowFailure?: boolean; stdin?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: process.env,
    stdio: 'pipe',
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });

  if (options.stdin !== undefined) {
    child.stdin.end(options.stdin);
  } else {
    child.stdin.end();
  }

  const code = await new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (exitCode) => resolve(exitCode ?? 1));
  });

  if (code !== 0 && !options.allowFailure) {
    throw new Error(`Command failed (${command} ${args.join(' ')}): ${stderr.trim() || stdout.trim()}`);
  }

  return { code, stdout, stderr };
}

/* -- Backend abstraction ------------------------------------------ */

interface BackendDriver {
  /** Check the backend CLI is available */
  checkVersion(): Promise<void>;
  /** Build CLI args for an agent exec call */
  buildArgs(input: {
    yolo: boolean;
    model?: string;
    schemaPath: string;
    outputPath: string;
    prompt: string;
  }): { command: string; args: string[] };
  /** Parse a single JSON line from stdout, returning token increments and messages */
  parseStdoutLine(parsed: Record<string, unknown>): {
    tokenIncrement?: TokenUsage;
    message?: string;
  };
}

function createCodexDriver(): BackendDriver {
  return {
    async checkVersion() {
      await runCommand('codex', ['--version']);
    },
    buildArgs(input) {
      const args: string[] = [];
      if (input.yolo) {
        args.push('--dangerously-bypass-approvals-and-sandbox');
      } else {
        args.push('-s', 'read-only');
      }
      if (input.model) args.push('-m', input.model);
      args.push('exec', '--json', '--output-schema', input.schemaPath, '-o', input.outputPath, input.prompt);
      return { command: 'codex', args };
    },
    parseStdoutLine(parsed) {
      const result: { tokenIncrement?: TokenUsage; message?: string } = {};
      const type = parsed.type as string | undefined;
      if (type === 'turn.completed') {
        const usage = parsed.usage as Record<string, number> | undefined;
        if (usage) {
          result.tokenIncrement = {
            input: usage.input_tokens ?? 0,
            cachedInput: usage.cached_input_tokens ?? 0,
            output: usage.output_tokens ?? 0,
          };
        }
      } else if (type === 'item.completed') {
        const item = parsed.item as Record<string, unknown> | undefined;
        if (item?.type === 'agent_message' && typeof item.text === 'string') {
          result.message = item.text.slice(0, 600);
        }
      } else if (type === 'error' || type === 'turn.failed') {
        // Capture API errors (schema validation, quota, etc.)
        const errMsg = (parsed.message ?? (parsed.error as Record<string, unknown>)?.message) as string | undefined;
        if (typeof errMsg === 'string') {
          result.message = `Error: ${errMsg.slice(0, 500)}`;
        }
      }
      return result;
    },
  };
}

function createClaudeCodeDriver(): BackendDriver {
  return {
    async checkVersion() {
      await runCommand('claude', ['--version']);
    },
    buildArgs(input) {
      const args: string[] = ['-p', input.prompt, '--output-format', 'stream-json', '--verbose'];
      if (input.model) args.push('--model', input.model);
      if (!input.yolo) {
        args.push('--allowedTools', 'Read,Glob,Grep,Bash(git status),Bash(git diff),Bash(git log)');
      }
      // Claude Code doesn't have --output-schema; we embed schema instructions in the prompt
      // and write the output file ourselves after parsing
      return { command: 'claude', args };
    },
    parseStdoutLine(parsed) {
      const result: { tokenIncrement?: TokenUsage; message?: string } = {};
      const type = parsed.type as string | undefined;

      // Claude Code stream-json emits result events with usage
      if (type === 'result' || type === 'turn_result') {
        const usage = (parsed.usage ?? parsed.token_usage) as Record<string, number> | undefined;
        if (usage) {
          result.tokenIncrement = {
            input: usage.input_tokens ?? 0,
            cachedInput: usage.cache_read_input_tokens ?? usage.cached_input_tokens ?? 0,
            output: usage.output_tokens ?? 0,
          };
        }
      }

      // Assistant messages
      if (type === 'assistant' || type === 'message') {
        const content = parsed.content ?? parsed.message ?? parsed.text;
        if (typeof content === 'string') {
          result.message = content.slice(0, 600);
        } else if (Array.isArray(content)) {
          const textBlock = (content as Array<Record<string, unknown>>).find(
            (b) => b.type === 'text' && typeof b.text === 'string',
          );
          if (textBlock) {
            result.message = (textBlock.text as string).slice(0, 600);
          }
        }
      }

      // Error events
      if (type === 'error') {
        const errMsg = (parsed.message ?? parsed.error) as string | undefined;
        if (typeof errMsg === 'string') {
          result.message = `Error: ${errMsg.slice(0, 500)}`;
        }
      }

      return result;
    },
  };
}

function createOpenCodeDriver(): BackendDriver {
  return {
    async checkVersion() {
      await runCommand('opencode', ['--version']);
    },
    buildArgs(input) {
      const args: string[] = [];
      if (input.model) args.push('--model', input.model);
      if (input.yolo) {
        args.push('--dangerously-skip-permissions');
      }
      args.push('run', '--json', '-o', input.outputPath, input.prompt);
      return { command: 'opencode', args };
    },
    parseStdoutLine(parsed) {
      const result: { tokenIncrement?: TokenUsage; message?: string } = {};
      const type = parsed.type as string | undefined;

      if (type === 'usage' || type === 'turn.completed') {
        const usage = (parsed.usage ?? parsed) as Record<string, number>;
        if (usage.input_tokens !== undefined || usage.output_tokens !== undefined) {
          result.tokenIncrement = {
            input: usage.input_tokens ?? 0,
            cachedInput: usage.cached_input_tokens ?? 0,
            output: usage.output_tokens ?? 0,
          };
        }
      }

      if (type === 'message' || type === 'assistant') {
        const text = (parsed.text ?? parsed.content ?? parsed.message) as string | undefined;
        if (typeof text === 'string') {
          result.message = text.slice(0, 600);
        }
      }

      return result;
    },
  };
}

type SingleBackend = 'codex' | 'claude-code' | 'opencode';

function getDriver(backend: SingleBackend): BackendDriver {
  switch (backend) {
    case 'codex': return createCodexDriver();
    case 'claude-code': return createClaudeCodeDriver();
    case 'opencode': return createOpenCodeDriver();
  }
}

const ALL_SINGLE_BACKENDS: SingleBackend[] = ['codex', 'claude-code', 'opencode'];

async function detectAvailableBackends(): Promise<SingleBackend[]> {
  const available: SingleBackend[] = [];
  for (const backend of ALL_SINGLE_BACKENDS) {
    try {
      await getDriver(backend).checkVersion();
      available.push(backend);
    } catch { /* not installed */ }
  }
  return available;
}

/* -- Orchestrator ------------------------------------------------- */

export class AgentReviewOrchestrator {
  private readonly listeners = new Set<(snapshot: RunSnapshot) => void>();
  private readonly snapshot: RunSnapshot;
  private readonly createdWorktrees = new Set<string>();
  private readonly codexTimeoutMs: number;
  private readonly codexInactivityTimeoutMs: number;
  private readonly driver: BackendDriver;
  private readonly drivers = new Map<SingleBackend, BackendDriver>();
  private readonly agentBackends = new Map<string, SingleBackend>();
  private readonly preparedCodexHomes = new Map<string, Promise<string | undefined>>();
  private availableBackends: SingleBackend[] = [];
  private lastEmitTime = 0;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;
  private persistQueue: Promise<void> = Promise.resolve();

  private issueStore?: IssueStore;
  private issueCounter = 1;
  private runId = '';
  private repoRoot = '';
  private currentBranch = '';
  private baseCommit = '';
  private runDir = '';
  private worktreesDir = '';
  private codexHomesDir = '';
  private issueFile = '';
  private reportFile = '';
  private targetPathsAbs: string[] = [];
  private targetFiles: string[] = [];
  private sharedWorktree?: WorktreeSpec;

  public constructor(private readonly config: OrchestratorConfig) {
    this.codexTimeoutMs = config.codexTimeoutMs ?? 600_000;       // 10 min default
    this.codexInactivityTimeoutMs = config.codexInactivityTimeoutMs ?? 180_000; // 3 min inactivity
    // Default driver used for planner and verification; mixed mode overrides per-agent
    this.driver = config.backend === 'mixed' ? getDriver('claude-code') : getDriver(config.backend as SingleBackend);

    const startedAt = nowIso();
    this.snapshot = {
      runId: 'pending',
      phase: 'initializing',
      statusMessage: 'Bootstrapping run',
      startedAt,
      lastUpdatedAt: startedAt,
      done: false,
      failed: false,
      backend: config.backend,
      targetPaths: [],
      agents: [],
      issueMetrics: { found: 0, open: 0, assigned: 0, fixed: 0, failed: 0 },
      tokenUsage: { ...EMPTY_USAGE },
      logs: [],
    };
  }

  public subscribe(listener: (snapshot: RunSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.cloneSnapshot());
    return () => { this.listeners.delete(listener); };
  }

  public getSnapshot(): RunSnapshot {
    return this.cloneSnapshot();
  }

  public async run(): Promise<OrchestratorResult> {
    try {
      await this.initialize();
      await this.runPlanningPhase();
      await this.runDiscoveryPhase();
      await this.runFixPhase();
      await this.runVerificationPhase();

      // Publish branch and create PR (best-effort)
      try {
        await this.publishIntegrationBranch();
      } catch (error) {
        this.addLog(`Publishing failed: ${error instanceof Error ? error.message : String(error)}`);
      }

      this.setPhase('complete', 'Run complete');
      this.snapshot.done = true;
      this.emitSnapshotNow();

      return {
        success: true,
        runDir: this.runDir,
        issueFile: this.issueFile,
        reportFile: this.reportFile,
        integrationWorktree: this.snapshot.integrationWorktree,
        integrationBranch: this.snapshot.integrationBranch,
        prUrl: this.snapshot.prUrl,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.snapshot.failed = true;
      this.snapshot.error = message;
      this.snapshot.done = true;
      this.setPhase('failed', 'Run failed');
      this.addLog(`Run failed: ${message}`);
      this.emitSnapshotNow();

      return {
        success: false,
        runDir: this.runDir || undefined,
        issueFile: this.issueFile || undefined,
        reportFile: this.reportFile || undefined,
        integrationWorktree: this.snapshot.integrationWorktree,
        integrationBranch: this.snapshot.integrationBranch,
        prUrl: this.snapshot.prUrl,
        error: message,
      };
    } finally {
      if (this.config.cleanup) {
        await this.cleanupWorktrees();
      } else {
        await this.cleanupCodexHomes();
      }
    }
  }

  /* -- State management ------------------------------------------- */

  private cloneSnapshot(): RunSnapshot {
    return {
      ...this.snapshot,
      targetPaths: [...this.snapshot.targetPaths],
      agents: this.snapshot.agents.map((agent) => ({
        ...agent,
        tokenUsage: { ...agent.tokenUsage },
      })),
      issueMetrics: { ...this.snapshot.issueMetrics },
      tokenUsage: { ...this.snapshot.tokenUsage },
      logs: [...this.snapshot.logs],
    };
  }

  /** Throttled emit — batches rapid updates to ~4 renders/sec */
  private emitSnapshot(): void {
    this.snapshot.lastUpdatedAt = nowIso();
    this.recomputeDerivedMetrics();

    const now = Date.now();
    const sinceLast = now - this.lastEmitTime;
    if (sinceLast >= 250) {
      this.lastEmitTime = now;
      if (this.emitTimer) { clearTimeout(this.emitTimer); this.emitTimer = null; }
      this.flushSnapshot();
      return;
    }
    // Schedule trailing emit so the latest state is always delivered
    if (!this.emitTimer) {
      this.emitTimer = setTimeout(() => {
        this.emitTimer = null;
        this.lastEmitTime = Date.now();
        this.snapshot.lastUpdatedAt = nowIso();
        this.recomputeDerivedMetrics();
        this.flushSnapshot();
      }, 250 - sinceLast);
    }
  }

  /** Immediate emit — used for phase transitions and run completion */
  private emitSnapshotNow(): void {
    if (this.emitTimer) { clearTimeout(this.emitTimer); this.emitTimer = null; }
    this.snapshot.lastUpdatedAt = nowIso();
    this.recomputeDerivedMetrics();
    this.lastEmitTime = Date.now();
    this.flushSnapshot();
  }

  private flushSnapshot(): void {
    const clone = this.cloneSnapshot();
    for (const listener of this.listeners) {
      listener(clone);
    }
  }

  private addLog(message: string): void {
    const stamp = new Date().toISOString().slice(11, 19);
    this.snapshot.logs.push(`[${stamp}] ${message}`);
    // NOTE: Do NOT slice/cap the logs array here. Ink's <Static> component
    // tracks rendered items by array length. If we slice, new logs stop
    // appearing after the cap is hit. Accept memory growth for correctness.
    this.emitSnapshot();
  }

  private recomputeDerivedMetrics(): void {
    let input = 0;
    let cachedInput = 0;
    let output = 0;
    for (const agent of this.snapshot.agents) {
      input += agent.tokenUsage.input;
      cachedInput += agent.tokenUsage.cachedInput;
      output += agent.tokenUsage.output;
    }
    this.snapshot.tokenUsage = { input, cachedInput, output };

    if (!this.issueStore) {
      this.snapshot.issueMetrics = { found: 0, open: 0, assigned: 0, fixed: 0, failed: 0 };
      return;
    }

    let open = 0;
    let assigned = 0;
    let fixed = 0;
    let failed = 0;
    for (const issue of this.issueStore.issues) {
      if (issue.status === 'open') open += 1;
      if (issue.status === 'assigned') assigned += 1;
      if (issue.status === 'fixed') fixed += 1;
      if (issue.status === 'failed') failed += 1;
    }
    this.snapshot.issueMetrics = { found: this.issueStore.issues.length, open, assigned, fixed, failed };
  }

  private setPhase(phase: RunSnapshot['phase'], statusMessage: string): void {
    this.snapshot.phase = phase;
    this.snapshot.statusMessage = statusMessage;
    this.emitSnapshotNow();
  }

  private getAgent(agentId: string): AgentSnapshot {
    const agent = this.snapshot.agents.find((entry) => entry.id === agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);
    return agent;
  }

  private createAgent(input: {
    id: string;
    index: number;
    kind: AgentSnapshot['kind'];
    branch?: string;
    worktreePath?: string;
    issuesAssigned: number;
  }): AgentSnapshot {
    const agent: AgentSnapshot = {
      id: input.id,
      index: input.index,
      kind: input.kind,
      status: 'pending',
      branch: input.branch,
      worktreePath: input.worktreePath,
      issuesAssigned: input.issuesAssigned,
      issuesFound: 0,
      issuesFixed: 0,
      tokenUsage: { ...EMPTY_USAGE },
      stepsCompleted: 0,
      stepsTotal: 0,
    };
    this.snapshot.agents.push(agent);
    this.emitSnapshot();
    return agent;
  }

  private updateAgent(agentId: string, patch: Partial<AgentSnapshot>): void {
    const agent = this.getAgent(agentId);
    Object.assign(agent, patch);
    this.emitSnapshot();
  }

  private addAgentUsage(agentId: string, usage: TokenUsage): void {
    const agent = this.getAgent(agentId);
    agent.tokenUsage = {
      input: agent.tokenUsage.input + usage.input,
      cachedInput: agent.tokenUsage.cachedInput + usage.cachedInput,
      output: agent.tokenUsage.output + usage.output,
    };
    this.emitSnapshot();
  }

  /* -- Initialize ------------------------------------------------- */

  private async initialize(): Promise<void> {
    this.setPhase('initializing', 'Resolving repository context');

    const gitRoot = (
      await runCommand('git', ['rev-parse', '--show-toplevel'], { cwd: this.config.startCwd })
    ).stdout.trim();
    if (!gitRoot) throw new Error('Unable to resolve git repository root');
    this.repoRoot = gitRoot;

    const branch = (
      await runCommand('git', ['-C', this.repoRoot, 'branch', '--show-current'])
    ).stdout.trim();
    this.currentBranch = branch || (
      await runCommand('git', ['-C', this.repoRoot, 'rev-parse', '--short', 'HEAD'])
    ).stdout.trim();

    this.baseCommit = (
      await runCommand('git', ['-C', this.repoRoot, 'rev-parse', 'HEAD'])
    ).stdout.trim();

    // Detect available backends
    if (this.config.backend === 'mixed') {
      this.availableBackends = await detectAvailableBackends();
      if (this.availableBackends.length === 0) {
        throw new Error('No backends available. Install at least one of: codex, claude, opencode');
      }
      for (const b of this.availableBackends) {
        this.drivers.set(b, getDriver(b));
      }
      this.addLog(`Mixed mode: available backends: ${this.availableBackends.join(', ')}`);
    } else {
      await this.driver.checkVersion();
      const singleBackend = this.config.backend as SingleBackend;
      this.availableBackends = [singleBackend];
      this.drivers.set(singleBackend, this.driver);
    }

    const stamp = new Date().toISOString().replaceAll(/[-:TZ.]/g, '').slice(0, 14);
    this.runId = `${stamp}-${randomUUID().slice(0, 8)}`;
    this.runDir = path.join(this.repoRoot, '.agent-review', 'runs', this.runId);
    this.worktreesDir = path.join(this.repoRoot, '.agent-review', 'worktrees', this.runId);
    this.codexHomesDir = path.join(os.tmpdir(), 'agent-review-codex-homes', this.runId);
    this.issueFile = path.join(this.runDir, 'issues.json');
    this.reportFile = path.join(this.runDir, 'final-report.md');

    await fs.mkdir(this.runDir, { recursive: true });
    await fs.mkdir(this.worktreesDir, { recursive: true });
    await fs.mkdir(this.codexHomesDir, { recursive: true });

    // Create a single shared worktree for all agents
    const sharedBranch = `agent-review/${this.runId}`;
    this.sharedWorktree = await this.createWorktree({ label: 'shared', branch: sharedBranch });

    // Pre-create the .agent-review/results directory in the shared worktree
    const codexDir = path.join(this.sharedWorktree.path, '.agent-review');
    const resultDir = path.join(codexDir, 'results');
    await fs.mkdir(resultDir, { recursive: true });

    this.snapshot.runId = this.runId;
    this.snapshot.repoRoot = this.repoRoot;
    this.snapshot.currentBranch = this.currentBranch;
    this.snapshot.targetPrompt = this.config.targetPrompt;
    this.snapshot.runDir = this.runDir;
    this.snapshot.issueFile = this.issueFile;
    this.snapshot.integrationBranch = sharedBranch;
    this.snapshot.integrationWorktree = this.sharedWorktree.path;

    this.addLog(`Run ID: ${this.runId}`);
    this.addLog(`Repository: ${this.repoRoot}`);
    this.addLog(`Branch: ${this.currentBranch}`);
    this.addLog(`Backend: ${this.config.backend}`);
    this.addLog(`Worktree: ${this.sharedWorktree.path}`);
  }

  /* -- Planning phase: use agent to identify the right codebase --- */

  private async runPlanningPhase(): Promise<void> {
    this.setPhase('planning', 'Identifying target codebase');

    // First, try direct path resolution (fast path)
    const directPaths = await this.resolveDirectPaths();
    if (directPaths.length > 0) {
      this.targetPathsAbs = directPaths;
      this.targetFiles = await this.collectTargetFiles(this.targetPathsAbs);
      await this.finalizePlanningResults();
      this.addLog('Target resolved via direct path match');
      return;
    }

    // Build a directory tree overview for the agent
    const dirTree = await this.buildDirectoryOverview();
    const plannerAgentId = 'planner-1';
    this.assignBackend(plannerAgentId, 1);

    this.createAgent({
      id: plannerAgentId,
      index: 1,
      kind: 'planner',
      issuesAssigned: 0,
    });
    this.updateAgent(plannerAgentId, { status: 'running', startedAt: nowIso(), lastMessage: 'Analyzing repository structure' });

    const plannerPrompt = [
      'You are a codebase navigation agent. Your ONLY job is to identify which directories/paths in this repository match the user\'s request.',
      '',
      `User request: "${this.config.targetPrompt}"`,
      '',
      'Repository structure (top-level directories and their immediate children):',
      dirTree,
      '',
      'Instructions:',
      '1. Based on the user\'s request, identify the most relevant directory paths to focus a code review on.',
      '2. Return ONLY a JSON object with this exact structure: {"paths": ["path/to/dir1", "path/to/dir2"], "reasoning": "brief explanation"}',
      '3. Paths should be relative to the repository root.',
      '4. Be specific - prefer deeper paths (e.g. "papertrail/web/app") over broad ones (e.g. "papertrail") when the user\'s request is specific.',
      '5. If the request mentions a specific project, app, or feature, narrow to that area.',
      '6. If the request is general (e.g. "everything", "the whole repo"), return ["."].',
      '7. Return ONLY the JSON, nothing else.',
    ].join('\n');

    try {
      // Use the shared worktree for planning (read-only)
      const planWorktree = this.sharedWorktree!;
      const codexDir = path.join(planWorktree.path, '.agent-review');
      const resultDir = path.join(codexDir, 'results');

      const schemaPath = path.join(codexDir, 'planner-schema.json');
      const outputPath = path.join(resultDir, 'planner-output.json');
      await fs.writeFile(schemaPath, JSON.stringify({
          type: 'object',
        required: ['paths', 'reasoning'],
        properties: {
          paths: { type: 'array', items: { type: 'string' } },
          reasoning: { type: 'string' },
        },
      }, null, 2), 'utf8');

      const result = await this.runBackendExec({
        agentId: plannerAgentId,
        cwd: planWorktree.path,
        prompt: plannerPrompt,
        schemaPath,
        outputPath,
        yolo: false,
      });

      // Token tracking is done incrementally in runBackendExec - no need to add again

      if (result.exitCode === 0) {
        try {
          const planOutput = await this.readJsonFile<{ paths: string[]; reasoning: string }>(outputPath);
          if (planOutput.paths && planOutput.paths.length > 0) {
            const resolvedPaths: string[] = [];
            for (const p of planOutput.paths) {
              const abs = path.resolve(this.repoRoot, p);
              if (await pathExists(abs) && isInsidePath(abs, this.repoRoot)) {
                resolvedPaths.push(abs);
              }
            }
            if (resolvedPaths.length > 0) {
              this.targetPathsAbs = resolvedPaths;
              this.updateAgent(plannerAgentId, {
                status: 'completed',
                endedAt: nowIso(),
                lastMessage: planOutput.reasoning,
              });
              this.addLog(`Planner identified ${resolvedPaths.length} target paths: ${planOutput.reasoning}`);
            }
          }
        } catch {
          // Fall through to heuristic
        }
      }
    } catch (error) {
      this.updateAgent(plannerAgentId, {
        status: 'failed',
        endedAt: nowIso(),
        error: error instanceof Error ? error.message : String(error),
      });
      this.addLog('Planner failed, falling back to heuristic matching');
    }

    // Fallback: use heuristic if planner didn't find paths
    if (this.targetPathsAbs.length === 0) {
      this.targetPathsAbs = await this.resolveHeuristicTargets();
      if (this.targetPathsAbs.length === 0) {
        const fallback = isInsidePath(this.config.startCwd, this.repoRoot)
          ? this.config.startCwd
          : this.repoRoot;
        this.targetPathsAbs = [fallback];
      }
      const plannerAgent = this.snapshot.agents.find((a) => a.id === plannerAgentId);
      if (plannerAgent && plannerAgent.status !== 'completed') {
        this.updateAgent(plannerAgentId, {
          status: 'completed',
          endedAt: nowIso(),
          lastMessage: 'Resolved via heuristic fallback',
        });
      }
    }

    this.targetFiles = await this.collectTargetFiles(this.targetPathsAbs);
    await this.finalizePlanningResults();
  }

  private async finalizePlanningResults(): Promise<void> {
    this.issueStore = {
      metadata: {
        runId: this.runId,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        repoRoot: this.repoRoot,
        currentBranch: this.currentBranch,
        targetPrompt: this.config.targetPrompt,
        targetPaths: this.targetPathsAbs.map((p) => normalizeSlashes(path.relative(this.repoRoot, p) || '.')),
        instances: this.config.instances,
        backend: this.config.backend,
      },
      issues: [],
    };

    this.snapshot.targetPaths = [...this.issueStore.metadata.targetPaths];
    await this.persistIssueStore();

    this.addLog(`Targets: ${this.snapshot.targetPaths.join(', ')}`);
    this.addLog(`Review file count: ${this.targetFiles.length}`);
  }

  private async buildDirectoryOverview(): Promise<string> {
    const lines: string[] = [];
    try {
      const entries = await fs.readdir(this.repoRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        lines.push(`${entry.name}/`);
        try {
          const subEntries = await fs.readdir(path.join(this.repoRoot, entry.name), { withFileTypes: true });
          const dirs = subEntries.filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules');
          const files = subEntries.filter((e) => e.isFile());
          for (const d of dirs.slice(0, 15)) {
            lines.push(`  ${entry.name}/${d.name}/`);
          }
          if (dirs.length > 15) lines.push(`  ... ${dirs.length - 15} more directories`);
          const keyFiles = files.filter((f) =>
            ['package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'README.md', 'Makefile'].includes(f.name),
          );
          for (const f of keyFiles) {
            lines.push(`  ${entry.name}/${f.name}`);
          }
        } catch { /* skip unreadable */ }
      }
    } catch { /* skip */ }
    return lines.join('\n');
  }

  private async resolveDirectPaths(): Promise<string[]> {
    const prompt = this.config.targetPrompt.trim();
    if (!prompt || /^(current(\s+directory)?|here|\.|cwd)$/i.test(prompt)) {
      const fallback = isInsidePath(this.config.startCwd, this.repoRoot)
        ? this.config.startCwd
        : this.repoRoot;
      return [fallback];
    }

    const candidates = prompt.split(/,| and /gi).map((p) => p.trim()).filter(Boolean);
    const found = new Set<string>();

    for (const candidate of candidates) {
      const abs = path.isAbsolute(candidate) ? candidate : path.resolve(this.config.startCwd, candidate);
      if (await pathExists(abs) && isInsidePath(path.resolve(abs), this.repoRoot)) {
        found.add(path.resolve(abs));
      }
      const repoRel = path.resolve(this.repoRoot, candidate);
      if (await pathExists(repoRel) && isInsidePath(path.resolve(repoRel), this.repoRoot)) {
        found.add(path.resolve(repoRel));
      }
    }
    return [...found];
  }

  private async resolveHeuristicTargets(): Promise<string[]> {
    const prompt = this.config.targetPrompt.trim().toLowerCase();
    const entries = await fs.readdir(this.repoRoot, { withFileTypes: true });
    const scored: Array<{ score: number; fullPath: string }> = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const name = entry.name.toLowerCase();
      let score = 0;
      if (name === prompt) score = 100;
      else if (name.startsWith(prompt)) score = 80;
      else if (name.includes(prompt)) score = 65;
      else {
        const promptTokens = prompt.split(/\s+/g).filter(Boolean);
        const nameTokens = name.split(/[-_/.\s]+/g);
        const overlap = promptTokens.filter((t) => nameTokens.includes(t)).length;
        if (overlap > 0) score = 40 + overlap * 10;
      }
      if (score > 0) scored.push({ score, fullPath: path.join(this.repoRoot, entry.name) });
    }

    scored.sort((a, b) => b.score - a.score);
    if (scored.length > 0) {
      const best = scored[0].score;
      return scored
        .filter((s) => s.score >= Math.max(60, best - 10))
        .slice(0, 3)
        .map((s) => s.fullPath);
    }
    return [];
  }

  /* -- File collection -------------------------------------------- */

  private async collectTargetFiles(targetPaths: string[]): Promise<string[]> {
    const relTargets = targetPaths.map((p) => normalizeSlashes(path.relative(this.repoRoot, p) || '.'));
    let files: string[] = [];

    try {
      const { stdout } = await runCommand('git', ['-C', this.repoRoot, 'ls-files', '-z', '--', ...relTargets]);
      files = stdout.split('\0').map((e) => e.trim()).filter(Boolean).filter((e) => this.shouldReviewFile(e));
    } catch { files = []; }

    if (files.length > 0) return files;

    const discovered = new Set<string>();
    for (const targetPath of targetPaths) {
      const stats = await fs.stat(targetPath);
      if (stats.isFile()) {
        const rel = normalizeSlashes(path.relative(this.repoRoot, targetPath));
        if (this.shouldReviewFile(rel)) discovered.add(rel);
        continue;
      }
      const stack = [targetPath];
      while (stack.length > 0) {
        const current = stack.pop()!;
        const dirEntries = await fs.readdir(current, { withFileTypes: true });
        for (const dirEntry of dirEntries) {
          const absolute = path.join(current, dirEntry.name);
          if (dirEntry.isDirectory()) {
            const relDir = normalizeSlashes(path.relative(this.repoRoot, absolute));
            if (IGNORED_PATH_SEGMENTS.some((seg) => `/${relDir}/`.includes(seg) || relDir.startsWith(seg.slice(1)))) continue;
            stack.push(absolute);
            continue;
          }
          if (!dirEntry.isFile()) continue;
          const relFile = normalizeSlashes(path.relative(this.repoRoot, absolute));
          if (this.shouldReviewFile(relFile)) discovered.add(relFile);
        }
      }
    }
    return [...discovered].sort();
  }

  private shouldReviewFile(relPath: string): boolean {
    const normalized = `/${normalizeSlashes(relPath)}`;
    if (IGNORED_PATH_SEGMENTS.some((seg) => normalized.includes(seg))) return false;
    const fileName = path.basename(relPath).toLowerCase();
    if (fileName === 'pnpm-lock.yaml' || fileName.endsWith('.lock')) return false;
    if (BINARY_FILE_PATTERN.test(fileName)) return false;
    if (/\.min\.(js|css)$/.test(fileName)) return false;
    const ext = path.extname(fileName);
    if (!ext) return true;
    return REVIEWABLE_EXTENSIONS.has(ext);
  }

  private splitIntoSegments<T>(items: T[]): T[][] {
    const count = Math.max(1, this.config.instances);
    const segments: T[][] = Array.from({ length: count }, () => []);
    for (let i = 0; i < items.length; i += 1) {
      segments[i % count].push(items[i]);
    }
    return segments;
  }

  /**
   * Split files into segments grouped by directory so each agent gets
   * coherent directory-level ownership rather than scattered files.
   * Large directory groups are sub-divided at deeper path levels to
   * ensure even distribution across agents.
   */
  private splitFilesIntoDirectorySegments(files: string[]): string[][] {
    const count = Math.max(1, this.config.instances);
    if (files.length === 0) return Array.from({ length: count }, () => []);

    const maxPerSegment = Math.ceil(files.length / count);

    // Build groups at progressively deeper path levels until no group
    // exceeds the fair-share size.
    const buildGroups = (items: string[], depth: number): Map<string, string[]> => {
      const groups = new Map<string, string[]>();
      for (const file of items) {
        const parts = file.split('/');
        const key = parts.slice(0, Math.min(depth, parts.length - 1)).join('/') || '.';
        const group = groups.get(key) ?? [];
        group.push(file);
        groups.set(key, group);
      }
      return groups;
    };

    // Start at depth 2 and go deeper for any groups that are too large
    const chunks: string[][] = [];
    const pending = new Map<string, string[]>();
    const initial = buildGroups(files, 2);
    for (const [k, gf] of initial) {
      pending.set(k, gf);
    }

    // Subdivide oversized groups up to depth 5
    for (let depth = 3; depth <= 5; depth += 1) {
      const next = new Map<string, string[]>();
      for (const [, groupFiles] of pending) {
        if (groupFiles.length <= maxPerSegment) {
          chunks.push(groupFiles);
        } else {
          const sub = buildGroups(groupFiles, depth);
          for (const [sk, sf] of sub) {
            next.set(sk, sf);
          }
        }
      }
      pending.clear();
      for (const [k, gf] of next) {
        pending.set(k, gf);
      }
    }
    // Any remaining groups that couldn't be split further
    for (const [, groupFiles] of pending) {
      chunks.push(groupFiles);
    }

    // Sort chunks by size (largest first) for better bin-packing
    chunks.sort((a, b) => b.length - a.length);

    // Greedy bin-packing: assign each chunk to the segment with fewest files
    const segments: string[][] = Array.from({ length: count }, () => []);
    for (const chunk of chunks) {
      let minIdx = 0;
      for (let i = 1; i < count; i += 1) {
        if (segments[i].length < segments[minIdx].length) minIdx = i;
      }
      segments[minIdx].push(...chunk);
    }

    return segments;
  }

  /* -- Discovery phase -------------------------------------------- */

  private async runDiscoveryPhase(): Promise<void> {
    this.setPhase('discovery', 'Running discovery agents');
    const segments = this.splitFilesIntoDirectorySegments(this.targetFiles);

    if (this.targetFiles.length === 0) {
      this.addLog('No files matched the selected target. Skipping discovery.');
      return;
    }

    const worktree = this.sharedWorktree!;
    for (let i = 1; i <= this.config.instances; i += 1) {
      const agentId = `discovery-${i}`;
      const backend = this.assignBackend(agentId, i);
      this.createAgent({
        id: agentId,
        index: i,
        kind: 'discovery',
        branch: worktree.branch,
        worktreePath: worktree.path,
        issuesAssigned: segments[i - 1]?.length ?? 0,
      });
      this.addLog(`${agentId} assigned to ${backend}`);
    }

    // Discovery agents are read-only so they can safely share a worktree in parallel
    await Promise.all(
      Array.from({ length: this.config.instances }, (_, index) => {
        const agentId = `discovery-${index + 1}`;
        const segment = segments[index] ?? [];
        return this.runDiscoveryAgent(agentId, worktree, segment);
      }),
    );

    const actionableAgents = segments.filter((segment) => segment.length > 0).length;
    const failedAgents = this.snapshot.agents
      .filter((agent) => agent.kind === 'discovery' && agent.status === 'failed')
      .length;
    if (actionableAgents > 0 && failedAgents >= actionableAgents) {
      throw new Error(`All discovery agents failed (${failedAgents}/${actionableAgents}).`);
    }

    this.addLog(`Discovery complete. Findings: ${this.issueStore?.issues.length ?? 0}`);
  }

  private async runDiscoveryAgent(agentId: string, worktree: WorktreeSpec, segment: string[]): Promise<void> {
    if (segment.length === 0) {
      this.updateAgent(agentId, { status: 'skipped', startedAt: nowIso(), endedAt: nowIso(), lastMessage: 'No files assigned' });
      return;
    }

    this.updateAgent(agentId, { status: 'running', startedAt: nowIso(), lastMessage: `Reviewing ${segment.length} files` });
    this.addLog(`${agentId} started (${segment.length} files)`);

    const codexDir = path.join(worktree.path, '.agent-review');
    const resultDir = path.join(codexDir, 'results');

    // Use agent-specific file names to avoid conflicts in shared worktree
    const manifestPath = path.join(codexDir, `${agentId}-manifest.txt`);
    const schemaPath = path.join(codexDir, `${agentId}-schema.json`);
    const outputPath = path.join(resultDir, `${agentId}-output.json`);

    const schema = this.discoverySchema();
    await fs.writeFile(manifestPath, `${segment.join('\n')}\n`, 'utf8');
    await fs.writeFile(schemaPath, JSON.stringify(schema, null, 2), 'utf8');

    let prompt = this.discoveryPrompt(agentId, segment, manifestPath);
    if (this.isClaudeCode(agentId)) {
      prompt += `\n\nCRITICAL OUTPUT REQUIREMENT:`;
      prompt += `\nYou MUST write your results as valid JSON to this exact file path: ${outputPath}`;
      prompt += `\nUse the Write tool to create this file. The JSON must match this schema:\n${JSON.stringify(schema, null, 2)}`;
      prompt += `\nIf you find no issues, still write the file with an empty issues array: {"summary": "No issues found.", "issues": []}`;
      prompt += `\nWrite the JSON file BEFORE your final response. Your final text response should just be the summary.`;
      prompt += `\nFailing to write this file will cause the entire review run to fail.`;
    }

    try {
      const result = await this.runBackendExec({ agentId, cwd: worktree.path, prompt, schemaPath, outputPath, yolo: false });
      // NOTE: tokens are tracked incrementally in runBackendExec - do NOT call addAgentUsage here

      if (result.exitCode !== 0) {
        const errMsg = result.stderr || result.lastMessage || `exited with code ${result.exitCode}`;
        this.updateAgent(agentId, { status: 'failed', endedAt: nowIso(), error: errMsg, lastMessage: errMsg.slice(0, 600) });
        this.addLog(`${agentId} failed (exit ${result.exitCode}): ${errMsg.slice(0, 300)}`);
        return;
      }

      let payload: DiscoverySchema;
      try {
        payload = await this.readJsonFile<DiscoverySchema>(outputPath);
      } catch (readError) {
        const msg = readError instanceof Error ? readError.message : String(readError);
        this.updateAgent(agentId, { status: 'failed', endedAt: nowIso(), error: `Failed to read output: ${msg}` });
        this.addLog(`${agentId} failed: could not read output file`);
        return;
      }

      const createdIssues = payload.issues.map((item): IssueRecord => {
        const issueId = `ISS-${String(this.issueCounter++).padStart(4, '0')}`;
        const normalizedFile = this.normalizeIssueFile(item.location.file, worktree.path);
        const line = typeof item.location.line === 'number' ? item.location.line : undefined;
        return {
          id: issueId,
          title: item.title.trim(),
          description: item.description.trim(),
          suggestedFix: item.suggested_fix.trim(),
          severity: this.normalizeSeverity(item.severity),
          location: { file: normalizedFile, line },
          status: 'open',
          discoveredBy: agentId,
          confidence: typeof item.confidence === 'number' ? item.confidence : undefined,
        };
      });

      if (this.issueStore) {
        this.issueStore.issues.push(...createdIssues);
      }
      await this.persistIssueStore();

      this.updateAgent(agentId, {
        status: 'completed',
        endedAt: nowIso(),
        issuesFound: createdIssues.length,
        lastMessage: payload.summary,
      });
      this.addLog(`${agentId} completed with ${createdIssues.length} findings`);
    } catch (error) {
      this.updateAgent(agentId, { status: 'failed', endedAt: nowIso(), error: error instanceof Error ? error.message : String(error) });
      this.addLog(`${agentId} errored`);
    }
  }

  /* -- Fix phase -------------------------------------------------- */

  private async runFixPhase(): Promise<void> {
    this.setPhase('fixing', 'Running fix agents');
    if (!this.issueStore) return;

    const openIssues = this.issueStore.issues.filter((issue) => issue.status === 'open');
    if (openIssues.length === 0) {
      this.addLog('No open issues discovered. Skipping fix phase.');
      return;
    }

    const integrationWorktree = this.sharedWorktree!;
    const chunks = this.splitIntoSegments(openIssues);

    // Create per-agent worktrees so fix agents can run in PARALLEL
    const agentWork: Array<{ agentId: string; worktree: WorktreeSpec; issues: IssueRecord[] }> = [];

    for (let i = 1; i <= this.config.instances; i += 1) {
      const agentId = `fix-${i}`;
      const chunk = chunks[i - 1] ?? [];
      this.assignBackend(agentId, i);

      if (chunk.length === 0) {
        this.createAgent({
          id: agentId,
          index: i,
          kind: 'fix',
          branch: integrationWorktree.branch,
          worktreePath: integrationWorktree.path,
          issuesAssigned: 0,
        });
        this.updateAgent(agentId, { status: 'skipped', startedAt: nowIso(), endedAt: nowIso(), lastMessage: 'No issues assigned' });
        continue;
      }

      // Each fix agent gets its own worktree branched from the integration branch
      const fixBranch = `${integrationWorktree.branch}-fix-${i}`;
      const worktree = await this.createWorktree({ label: `fix-${i}`, branch: fixBranch, startPoint: integrationWorktree.branch });

      // Ensure results directory exists in the fix worktree
      const resultDir = path.join(worktree.path, '.agent-review', 'results');
      await fs.mkdir(resultDir, { recursive: true });

      this.createAgent({
        id: agentId,
        index: i,
        kind: 'fix',
        branch: fixBranch,
        worktreePath: worktree.path,
        issuesAssigned: chunk.length,
      });

      for (const issue of chunk) {
        issue.status = 'assigned';
        issue.assignedTo = agentId;
      }

      agentWork.push({ agentId, worktree, issues: chunk });
    }
    await this.persistIssueStore();

    // Run ALL fix agents in PARALLEL (each in its own worktree)
    await Promise.all(
      agentWork.map(({ agentId, worktree, issues }) =>
        this.runFixAgent(agentId, worktree, issues),
      ),
    );

    // Merge fix branches back into the integration branch
    if (agentWork.some(({ agentId }) => {
      const a = this.getAgent(agentId);
      return a.status === 'completed' && a.issuesFixed > 0;
    })) {
      this.setPhase('integrating', 'Merging fix branches');

      for (const { agentId, worktree } of agentWork) {
        const agent = this.getAgent(agentId);
        if (agent.status !== 'completed' || agent.issuesFixed === 0) continue;

        const merge = await runCommand('git', [
          '-C', integrationWorktree.path, 'merge', worktree.branch,
          '-m', `merge: integrate fixes from ${agentId}`,
        ], { allowFailure: true });

        if (merge.code === 0) {
          this.addLog(`Merged ${agentId} fixes into integration branch`);
        } else {
          // Abort failed merge, retry with auto-resolve favoring the fix
          await runCommand('git', ['-C', integrationWorktree.path, 'merge', '--abort'], { allowFailure: true });
          const retry = await runCommand('git', [
            '-C', integrationWorktree.path, 'merge', '-X', 'theirs', worktree.branch,
            '-m', `merge: integrate fixes from ${agentId} (auto-resolved)`,
          ], { allowFailure: true });

          if (retry.code === 0) {
            this.addLog(`Merged ${agentId} fixes (auto-resolved conflicts)`);
          } else {
            await runCommand('git', ['-C', integrationWorktree.path, 'merge', '--abort'], { allowFailure: true });
            this.addLog(`Could not merge ${agentId} fixes — skipped`);
          }
        }
      }
    }

    this.addLog(`Fix phase complete. Fixed: ${this.snapshot.issueMetrics.fixed}`);
  }

  private async runFixAgent(agentId: string, worktree: WorktreeSpec, assignedIssues: IssueRecord[]): Promise<void> {
    this.updateAgent(agentId, { status: 'running', startedAt: nowIso(), lastMessage: `Fixing ${assignedIssues.length} issues` });
    this.addLog(`${agentId} started (${assignedIssues.length} issues)`);

    const codexDir = path.join(worktree.path, '.agent-review');
    const resultDir = path.join(codexDir, 'results');

    // Use agent-specific file names to avoid conflicts in shared worktree
    const assignmentPath = path.join(codexDir, `${agentId}-issues.json`);
    const schemaPath = path.join(codexDir, `${agentId}-schema.json`);
    const outputPath = path.join(resultDir, `${agentId}-output.json`);

    const schema = this.fixSchema();
    await fs.writeFile(assignmentPath, JSON.stringify({ assigned_issue_ids: assignedIssues.map((i) => i.id), issues: assignedIssues }, null, 2), 'utf8');
    await fs.writeFile(schemaPath, JSON.stringify(schema, null, 2), 'utf8');

    let prompt = this.fixPrompt(agentId, assignedIssues, assignmentPath);
    if (this.isClaudeCode(agentId)) {
      prompt += `\n\nCRITICAL OUTPUT REQUIREMENT:`;
      prompt += `\nAfter making fixes, you MUST write your results as valid JSON to this exact file path: ${outputPath}`;
      prompt += `\nUse the Write tool to create this file. The JSON must match this schema:\n${JSON.stringify(schema, null, 2)}`;
      prompt += `\nEach assigned issue ID must appear exactly once in the results array.`;
      prompt += `\nWrite the JSON file BEFORE your final response. Your final text response should just be the summary.`;
      prompt += `\nFailing to write this file will cause the entire fix run to fail.`;
    }

    try {
      const result = await this.runBackendExec({ agentId, cwd: worktree.path, prompt, schemaPath, outputPath, yolo: true });
      // NOTE: tokens tracked incrementally - do NOT double-count

      if (result.exitCode !== 0) {
        const errMsg = result.stderr || `exited with ${result.exitCode}`;
        for (const issue of assignedIssues) {
          issue.status = 'failed';
          issue.failureReason = `fix agent failed: ${errMsg}`;
        }
        await this.persistIssueStore();
        this.updateAgent(agentId, { status: 'failed', endedAt: nowIso(), error: errMsg, lastMessage: errMsg.slice(0, 600) });
        this.addLog(`${agentId} failed: ${errMsg.slice(0, 200)}`);
        return;
      }

      // Try to commit any changes the fix agent made (before reading output)
      const commitCreated = await this.commitIfDirty(worktree.path, `fix(agent-review): resolve assigned issues (${agentId})`);

      let payload: FixOutput | undefined;
      try {
        payload = await this.readJsonFile<FixOutput>(outputPath);
      } catch {
        // If the agent made code changes but didn't write the output file,
        // synthesize a result assuming issues were fixed
        if (commitCreated) {
          this.addLog(`${agentId}: no output file but commit created — assuming fixes applied`);
          payload = {
            summary: result.lastMessage ?? 'Fixes applied (output file not written)',
            results: assignedIssues.map((i) => ({
              issue_id: i.id,
              status: 'fixed' as const,
              fix_summary: result.lastMessage ?? 'Fixed (inferred from commit)',
              files_touched: [],
            })),
          };
        } else {
          for (const issue of assignedIssues) {
            issue.status = 'failed';
            issue.failureReason = 'Agent completed but wrote no output and made no code changes';
          }
          await this.persistIssueStore();
          this.updateAgent(agentId, { status: 'failed', endedAt: nowIso(), error: 'No output file and no code changes' });
          this.addLog(`${agentId} failed: no output file and no code changes`);
          return;
        }
      }

      const byIssueId = new Map(payload.results.map((item) => [item.issue_id, item]));

      const fixedIssueIds: string[] = [];
      for (const issue of assignedIssues) {
        const entry = byIssueId.get(issue.id);
        if (entry?.status === 'fixed' && commitCreated) {
          issue.status = 'fixed';
          issue.fixedBy = agentId;
          issue.fixSummary = entry.fix_summary;
          issue.failureReason = undefined;
          fixedIssueIds.push(issue.id);
          continue;
        }
        issue.status = 'failed';
        issue.failureReason = entry?.fix_summary || 'Issue not fixed or no code changes were committed';
      }
      await this.persistIssueStore();

      this.updateAgent(agentId, { status: 'completed', endedAt: nowIso(), issuesFixed: fixedIssueIds.length, lastMessage: payload.summary });
      this.addLog(`${agentId} completed with ${fixedIssueIds.length} fixes`);
    } catch (error) {
      for (const issue of assignedIssues) {
        issue.status = 'failed';
        issue.failureReason = `fix agent exception: ${error instanceof Error ? error.message : String(error)}`;
      }
      await this.persistIssueStore();
      this.updateAgent(agentId, { status: 'failed', endedAt: nowIso(), error: error instanceof Error ? error.message : String(error) });
      this.addLog(`${agentId} errored`);
    }
  }

  /* -- Verification ------------------------------------------------ */

  private async runVerificationPhase(): Promise<void> {
    this.setPhase('verifying', 'Running final verification agent');
    const worktree = this.sharedWorktree!;
    const finalAgentId = 'final-1';

    this.assignBackend(finalAgentId, 1);
    this.createAgent({ id: finalAgentId, index: 1, kind: 'final', branch: worktree.branch, worktreePath: worktree.path, issuesAssigned: 0 });
    this.updateAgent(finalAgentId, { status: 'running', startedAt: nowIso(), lastMessage: 'Running validation checks' });

    const codexDir = path.join(worktree.path, '.agent-review');
    const resultDir = path.join(codexDir, 'results');

    const schema = this.verificationSchema();
    const schemaPath = path.join(codexDir, 'verify-schema.json');
    const outputPath = path.join(resultDir, 'verify-output.json');
    await fs.writeFile(schemaPath, JSON.stringify(schema, null, 2), 'utf8');

    let prompt = this.verificationPrompt();
    if (this.isClaudeCode(finalAgentId)) {
      prompt += `\n\nCRITICAL OUTPUT REQUIREMENT:`;
      prompt += `\nAfter verification, you MUST write your results as valid JSON to this exact file path: ${outputPath}`;
      prompt += `\nUse the Write tool to create this file. The JSON must match this schema:\n${JSON.stringify(schema, null, 2)}`;
      prompt += `\nWrite the JSON file BEFORE your final response. Your final text response should just be the summary.`;
      prompt += `\nFailing to write this file will cause the entire verification to fail.`;
    }

    try {
      const result = await this.runBackendExec({ agentId: finalAgentId, cwd: worktree.path, prompt, schemaPath, outputPath, yolo: true });

      if (result.exitCode !== 0) {
        const errMsg = result.stderr || `exited with ${result.exitCode}`;
        this.updateAgent(finalAgentId, { status: 'failed', endedAt: nowIso(), error: errMsg, lastMessage: errMsg.slice(0, 600) });
        this.addLog(`Final verification agent failed: ${errMsg.slice(0, 200)}`);
        await this.writeFinalReport(undefined, `Final verification agent failed: ${errMsg}`);
        throw new VerificationFailure(`Final verification agent failed: ${errMsg}`);
      }

      let payload: VerificationOutput;
      try {
        payload = await this.readJsonFile<VerificationOutput>(outputPath);
      } catch (readError) {
        const msg = readError instanceof Error ? readError.message : String(readError);
        this.updateAgent(finalAgentId, { status: 'failed', endedAt: nowIso(), error: `Failed to read output: ${msg}` });
        this.addLog('Final verification failed: could not read output file');
        await this.writeFinalReport(undefined, `Could not read verification output: ${msg}`);
        throw new VerificationFailure(`Could not read verification output: ${msg}`);
      }

      await this.commitIfDirty(worktree.path, 'chore(agent-review): final verification follow-ups');

      this.updateAgent(finalAgentId, { status: 'completed', endedAt: nowIso(), lastMessage: payload.summary });
      this.addLog('Final verification completed');
      await this.writeFinalReport(payload);
    } catch (error) {
      if (error instanceof VerificationFailure) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.updateAgent(finalAgentId, { status: 'failed', endedAt: nowIso(), error: message });
      this.addLog('Final verification errored');
      await this.writeFinalReport(undefined, message);
      throw new VerificationFailure(message);
    }
  }

  /* -- Publish: rebase, push, and create PR ------------------------ */

  private async getDefaultBranch(): Promise<string> {
    try {
      const result = await runCommand('gh', ['repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'], { cwd: this.repoRoot });
      const branch = result.stdout.trim();
      if (branch) return branch;
    } catch { /* fall through */ }
    try {
      const result = await runCommand('git', ['-C', this.repoRoot, 'symbolic-ref', 'refs/remotes/origin/HEAD'], { allowFailure: true });
      const match = result.stdout.trim().match(/refs\/remotes\/origin\/(.+)/);
      if (match?.[1]) return match[1];
    } catch { /* fall through */ }
    return 'main';
  }

  private async publishIntegrationBranch(): Promise<void> {
    const worktree = this.sharedWorktree;
    const branch = this.snapshot.integrationBranch;
    if (!worktree || !branch) {
      this.addLog('Skipping publish: no integration branch');
      return;
    }

    // Check if there are any changes to publish
    const currentHead = (await runCommand('git', ['-C', worktree.path, 'rev-parse', 'HEAD'])).stdout.trim();
    if (currentHead === this.baseCommit) {
      this.addLog('No changes to publish');
      return;
    }

    this.setPhase('publishing', 'Rebasing and publishing PR');

    try {
      const defaultBranch = await this.getDefaultBranch();
      this.addLog(`Default branch: ${defaultBranch}`);

      // Fetch latest default branch
      await runCommand('git', ['-C', worktree.path, 'fetch', 'origin', defaultBranch]);

      // Rebase onto origin/default - "theirs" in rebase = our commits being replayed
      const rebase = await runCommand('git', [
        '-C', worktree.path, 'rebase', '-X', 'theirs', `origin/${defaultBranch}`,
      ], { allowFailure: true });

      if (rebase.code !== 0) {
        this.addLog('Rebase had conflicts, attempting merge fallback');
        await runCommand('git', ['-C', worktree.path, 'rebase', '--abort'], { allowFailure: true });

        // Fall back to merge - "ours" in merge = our current branch
        const merge = await runCommand('git', [
          '-C', worktree.path, 'merge', '-X', 'ours',
          `origin/${defaultBranch}`, '-m', `merge: integrate with latest ${defaultBranch}`,
        ], { allowFailure: true });

        if (merge.code !== 0) {
          await runCommand('git', ['-C', worktree.path, 'merge', '--abort'], { allowFailure: true });
          this.addLog('Could not resolve merge conflicts automatically, pushing as-is');
        }
      } else {
        this.addLog('Rebased onto latest ' + defaultBranch);
      }

      // Push the branch
      const push = await runCommand('git', [
        '-C', worktree.path, 'push', '-u', 'origin', `HEAD:refs/heads/${branch}`,
      ], { allowFailure: true });

      if (push.code !== 0) {
        this.addLog(`Push failed: ${push.stderr.trim()}`);
        return;
      }

      this.addLog(`Pushed branch: ${branch}`);

      // Create PR
      const im = this.snapshot.issueMetrics;
      const prTitle = `[agent-review] ${this.config.targetPrompt.slice(0, 70)}`;
      const prBody = [
        '## Agent Review',
        '',
        `Automated code review and fix by \`agent-review\` using **${this.config.backend}**.`,
        '',
        `**Target:** ${this.config.targetPrompt}`,
        '',
        '### Results',
        '',
        `| Metric | Count |`,
        `|--------|-------|`,
        `| Issues found | ${im.found} |`,
        `| Issues fixed | ${im.fixed} |`,
        `| Issues failed | ${im.failed} |`,
        `| Issues open | ${im.open} |`,
        '',
        `Run ID: \`${this.runId}\``,
      ].join('\n');

      const pr = await runCommand('gh', [
        'pr', 'create',
        '--base', defaultBranch,
        '--head', branch,
        '--title', prTitle,
        '--body', prBody,
      ], { cwd: this.repoRoot, allowFailure: true });

      if (pr.code === 0) {
        const prUrl = pr.stdout.trim();
        this.snapshot.prUrl = prUrl;
        this.addLog(`PR created: ${prUrl}`);
      } else {
        this.addLog(`PR creation failed: ${pr.stderr.trim()}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.addLog(`Publish failed: ${message}`);
    }
  }

  /* -- Report ----------------------------------------------------- */

  private async writeFinalReport(verificationOutput?: VerificationOutput, verificationError?: string): Promise<void> {
    const im = this.snapshot.issueMetrics;
    const tu = this.snapshot.tokenUsage;
    const unresolved = this.issueStore?.issues.filter((issue) => issue.status !== 'fixed') ?? [];
    const preview = unresolved.slice(0, 20);

    const lines: string[] = [];
    lines.push('# Agent Review Report');
    lines.push('');
    lines.push(`- Run ID: ${this.runId}`);
    lines.push(`- Backend: ${this.config.backend}`);
    lines.push(`- Repo: ${this.repoRoot}`);
    lines.push(`- Base Branch: ${this.currentBranch}`);
    lines.push(`- Base Commit: ${this.baseCommit}`);
    lines.push(`- Target Prompt: ${this.config.targetPrompt}`);
    lines.push(`- Target Paths: ${this.snapshot.targetPaths.join(', ')}`);
    lines.push(`- Instances: ${this.config.instances}`);
    lines.push('');
    lines.push('## Issue Summary');
    lines.push('');
    lines.push(`- Found: ${im.found}`);
    lines.push(`- Fixed: ${im.fixed}`);
    lines.push(`- Open: ${im.open}`);
    lines.push(`- Failed: ${im.failed}`);
    lines.push('');
    lines.push('## Token Usage');
    lines.push('');
    lines.push(`- Input: ${tu.input}`);
    lines.push(`- Cached Input: ${tu.cachedInput}`);
    lines.push(`- Output: ${tu.output}`);
    lines.push('');
    lines.push('## Verification');
    lines.push('');
    if (verificationError) {
      lines.push(`- Status: failed`);
      lines.push(`- Error: ${verificationError}`);
    } else if (verificationOutput) {
      lines.push(`- Status: completed`);
      lines.push(`- Summary: ${verificationOutput.summary}`);
      lines.push('');
      lines.push('### Checks');
      lines.push('');
      for (const check of verificationOutput.checks_run) {
        lines.push(`- ${check.command} -> ${check.result}: ${check.details}`);
      }
      if (verificationOutput.unresolved_risks.length > 0) {
        lines.push('');
        lines.push('### Unresolved Risks');
        lines.push('');
        for (const risk of verificationOutput.unresolved_risks) {
          lines.push(`- ${risk}`);
        }
      }
    } else {
      lines.push('- Status: skipped');
    }
    lines.push('');

    if (preview.length > 0) {
      lines.push('## Remaining Issues');
      lines.push('');
      for (const issue of preview) {
        const loc = issue.location.line !== undefined ? `${issue.location.file}:${issue.location.line}` : issue.location.file;
        lines.push(`- ${issue.id} [${issue.status}] ${issue.title} (${loc})`);
      }
      if (unresolved.length > preview.length) {
        lines.push(`- ... ${unresolved.length - preview.length} additional issues`);
      }
      lines.push('');
    }

    await fs.writeFile(this.reportFile, `${lines.join('\n')}\n`, 'utf8');
    this.snapshot.reportFile = this.reportFile;
    this.emitSnapshot();
  }

  /* -- Helpers ---------------------------------------------------- */

  private normalizeIssueFile(rawFile: string, worktreePath: string): string {
    const trimmed = rawFile.trim();
    if (!trimmed) return '.';
    if (path.isAbsolute(trimmed)) {
      if (isInsidePath(trimmed, worktreePath)) return normalizeSlashes(path.relative(worktreePath, trimmed));
      if (isInsidePath(trimmed, this.repoRoot)) return normalizeSlashes(path.relative(this.repoRoot, trimmed));
      return normalizeSlashes(trimmed);
    }
    return normalizeSlashes(trimmed);
  }

  private normalizeSeverity(raw: IssueSeverity): IssueSeverity {
    if (['critical', 'high', 'medium', 'low', 'info'].includes(raw)) return raw;
    return 'medium';
  }

  private async persistIssueStore(): Promise<void> {
    if (!this.issueStore || !this.issueFile) return;
    this.persistQueue = this.persistQueue.then(async () => {
      this.issueStore!.metadata.updatedAt = nowIso();
      const tmpPath = `${this.issueFile}.tmp`;
      await fs.writeFile(tmpPath, JSON.stringify(this.issueStore, null, 2), 'utf8');
      await fs.rename(tmpPath, this.issueFile);
    });
    await this.persistQueue;
    this.emitSnapshot();
  }

  private async readJsonFile<T>(filePath: string): Promise<T> {
    const raw = await fs.readFile(filePath, 'utf8');
    return parseJson<T>(raw);
  }

  /* -- Schemas ---------------------------------------------------- */

  private discoverySchema(): Record<string, unknown> {
    return {
      type: 'object',
      additionalProperties: false,
      required: ['summary', 'issues'],
      properties: {
        summary: { type: 'string' },
        issues: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['title', 'description', 'suggested_fix', 'severity', 'confidence', 'location'],
            properties: {
              title: { type: 'string' },
              description: { type: 'string' },
              suggested_fix: { type: 'string' },
              severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
              confidence: { type: ['number', 'null'] },
              location: {
                type: 'object',
                additionalProperties: false,
                required: ['file', 'line'],
                properties: { file: { type: 'string' }, line: { type: ['number', 'null'] } },
              },
            },
          },
        },
      },
    };
  }

  private fixSchema(): Record<string, unknown> {
    return {
      type: 'object',
      additionalProperties: false,
      required: ['summary', 'results'],
      properties: {
        summary: { type: 'string' },
        results: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['issue_id', 'status', 'fix_summary', 'files_touched'],
            properties: {
              issue_id: { type: 'string' },
              status: { type: 'string', enum: ['fixed', 'not_fixed'] },
              fix_summary: { type: 'string' },
              files_touched: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    };
  }

  private verificationSchema(): Record<string, unknown> {
    return {
      type: 'object',
      additionalProperties: false,
      required: ['summary', 'checks_run', 'changes_made', 'unresolved_risks'],
      properties: {
        summary: { type: 'string' },
        checks_run: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['command', 'result', 'details'],
            properties: {
              command: { type: 'string' },
              result: { type: 'string', enum: ['passed', 'failed', 'skipped'] },
              details: { type: 'string' },
            },
          },
        },
        changes_made: { type: 'boolean' },
        unresolved_risks: { type: 'array', items: { type: 'string' } },
      },
    };
  }

  /* -- Prompts ---------------------------------------------------- */

  /**
   * Try to extract valid JSON from text that may contain markdown code blocks or extra prose.
   */
  private static extractJson(text: string): string | undefined {
    // Try direct parse first
    try {
      JSON.parse(text.trim());
      return text.trim();
    } catch { /* continue */ }

    // Try extracting from markdown code blocks: ```json ... ``` or ``` ... ```
    const codeBlockMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)```/);
    if (codeBlockMatch) {
      try {
        JSON.parse(codeBlockMatch[1].trim());
        return codeBlockMatch[1].trim();
      } catch { /* continue */ }
    }

    // Try finding the outermost { ... } or [ ... ]
    try {
      const result = parseJson(text);
      return JSON.stringify(result);
    } catch { /* continue */ }

    return undefined;
  }

  /**
   * Extract unique directory paths from a file list, sorted, for prompt context.
   */
  private static summarizeDirectories(files: string[]): string[] {
    const dirs = new Set<string>();
    for (const f of files) {
      const dir = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '.';
      dirs.add(dir);
    }
    return [...dirs].sort();
  }

  /**
   * Build a compact tree-like overview of a file segment, grouped by top-level directory,
   * with file counts and extension breakdown per directory.
   */
  private static buildSegmentOverview(files: string[]): string {
    // Group by top-level directory (2 levels deep)
    const groups = new Map<string, string[]>();
    for (const f of files) {
      const parts = f.split('/');
      const key = parts.length > 2 ? `${parts[0]}/${parts[1]}` : parts[0];
      const group = groups.get(key) ?? [];
      group.push(f);
      groups.set(key, group);
    }

    const lines: string[] = [];
    for (const [dir, dirFiles] of [...groups.entries()].sort()) {
      // Count extensions
      const extCounts = new Map<string, number>();
      for (const f of dirFiles) {
        const ext = path.extname(f) || '(no ext)';
        extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1);
      }
      const extSummary = [...extCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([ext, count]) => `${count}${ext}`)
        .join(', ');

      lines.push(`  ${dir}/ (${dirFiles.length} files: ${extSummary})`);

      // Show subdirectories compactly
      const subDirs = new Set<string>();
      for (const f of dirFiles) {
        const rel = f.slice(dir.length + 1);
        const subDir = rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : null;
        if (subDir) subDirs.add(subDir);
      }
      if (subDirs.size > 0 && subDirs.size <= 15) {
        lines.push(`    subdirs: ${[...subDirs].sort().join(', ')}`);
      }
    }
    return lines.join('\n');
  }

  private discoveryPrompt(agentId: string, segment: string[], manifestPath: string): string {
    const overview = AgentReviewOrchestrator.buildSegmentOverview(segment);
    const topDirs = [...new Set(segment.map((f) => {
      const parts = f.split('/');
      return parts.length > 2 ? `${parts[0]}/${parts[1]}` : parts[0];
    }))].sort();

    return [
      `You are ${agentId}, a discovery-only code review agent.`,
      `Task: perform a deep review focused on logic bugs, type/runtime errors, state handling bugs, edge case failures, and security defects.`,
      '',
      '== CONTEXT ==',
      `Repo root: ${this.repoRoot}`,
      `Current branch: ${this.currentBranch}`,
      `User review target: "${this.config.targetPrompt}"`,
      `Total agents: ${this.config.instances} (running in parallel, each reviewing different sections)`,
      '',
      '== YOUR ASSIGNED SECTION ==',
      `You are responsible for reviewing ${segment.length} files in these areas:`,
      '',
      overview,
      '',
      `Full file list is in the manifest: ${manifestPath}`,
      '',
      '== SCOPE RULES ==',
      `- ONLY review files within YOUR assigned directories: ${topDirs.join(', ')}`,
      '- Do NOT review files outside your section. Other agents handle those.',
      '- You MAY read files outside your section for context (e.g. shared types, imports, config).',
      '',
      '== REVIEW GUIDELINES ==',
      '1. Do NOT modify any files. This is discovery only.',
      '2. Read files from the manifest and review them in depth.',
      '3. Report only concrete, actionable defects. Skip style, formatting, or naming nits.',
      '4. Include precise file paths and line numbers for each issue.',
      '5. For each issue explain WHY it is a bug and provide a specific fix suggestion.',
      '6. If unsure whether something is a real bug, do not report it.',
      '',
      '== WORKFLOW ==',
      '1. Read the manifest file to see your complete file list.',
      '2. Work through each directory in your assigned section systematically.',
      '3. For each file, look for logic bugs, type errors, race conditions, missing error handling, data loss risks, and security issues.',
      '4. Return your findings as JSON matching the output schema exactly.',
    ].join('\n');
  }

  private fixPrompt(agentId: string, assignedIssues: IssueRecord[], assignedIssuesPath: string): string {
    // Extract unique files and directories from the assigned issues
    const issueFiles = [...new Set(assignedIssues.map((i) => i.location.file))].sort();
    const issueDirs = AgentReviewOrchestrator.summarizeDirectories(issueFiles);
    const fileListing = issueFiles.map((f) => `  - ${f}`).join('\n');
    const dirListing = issueDirs.map((d) => `  - ${d}/`).join('\n');

    return [
      `You are ${agentId}, a fix agent.`,
      'Task: resolve ONLY the assigned issues and nothing else.',
      '',
      'Context:',
      `- Repo root: ${this.repoRoot}`,
      `- Branch: ${this.currentBranch}`,
      `- Number of assigned issues: ${assignedIssues.length}`,
      `- Assigned issues file (full details): ${assignedIssuesPath}`,
      '',
      'YOUR ASSIGNED SCOPE (only work within these areas):',
      'Directories:',
      dirListing,
      'Files containing issues:',
      fileListing,
      '',
      `There are ${this.config.instances} fix agents, each responsible for different issues. Only fix YOUR assigned issues.`,
      '',
      'Hard rules:',
      '1. Fix only issue IDs listed in the assigned issues file.',
      '2. No broad refactors or unrelated cleanup.',
      '3. Keep behavior stable except for the necessary bug fixes.',
      '4. Make edits directly in this worktree.',
      '5. If an issue cannot be fixed safely, mark it as not_fixed with reason.',
      '',
      'Execution guidance:',
      '- Read the assigned issues file first to understand all issues you need to fix.',
      '- Validate each fix with minimal relevant checks where practical.',
      '- Prefer targeted checks over expensive full-suite runs.',
      '',
      'Return JSON matching the output schema exactly. Each assigned issue ID must appear once in results.',
    ].join('\n');
  }

  private verificationPrompt(): string {
    return [
      'You are the final verification agent for this agent-review run.',
      'Goal: validate integrated fixes and produce a short reliability report.',
      '',
      'Steps:',
      '1. Inspect package scripts and identify practical quality gates.',
      '2. Run relevant typecheck/build/test commands using judgment.',
      '3. If tests appear stale or irrelevant, skip with a concise justification.',
      '4. If checks fail because of real regressions, apply minimal corrective fixes.',
      '5. Keep changes narrowly scoped to verification failures.',
      '',
      'Return JSON matching the output schema exactly.',
    ].join('\n');
  }

  /* -- Git worktree management ------------------------------------ */

  private async createWorktree(input: { label: string; branch: string; startPoint?: string }): Promise<WorktreeSpec> {
    const worktreePath = path.join(this.worktreesDir, input.label);
    await runCommand('git', [
      '-C', this.repoRoot, 'worktree', 'add', '--force',
      '-b', input.branch, worktreePath, input.startPoint ?? this.currentBranch,
    ]);
    this.createdWorktrees.add(worktreePath);
    return { label: input.label, branch: input.branch, path: worktreePath };
  }

  private async commitIfDirty(worktreePath: string, message: string): Promise<boolean> {
    const status = (await runCommand('git', ['-C', worktreePath, 'status', '--porcelain'])).stdout.trim();
    if (!status) return false;
    await runCommand('git', ['-C', worktreePath, 'add', '-A']);
    const commit = await runCommand('git', ['-C', worktreePath, 'commit', '-m', message], { allowFailure: true });
    return commit.code === 0;
  }

  /** Assign a backend to an agent (round-robin across available backends) */
  private assignBackend(agentId: string, index: number): SingleBackend {
    const backend = this.availableBackends[(index - 1) % this.availableBackends.length];
    this.agentBackends.set(agentId, backend);
    return backend;
  }

  /** Get the backend assigned to a specific agent */
  private getAgentBackend(agentId: string): SingleBackend {
    return this.agentBackends.get(agentId) ?? this.availableBackends[0];
  }

  /** Get the driver for a specific agent */
  private getAgentDriver(agentId: string): BackendDriver {
    const backend = this.getAgentBackend(agentId);
    return this.drivers.get(backend) ?? this.driver;
  }

  /** Check if a specific agent uses the claude-code backend */
  private isClaudeCode(agentId: string): boolean {
    return this.getAgentBackend(agentId) === 'claude-code';
  }

  private async prepareCodexHome(agentId: string): Promise<string | undefined> {
    if (this.getAgentBackend(agentId) !== 'codex') return undefined;
    const existing = this.preparedCodexHomes.get(agentId);
    if (existing) return existing;

    const setup = this.createCodexHome(agentId).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.addLog(`${agentId} codex home setup warning: ${message}`);
      return undefined;
    });
    this.preparedCodexHomes.set(agentId, setup);
    return setup;
  }

  private async createCodexHome(agentId: string): Promise<string> {
    const codexHome = path.join(this.codexHomesDir, agentId);
    await fs.mkdir(codexHome, { recursive: true });

    const sourceHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex');
    if (await pathExists(sourceHome)) {
      await this.copyFileIfPresent(path.join(sourceHome, 'auth.json'), path.join(codexHome, 'auth.json'));
      await this.copyFileIfPresent(path.join(sourceHome, 'config.toml'), path.join(codexHome, 'config.toml'));
      await this.copyFileIfPresent(path.join(sourceHome, '.codex-global-state.json'), path.join(codexHome, '.codex-global-state.json'));
      await this.copyFileIfPresent(path.join(sourceHome, 'version.json'), path.join(codexHome, 'version.json'));
      await this.copyFileIfPresent(path.join(sourceHome, 'models_cache.json'), path.join(codexHome, 'models_cache.json'));
    }

    return codexHome;
  }

  private async copyFileIfPresent(sourcePath: string, targetPath: string): Promise<void> {
    try {
      if (!await pathExists(sourcePath)) return;
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.copyFile(sourcePath, targetPath);
    } catch {
      // Non-critical seed copy failure (e.g. permissions) should not block isolated Codex home setup.
    }
  }

  private shouldRetryCodexExec(result: CodexExecResult, attempt: number, maxAttempts: number): boolean {
    if (attempt >= maxAttempts) return false;
    if (result.timedOut) return false;
    if (result.exitCode === 0) return false;

    const combined = `${result.stderr}\n${result.lastMessage ?? ''}`.toLowerCase();
    if (!combined.trim()) return true;
    return RETRYABLE_CODEX_FAILURES.some((pattern) => combined.includes(pattern));
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  /* -- Backend exec ----------------------------------------------- */

  private async runBackendExec(input: {
    agentId: string;
    cwd: string;
    prompt: string;
    schemaPath: string;
    outputPath: string;
    yolo: boolean;
  }): Promise<CodexExecResult> {
    const backend = this.getAgentBackend(input.agentId);
    const maxAttempts = backend === 'codex' ? 2 : 1;

    let lastResult: CodexExecResult | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (attempt > 1) {
        this.addLog(`${input.agentId} retrying ${backend} execution (attempt ${attempt}/${maxAttempts})`);
      }
      const result = await this.runBackendExecOnce(input, attempt);
      lastResult = result;
      if (backend !== 'codex' || !this.shouldRetryCodexExec(result, attempt, maxAttempts)) {
        return result;
      }
      await this.sleep(750 * attempt);
    }

    return lastResult!;
  }

  private async runBackendExecOnce(input: {
    agentId: string;
    cwd: string;
    prompt: string;
    schemaPath: string;
    outputPath: string;
    yolo: boolean;
  }, attempt: number): Promise<CodexExecResult> {
    const agentDriver = this.getAgentDriver(input.agentId);
    const agentBackend = this.getAgentBackend(input.agentId);
    const { command, args } = agentDriver.buildArgs({
      yolo: input.yolo,
      model: this.config.model,
      schemaPath: input.schemaPath,
      outputPath: input.outputPath,
      prompt: input.prompt,
    });

    const childEnv = { ...process.env };
    const codexHome = await this.prepareCodexHome(input.agentId);
    if (agentBackend === 'codex' && codexHome) {
      childEnv.CODEX_HOME = codexHome;
    }

    this.addLog(`${input.agentId} spawning ${agentBackend}${attempt > 1 ? ` (attempt ${attempt})` : ''}`);

    const child = spawn(command, args, { cwd: input.cwd, env: childEnv, stdio: 'pipe' });

    let stderr = '';
    let buffered = '';
    let stdoutBytes = 0;
    let lastMessage: string | undefined;
    let fullResultText: string | undefined;
    let lastAssistantFullText: string | undefined;
    const usage: TokenUsage = { ...EMPTY_USAGE };
    let timedOut = false;
    const startTime = Date.now();

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdin.end();

    const killChild = () => {
      if (timedOut) return;
      timedOut = true;
      const el = Math.round((Date.now() - startTime) / 1000);
      this.addLog(`${input.agentId} timed out after ${el}s`);
      try { child.kill('SIGTERM'); } catch { /* already dead */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already dead */ } }, 5000);
    };

    const overallTimer = setTimeout(killChild, this.codexTimeoutMs);
    let inactivityTimer = setTimeout(killChild, this.codexInactivityTimeoutMs);

    const resetInactivity = () => {
      clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(killChild, this.codexInactivityTimeoutMs);
    };

    // Shared line processor for both the streaming loop and the final buffer drain
    const processJsonLine = (line: string, emitAgentUpdate: boolean) => {
      if (!line) return;
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        const result = agentDriver.parseStdoutLine(parsed);

        if (result.tokenIncrement) {
          usage.input += result.tokenIncrement.input;
          usage.cachedInput += result.tokenIncrement.cachedInput;
          usage.output += result.tokenIncrement.output;
          this.addAgentUsage(input.agentId, result.tokenIncrement);
        }
        if (result.message) {
          lastMessage = result.message;
          if (emitAgentUpdate) this.updateAgent(input.agentId, { lastMessage });
        }

        // Capture full result text for backends that don't write output files (e.g. Claude Code)
        const pType = parsed.type as string | undefined;
        if (pType === 'result' || pType === 'turn_result') {
          const rc = parsed.result ?? parsed.content ?? parsed.text ?? parsed.message;
          if (typeof rc === 'string') {
            fullResultText = rc;
          } else if (Array.isArray(rc)) {
            const texts = (rc as Array<Record<string, unknown>>)
              .filter((b) => b.type === 'text' && typeof b.text === 'string')
              .map((b) => b.text as string);
            if (texts.length > 0) fullResultText = texts.join('\n');
          }
        }
        if (pType === 'assistant' || pType === 'message') {
          const ac = parsed.content ?? parsed.message ?? parsed.text;
          if (typeof ac === 'string') {
            lastAssistantFullText = ac;
          } else if (Array.isArray(ac)) {
            const texts = (ac as Array<Record<string, unknown>>)
              .filter((b) => b.type === 'text' && typeof b.text === 'string')
              .map((b) => b.text as string);
            const combined = texts.join('\n');
            if (combined) lastAssistantFullText = combined;
          }
        }
      } catch {
        // ignore non-json lines
      }
    };

    child.stdout.on('data', (chunk: string) => {
      resetInactivity();
      stdoutBytes += Buffer.byteLength(chunk, 'utf8');
      buffered += chunk;
      while (buffered.includes('\n')) {
        const idx = buffered.indexOf('\n');
        const line = buffered.slice(0, idx).trim();
        buffered = buffered.slice(idx + 1);
        processJsonLine(line, true);
      }
    });

    child.stderr.on('data', (chunk: string) => {
      resetInactivity();
      stderr += chunk;
    });

    const exitCode = await new Promise<number>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => resolve(code ?? 1));
    });

    clearTimeout(overallTimer);
    clearTimeout(inactivityTimer);

    // Process any remaining buffered data (may contain multiple lines including the result event)
    if (buffered.trim()) {
      const remainingLines = buffered.split('\n').map((l) => l.trim()).filter(Boolean);
      for (const line of remainingLines) {
        processJsonLine(line, false);
      }
    }

    // If the output file doesn't exist, try to write captured result text as fallback
    const capturedText = fullResultText ?? lastAssistantFullText;
    if (capturedText) {
      const outputExists = await pathExists(input.outputPath);
      if (!outputExists) {
        const jsonContent = AgentReviewOrchestrator.extractJson(capturedText);
        if (jsonContent) {
          try {
            await fs.mkdir(path.dirname(input.outputPath), { recursive: true });
            await fs.writeFile(input.outputPath, jsonContent, 'utf8');
          } catch { /* write failed - skip */ }
        }
      }
    }

    // Log diagnostic info when the process produces no useful output
    const hasOutput = await pathExists(input.outputPath);
    if (!lastMessage || !hasOutput) {
      const diag = [
        `exit=${exitCode}`,
        `stdout=${stdoutBytes}b`,
        `stderr=${stderr.length}b`,
        `output_file=${hasOutput ? 'yes' : 'no'}`,
      ].join(', ');
      this.addLog(`${input.agentId} diagnostic: ${diag}`);
      if (stderr.trim()) {
        this.addLog(`${input.agentId} stderr: ${stderr.trim().slice(0, 500)}`);
      }
    }

    const stderrResult = timedOut
      ? `Process timed out after ${Math.round((Date.now() - startTime) / 1000)}s${stderr.trim() ? ': ' + stderr.trim() : ''}`
      : stderr.trim();

    return {
      exitCode,
      usage,
      timedOut,
      durationMs: Date.now() - startTime,
      lastMessage,
      resultText: capturedText,
      stderr: stderrResult,
    };
  }

  private async cleanupWorktrees(): Promise<void> {
    if (!this.repoRoot) return;
    this.addLog('Cleaning up worktrees');

    for (const worktreePath of this.createdWorktrees) {
      // Try git worktree remove first
      const result = await runCommand(
        'git', ['-C', this.repoRoot, 'worktree', 'remove', '--force', worktreePath],
        { allowFailure: true },
      );
      // If that failed, force-remove the directory directly
      if (result.code !== 0 && await pathExists(worktreePath)) {
        try {
          await fs.rm(worktreePath, { recursive: true, force: true });
        } catch { /* best effort */ }
      }
    }

    // Prune stale worktree bookkeeping entries
    await runCommand('git', ['-C', this.repoRoot, 'worktree', 'prune'], { allowFailure: true });

    // Delete the local branches created for worktrees
    if (this.sharedWorktree?.branch) {
      await runCommand(
        'git', ['-C', this.repoRoot, 'branch', '-D', this.sharedWorktree.branch],
        { allowFailure: true },
      );
    }

    // Remove the run-specific worktrees directory
    if (this.worktreesDir && await pathExists(this.worktreesDir)) {
      try {
        await fs.rm(this.worktreesDir, { recursive: true, force: true });
      } catch { /* best effort */ }
    }

    // Remove isolated codex runtime homes
    if (this.codexHomesDir && await pathExists(this.codexHomesDir)) {
      try {
        await fs.rm(this.codexHomesDir, { recursive: true, force: true });
      } catch { /* best effort */ }
    }

    this.addLog('Worktree cleanup complete');
  }

  private async cleanupCodexHomes(): Promise<void> {
    if (!this.codexHomesDir) return;
    if (!await pathExists(this.codexHomesDir)) return;
    try {
      await fs.rm(this.codexHomesDir, { recursive: true, force: true });
    } catch { /* best effort */ }
  }
}
