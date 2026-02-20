import React, { useState, useEffect } from 'react';
import { Box, Static, Text, useStdout } from 'ink';
import type { AgentSnapshot, RunSnapshot, RunPhase, Backend } from './types.js';

/* -- Theme --------------------------------------------------------- */

const T = {
  primary: 'cyan',
  success: 'green',
  warning: 'yellow',
  error: 'red',
  muted: 'gray',
  border: 'gray',
} as const;

/* -- Helpers ------------------------------------------------------- */

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function elapsed(iso: string): string {
  const ms = Math.max(0, Date.now() - new Date(iso).getTime());
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

const BACKEND_LABEL: Record<Backend, string> = {
  codex: 'Codex',
  'claude-code': 'Claude Code',
  opencode: 'OpenCode',
  mixed: 'Mixed',
};

const PHASE_ORDER: RunPhase[] = [
  'initializing',
  'planning',
  'discovery',
  'fixing',
  'integrating',
  'verifying',
  'publishing',
  'complete',
];

const PHASE_LABEL: Record<RunPhase, string> = {
  initializing: 'INIT',
  planning: 'PLAN',
  discovery: 'DISCOVER',
  fixing: 'FIX',
  integrating: 'INTEGRATE',
  verifying: 'VERIFY',
  publishing: 'PUBLISH',
  complete: 'DONE',
  failed: 'FAILED',
};

const SPIN = ['\u2807', '\u2819', '\u2839', '\u2838', '\u283C', '\u2834', '\u2826', '\u2827', '\u2807', '\u280F'];

function useTimer(intervalMs: number): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return tick;
}

/** Extract a human-readable message from lastMessage which may be raw JSON */
function humanizeMessage(raw: string | undefined, maxLen: number): string {
  if (!raw) return '';
  const trimmed = raw.trim();

  // If it looks like JSON, try to extract the summary field
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof parsed.summary === 'string' && parsed.summary.trim()) {
        return parsed.summary.trim().slice(0, maxLen);
      }
      // Try other common text fields
      for (const key of ['message', 'text', 'description', 'status']) {
        if (typeof parsed[key] === 'string' && (parsed[key] as string).trim()) {
          return (parsed[key] as string).trim().slice(0, maxLen);
        }
      }
    } catch {
      // Partial JSON - try to extract summary value with regex
      const match = trimmed.match(/"summary"\s*:\s*"([^"]+)/);
      if (match?.[1]) {
        return match[1].slice(0, maxLen);
      }
    }
  }

  return trimmed.slice(0, maxLen);
}

/** Hook to get terminal columns, updating on resize */
function useTerminalWidth(): number {
  const { stdout } = useStdout();
  const [width, setWidth] = useState(stdout?.columns ?? 120);

  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setWidth(stdout.columns);
    stdout.on('resize', onResize);
    return () => { stdout.off('resize', onResize); };
  }, [stdout]);

  return width;
}

/* -- Header ------------------------------------------------------- */

function Header({ snapshot, termWidth }: { snapshot: RunSnapshot; termWidth: number }): React.JSX.Element {
  useTimer(1000);
  const el = elapsed(snapshot.startedAt);
  const phaseColor = snapshot.phase === 'complete' ? T.success : snapshot.phase === 'failed' ? T.error : T.primary;
  const backendLabel = BACKEND_LABEL[snapshot.backend] ?? snapshot.backend;

  return (
    <Box
      borderStyle="round"
      borderColor={T.primary}
      paddingX={2}
      flexDirection="column"
      width={termWidth}
    >
      <Box justifyContent="space-between">
        <Text bold color={T.primary}>
          {'  '}AGENT REVIEW{'  '}
          <Text color={T.muted} bold={false}>
            via {backendLabel}
          </Text>
        </Text>
        <Text color={T.muted}>
          elapsed <Text bold color="white">{el}</Text>
        </Text>
      </Box>

      <Box justifyContent="space-between">
        <Text>
          <Text color={T.muted}>run </Text>
          <Text bold>{snapshot.runId}</Text>
        </Text>
        <Text>
          <Text color={T.muted}>phase </Text>
          <Text bold color={phaseColor}>
            {snapshot.phase.toUpperCase()}
          </Text>
        </Text>
      </Box>

      <Box>
        <Text color={T.muted} wrap="truncate">
          {snapshot.currentBranch ?? ''}
          {snapshot.targetPaths.length > 0
            ? ` \u2192 ${snapshot.targetPaths.join(', ')}`
            : ''}
        </Text>
      </Box>
    </Box>
  );
}

