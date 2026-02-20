export type Backend = 'codex' | 'claude-code' | 'opencode' | 'mixed';

export type RunPhase =
  | 'initializing'
  | 'planning'
  | 'discovery'
  | 'fixing'
  | 'integrating'
  | 'verifying'
  | 'publishing'
  | 'complete'
  | 'failed';

export type AgentKind = 'planner' | 'discovery' | 'fix' | 'final';
export type AgentStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export type IssueSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type IssueStatus = 'open' | 'assigned' | 'fixed' | 'failed';

export interface TokenUsage {
  input: number;
  cachedInput: number;
  output: number;
}

export interface AgentSnapshot {
  id: string;
  index: number;
  kind: AgentKind;
  status: AgentStatus;
  branch?: string;
  worktreePath?: string;
  issuesAssigned: number;
  issuesFound: number;
  issuesFixed: number;
  tokenUsage: TokenUsage;
  stepsCompleted: number;
  stepsTotal: number;
  activeStepLabel?: string;
  startedAt?: string;
  endedAt?: string;
  lastMessage?: string;
  error?: string;
}

export interface IssueLocation {
  file: string;
  line?: number;
}

export interface IssueRecord {
  id: string;
  title: string;
  description: string;
  suggestedFix: string;
  severity: IssueSeverity;
  location: IssueLocation;
  status: IssueStatus;
  discoveredBy: string;
  assignedTo?: string;
  fixedBy?: string;
  confidence?: number;
  fixSummary?: string;
  failureReason?: string;
}

export interface IssueStore {
  metadata: {
    runId: string;
    createdAt: string;
    updatedAt: string;
    repoRoot: string;
    currentBranch: string;
    targetPrompt: string;
    targetPaths: string[];
    instances: number;
    backend: Backend;
  };
  issues: IssueRecord[];
}

export interface RunSnapshot {
  runId: string;
  phase: RunPhase;
  statusMessage: string;
  startedAt: string;
  lastUpdatedAt: string;
  done: boolean;
  failed: boolean;
  error?: string;
  backend: Backend;
  repoRoot?: string;
  currentBranch?: string;
  targetPrompt?: string;
  targetPaths: string[];
  runDir?: string;
  issueFile?: string;
  reportFile?: string;
  integrationWorktree?: string;
  integrationBranch?: string;
  prUrl?: string;
  agents: AgentSnapshot[];
  issueMetrics: {
    found: number;
    open: number;
    assigned: number;
    fixed: number;
    failed: number;
  };
  tokenUsage: TokenUsage;
  logs: string[];
}

export interface OrchestratorConfig {
  instances: number;
  targetPrompt: string;
  startCwd: string;
  backend: Backend;
  model?: string;
  cleanup: boolean;
  discoveryBatchSize?: number;
  fixBatchSize?: number;
  codexTimeoutMs?: number;
  codexInactivityTimeoutMs?: number;
}

export interface OrchestratorResult {
  success: boolean;
  runDir?: string;
  issueFile?: string;
  reportFile?: string;
  integrationWorktree?: string;
  integrationBranch?: string;
  prUrl?: string;
  error?: string;
}

export interface DiscoveryOutput {
  summary: string;
  issues: Array<{
    title: string;
    description: string;
    suggested_fix: string;
    severity: IssueSeverity;
    location: {
      file: string;
      line: number | null;
    };
    confidence: number | null;
  }>;
}

export interface FixOutput {
  summary: string;
  results: Array<{
    issue_id: string;
    status: 'fixed' | 'not_fixed';
    fix_summary: string;
    files_touched: string[];
  }>;
}

export interface VerificationOutput {
  summary: string;
  checks_run: Array<{
    command: string;
    result: 'passed' | 'failed' | 'skipped';
    details: string;
  }>;
  changes_made: boolean;
  unresolved_risks: string[];
}

export interface CodexExecResult {
  exitCode: number;
  usage: TokenUsage;
  timedOut: boolean;
  durationMs: number;
  lastMessage?: string;
  resultText?: string;
  stderr: string;
}
