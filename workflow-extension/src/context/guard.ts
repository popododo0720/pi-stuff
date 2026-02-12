// context/guard.ts — Tool call guard for workflow stage enforcement
// Blocks write/edit during non-implementation stages. Read and bash always allowed.

import type { WorkflowState } from '../types';

/** Tools blocked per workflow state */
const BLOCKED_TOOLS: Record<WorkflowState, string[]> = {
  plan: ['write', 'edit'],
  verifyPlan: ['write', 'edit'],
  implement: [],
  verifyImpl: ['write', 'edit'],
  compound: ['write', 'edit'],
  done: [],
};

/** Reason messages per blocked state */
const BLOCK_REASONS: Partial<Record<WorkflowState, string>> = {
  plan: 'Plan stage: code changes are not allowed. Use read/bash to research, then create and approve the plan.',
  verifyPlan:
    'Verification stage: code changes are not allowed. Use read/bash to verify.',
  verifyImpl:
    'Verification stage: code changes are not allowed. Use read/bash to verify.',
  compound:
    'Compound stage: code changes are not allowed. Summarize learnings and call compoundDone.',
};

/**
 * Check if a tool call should be blocked in the current workflow state.
 */
export function shouldBlockToolCall(
  state: WorkflowState,
  toolName: string,
): { block: boolean; reason?: string } {
  const blocked = BLOCKED_TOOLS[state] ?? [];
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
