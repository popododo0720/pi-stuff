// context/guard.ts — Tool call guard for workflow stage enforcement
// Blocks write/edit and file-modifying bash commands during non-implementation stages.

import type { WorkflowState } from '../types';

/** Tools always blocked per workflow state */
const BLOCKED_TOOLS: Record<WorkflowState, string[]> = {
  plan: ['write', 'edit'],
  verifyPlan: ['write', 'edit'],
  implement: [],
  verifyImpl: ['write', 'edit'],
  compound: ['write', 'edit'],
  done: [],
};

/** States where bash write commands are blocked */
const BASH_WRITE_BLOCKED: Set<WorkflowState> = new Set([
  'plan',
  'verifyPlan',
  'verifyImpl',
  'compound',
]);

/** Reason messages per blocked state */
const BLOCK_REASONS: Partial<Record<WorkflowState, string>> = {
  plan: 'Plan stage: code changes are not allowed. Use read-only bash (grep, find, curl, ls) to research.',
  verifyPlan:
    'Verification stage: code changes are not allowed. Use read-only bash to verify.',
  verifyImpl:
    'Verification stage: code changes are not allowed. Use read-only bash to verify.',
  compound:
    'Compound stage: code changes are not allowed. Summarize learnings and call compoundDone.',
};

/**
 * Patterns that indicate a bash command modifies the filesystem.
 * Only matches commands at the START of a statement (after ;, &&, ||, |, or line start).
 * Avoids false positives like `grep rm file` or `curl .../install`.
 */
const BASH_WRITE_PATTERNS: RegExp[] = [
  // Redirections — excludes fd redirects (2>, 1>) and /dev/null targets
  /(?<!\d)\s*>{1,2}\s*(?!\/dev\/null|&)\S/, // > file or >> file (not 2>/dev/null, not >&2)
  // Commands that must appear at statement start
  /(?:^|[;&|]\s*)sed\s+-i/, // sed in-place edit
  /(?:^|[;&|]\s*)tee\s/, // tee writes to file
  /(?:^|[;&|]\s*)mv\s/, // move files
  /(?:^|[;&|]\s*)rm\s/, // remove files
  /(?:^|[;&|]\s*)cp\s/, // copy files
  /(?:^|[;&|]\s*)chmod\s/, // change permissions
  /(?:^|[;&|]\s*)mkdir\s/, // make directory
  /(?:^|[;&|]\s*)touch\s/, // create file
  /(?:^|[;&|]\s*)ln\s/, // symlink
  /(?:^|[;&|]\s*)npm\s+(install|i|ci|update)\b/, // npm install
  /(?:^|[;&|]\s*)git\s+(add|commit|push|checkout|merge|rebase)\b/, // git write
  /(?:^|[;&|]\s*)cat\s*>/, // cat > file
  /(?:^|[;&|]\s*)find\s.*(?:-exec|-execdir|-delete)\b/, // find with file-modifying actions
];

/** States where git commands are allowed despite general bash write block */
const GIT_ALLOWED_STATES: Set<WorkflowState> = new Set(['compound']);

/**
 * Check if a bash command contains file-modifying patterns.
 * @param allowGit - When true, git commands are excluded from write detection
 */
export function isBashWriteCommand(command: string, allowGit = false): boolean {
  const patterns = allowGit
    ? BASH_WRITE_PATTERNS.filter((p) => !p.source.includes('git\\s+'))
    : BASH_WRITE_PATTERNS;
  return patterns.some((pattern) => pattern.test(command));
}

/**
 * Check if a tool call should be blocked in the current workflow state.
 * @param state - Current workflow state
 * @param toolName - Name of the tool being called
 * @param toolArgs - Tool arguments (used to inspect bash commands)
 */
export function shouldBlockToolCall(
  state: WorkflowState,
  toolName: string,
  toolArgs?: Record<string, unknown>,
): { block: boolean; reason?: string } {
  // Check direct tool blocks (write, edit)
  const blocked = BLOCKED_TOOLS[state] ?? [];
  if (blocked.includes(toolName)) {
    return {
      block: true,
      reason:
        BLOCK_REASONS[state] ??
        `Tool '${toolName}' is not allowed in ${state} stage.`,
    };
  }

  // Check bash commands for write patterns
  if (
    toolName === 'bash' &&
    BASH_WRITE_BLOCKED.has(state) &&
    toolArgs?.command &&
    typeof toolArgs.command === 'string'
  ) {
    const allowGit = GIT_ALLOWED_STATES.has(state);
    if (isBashWriteCommand(toolArgs.command, allowGit)) {
      return {
        block: true,
        reason: `${BLOCK_REASONS[state] ?? 'Not allowed.'} Detected file-modifying command.`,
      };
    }
  }

  return { block: false };
}
