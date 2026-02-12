// context/guard.ts — Tool call guard for workflow stage enforcement
// Blocks write/edit (and optionally bash) during non-implementation stages.

import type { WorkflowState } from '../types';

/** Base tools always blocked per state */
const BLOCKED_TOOLS: Record<WorkflowState, string[]> = {
  plan: ['write', 'edit'],
  verifyPlan: ['write', 'edit'],
  implement: [],
  verifyImpl: ['write', 'edit'],
  done: [],
};

/** Reason messages per blocked state */
const BLOCK_REASONS: Partial<Record<WorkflowState, string>> = {
  plan: 'Plan stage: code changes are not allowed. Create and approve the plan first.',
  verifyPlan:
    'Verification stage: code changes are not allowed. Complete verification first.',
  verifyImpl:
    'Verification stage: code changes are not allowed. Complete verification first.',
};

/**
 * Check if a tool call should be blocked in the current workflow state.
 * @param state - Current workflow state
 * @param toolName - Name of the tool being called
 * @param blockBash - Whether to also block bash in non-implementation stages
 */
export function shouldBlockToolCall(
  state: WorkflowState,
  toolName: string,
  blockBash = false,
): { block: boolean; reason?: string } {
  const blocked = [...(BLOCKED_TOOLS[state] ?? [])];

  // Optionally block bash in non-implementation stages
  if (blockBash && state !== 'implement' && state !== 'done') {
    blocked.push('bash');
  }

  if (blocked.includes(toolName)) {
    return {
      block: true,
      reason:
        BLOCK_REASONS[state] ??
        `Tool '${toolName}' is not allowed in ${state} stage.`,
    };
  }
  return { block: false };
}