/* -- Phase pipeline ----------------------------------------------- */

function PhaseBar({ phase }: { phase: RunPhase }): React.JSX.Element {
  const currentIdx = PHASE_ORDER.indexOf(phase);
  const failed = phase === 'failed';

  return (
    <Box paddingX={2} marginY={0}>
      {PHASE_ORDER.map((p, i) => {
        const done = !failed && i < currentIdx;
        const active = !failed && i === currentIdx;

        let color: string = T.muted;
        let sym = '\u25CB';
        if (done) {
          color = T.success;
          sym = '\u25CF';
        } else if (active) {
          color = T.primary;
          sym = '\u25C9';
        }

        const sepColor = !failed && i <= currentIdx ? T.success : T.muted;

        return (
          <React.Fragment key={p}>
            {i > 0 && (
              <Text color={sepColor}>{' \u2501\u2501 '}</Text>
            )}
            <Text color={color} bold={active}>
              {sym} {PHASE_LABEL[p]}
            </Text>
          </React.Fragment>
        );
      })}
      {failed && (
        <>
          <Text color={T.muted}>{' \u2501\u2501 '}</Text>
          <Text color={T.error} bold>
            \u2717 FAILED
          </Text>
        </>
      )}
    </Box>
  );
}

/* -- Stat card ---------------------------------------------------- */

function StatCard({
  title,
  items,
  borderColor,
}: {
  title: string;
  items: Array<{ label: string; value: string | number; color?: string }>;
  borderColor?: string;
}): React.JSX.Element {
  return (
    <Box
      borderStyle="round"
      borderColor={borderColor ?? T.border}
      flexGrow={1}
      flexBasis={0}
      paddingX={1}
      flexDirection="column"
      marginRight={1}
    >
      <Text bold color={T.primary}>
        {title}
      </Text>
      {items.map((item) => (
        <Box key={item.label} justifyContent="space-between">
          <Text color={T.muted}>{item.label}</Text>
          <Text bold color={item.color ?? 'white'}>
            {typeof item.value === 'number' ? fmt(item.value) : item.value}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

function StatsRow({ snapshot }: { snapshot: RunSnapshot }): React.JSX.Element {
  const { issueMetrics: im, tokenUsage: tu, agents } = snapshot;
  const running = agents.filter((a) => a.status === 'running').length;
  const done = agents.filter((a) => a.status === 'completed').length;
  const failed = agents.filter((a) => a.status === 'failed').length;
  const pending = agents.filter((a) => a.status === 'pending').length;

  return (
    <Box>
      <StatCard
        title="Issues"
        borderColor={im.found > 0 ? T.warning : T.border}
        items={[
          { label: 'Found', value: im.found },
          { label: 'Fixed', value: im.fixed, color: im.fixed > 0 ? T.success : undefined },
          { label: 'Open', value: im.open, color: im.open > 0 ? T.warning : undefined },
          {
            label: 'Failed',
            value: im.failed,
            color: im.failed > 0 ? T.error : undefined,
          },
        ]}
      />
      <StatCard
        title="Agents"
        borderColor={running > 0 ? T.warning : T.border}
        items={[
          { label: 'Running', value: running, color: running > 0 ? T.warning : undefined },
          { label: 'Done', value: done, color: done > 0 ? T.success : undefined },
          { label: 'Failed', value: failed, color: failed > 0 ? T.error : undefined },
          { label: 'Pending', value: pending },
        ]}
      />
      <StatCard
        title="Tokens"
        items={[
          { label: 'Input', value: tu.input },
          { label: 'Cached', value: tu.cachedInput, color: T.primary },
          { label: 'Output', value: tu.output },
        ]}
      />
    </Box>
  );
}

/* -- Agent table -------------------------------------------------- */

function statusIndicator(status: AgentSnapshot['status']): { sym: string; color: string } {
  switch (status) {
    case 'running':
      return { sym: '\u25CF', color: T.warning };
    case 'completed':
      return { sym: '\u2713', color: T.success };
    case 'failed':
      return { sym: '\u2717', color: T.error };
    case 'skipped':
      return { sym: '\u2212', color: T.muted };
    default:
      return { sym: '\u25CB', color: T.muted };
  }
}

function AgentRow({
  agent,
  spinner,
  infoWidth,
}: {
  agent: AgentSnapshot;
  spinner: string;
  infoWidth: number;
}): React.JSX.Element {
  const { sym, color } = statusIndicator(agent.status);
  const icon = agent.status === 'running' ? spinner : sym;
  const assignedLabel =
    agent.kind === 'discovery' ? `${agent.issuesAssigned} files` : `${agent.issuesAssigned} issues`;
  const infoMaxLen = Math.max(20, infoWidth - 2);

  return (
    <Box>
      <Box width={16}>
        <Text color={color}>
          {icon} {agent.id}
        </Text>
      </Box>
      <Box width={12}>
        <Text color={color}>{agent.status}</Text>
      </Box>
      <Box width={14}>
        <Text color={T.muted}>{assignedLabel}</Text>
      </Box>
      <Box width={12}>
        <Text color={agent.issuesFound > 0 ? T.warning : T.muted}>
          {agent.issuesFound} found
        </Text>
      </Box>
      <Box width={12}>
        <Text color={agent.issuesFixed > 0 ? T.success : T.muted}>
          {agent.issuesFixed} fixed
        </Text>
      </Box>
      <Box width={12}>
        <Text color={T.muted}>{fmt(agent.tokenUsage.input + agent.tokenUsage.output)} tok</Text>
      </Box>
      {agent.error ? (
        <Box flexGrow={1}>
          <Text color={T.error} wrap="truncate">{humanizeMessage(agent.error, infoMaxLen)}</Text>
        </Box>
      ) : agent.lastMessage ? (
        <Box flexGrow={1}>
          <Text color={T.muted} wrap="truncate">
            {humanizeMessage(agent.lastMessage, infoMaxLen)}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

function AgentTable({ agents, termWidth }: { agents: AgentSnapshot[]; termWidth: number }): React.JSX.Element {
  const hasRunning = agents.some((a) => a.status === 'running');
  const tick = useTimer(hasRunning ? 250 : 60_000);
  const spinner = SPIN[tick % SPIN.length];

  // Fixed columns take ~78 chars, rest is for INFO
  const fixedColumnsWidth = 16 + 12 + 14 + 12 + 12 + 12 + 4; // +4 for borders/padding
  const infoWidth = Math.max(20, termWidth - fixedColumnsWidth);

  if (agents.length === 0) {
    return (
      <Box borderStyle="round" borderColor={T.border} paddingX={1} flexDirection="column" width={termWidth}>
        <Text bold color={T.primary}>
          Agents
        </Text>
        <Text color={T.muted}>Waiting for agents to start...</Text>
      </Box>
    );
  }

  const planner = agents.filter((a) => a.kind === 'planner');
  const discovery = agents.filter((a) => a.kind === 'discovery');
  const fix = agents.filter((a) => a.kind === 'fix');
  const final = agents.filter((a) => a.kind === 'final');

  return (
    <Box borderStyle="round" borderColor={T.border} paddingX={1} flexDirection="column" width={termWidth}>
      <Box>
        <Box width={16}>
          <Text color={T.muted} dimColor>NAME</Text>
        </Box>
        <Box width={12}>
          <Text color={T.muted} dimColor>STATUS</Text>
        </Box>
        <Box width={14}>
          <Text color={T.muted} dimColor>ASSIGNED</Text>
        </Box>
        <Box width={12}>
          <Text color={T.muted} dimColor>FOUND</Text>
        </Box>
        <Box width={12}>
          <Text color={T.muted} dimColor>FIXED</Text>
        </Box>
        <Box width={12}>
          <Text color={T.muted} dimColor>TOKENS</Text>
        </Box>
        <Box flexGrow={1}>
          <Text color={T.muted} dimColor>INFO</Text>
        </Box>
      </Box>

      {planner.length > 0 && (
        <>
          <Text bold color={T.primary}>Planning</Text>
          {planner.map((a) => (
            <AgentRow key={a.id} agent={a} spinner={spinner} infoWidth={infoWidth} />
          ))}
        </>
      )}

      {discovery.length > 0 && (
        <>
          <Text bold color={T.primary}>Discovery</Text>
          {discovery.map((a) => (
            <AgentRow key={a.id} agent={a} spinner={spinner} infoWidth={infoWidth} />
          ))}
        </>
      )}

      {fix.length > 0 && (
        <>
          <Text bold color={T.primary}>Fix</Text>
          {fix.map((a) => (
            <AgentRow key={a.id} agent={a} spinner={spinner} infoWidth={infoWidth} />
          ))}
        </>
      )}

      {final.length > 0 && (
        <>
          <Text bold color={T.primary}>Verification</Text>
          {final.map((a) => (
            <AgentRow key={a.id} agent={a} spinner={spinner} infoWidth={infoWidth} />
          ))}
        </>
      )}
    </Box>
  );
}

/* -- Completion panel --------------------------------------------- */

function CompletionPanel({ snapshot }: { snapshot: RunSnapshot }): React.JSX.Element | null {
  useTimer(snapshot.done ? 1000 : 60_000);
  const el = elapsed(snapshot.startedAt);

  if (!snapshot.done) return null;
  const ok = !snapshot.failed;
  const borderColor = ok ? T.success : T.error;
  const title = ok ? 'RUN COMPLETE' : 'RUN FAILED';
  const { issueMetrics: im, tokenUsage: tu } = snapshot;

  return (
    <Box
      borderStyle="double"
      borderColor={borderColor}
      paddingX={2}
      paddingY={0}
      flexDirection="column"
    >
      <Text bold color={borderColor}>
        {ok ? '\u25CF' : '\u2717'} {title}
      </Text>
      <Text />

      {snapshot.error && (
        <Text color={T.error}>{snapshot.error}</Text>
      )}

      <Text>
        <Text color={T.muted}>Issues: </Text>
        <Text>{im.found} found</Text>
        <Text color={T.success}>, {im.fixed} fixed</Text>
        <Text color={T.warning}>, {im.open} open</Text>
        <Text color={T.error}>, {im.failed} failed</Text>
      </Text>

      <Text>
        <Text color={T.muted}>Tokens: </Text>
        <Text>{fmt(tu.input)} in, {fmt(tu.cachedInput)} cached, {fmt(tu.output)} out</Text>
      </Text>

      <Text>
        <Text color={T.muted}>Duration: </Text>
        <Text bold>{el}</Text>
      </Text>

      <Text />
      {snapshot.prUrl && (
        <Text>
          <Text color={T.muted}>PR:       </Text>
          <Text bold color={T.primary}>{snapshot.prUrl}</Text>
        </Text>
      )}
      {snapshot.integrationBranch && (
        <Text>
          <Text color={T.muted}>Branch:   </Text>
          <Text bold color={T.success}>{snapshot.integrationBranch}</Text>
        </Text>
      )}
      {snapshot.reportFile && (
        <Text>
          <Text color={T.muted}>Report:   </Text>
          <Text>{snapshot.reportFile}</Text>
        </Text>
      )}
      {snapshot.issueFile && (
        <Text>
          <Text color={T.muted}>Issues:   </Text>
          <Text>{snapshot.issueFile}</Text>
        </Text>
      )}
      {snapshot.integrationWorktree && (
        <Text>
          <Text color={T.muted}>Worktree: </Text>
          <Text color={T.muted}>{snapshot.integrationWorktree}</Text>
        </Text>
      )}
    </Box>
  );
}

/* -- Static log line ---------------------------------------------- */

function LogLine({ log }: { log: string }): React.JSX.Element {
  const m = log.match(/^\[(\d{2}:\d{2}:\d{2})]\s(.*)$/);
  if (m) {
    const isError =
      m[2].includes('failed') || m[2].includes('errored') || m[2].includes('timed out');
    const isDone = m[2].includes('completed') || m[2].includes('complete');
    let textColor: string | undefined;
    if (isError) textColor = T.error;
    else if (isDone) textColor = T.success;
    return (
      <Text>
        <Text color={T.muted}>{m[1]} </Text>
        <Text color={textColor}>{m[2]}</Text>
      </Text>
    );
  }
  return <Text>{log}</Text>;
}

/* -- Main dashboard ----------------------------------------------- */

export function Dashboard({ snapshot }: { snapshot: RunSnapshot }): React.JSX.Element {
  const termWidth = useTerminalWidth();

  return (
    <Box flexDirection="column" width={termWidth}>
      {/* Log entries are rendered once via Static and scroll up into terminal history */}
      <Static items={snapshot.logs}>
        {(log, i) => <LogLine key={i} log={log} />}
      </Static>

      {/* Dynamic area stays pinned at the bottom of the terminal */}
      <Header snapshot={snapshot} termWidth={termWidth} />
      <PhaseBar phase={snapshot.phase} />
      <StatsRow snapshot={snapshot} />
      <AgentTable agents={snapshot.agents} termWidth={termWidth} />
      <CompletionPanel snapshot={snapshot} />
    </Box>
  );
}
