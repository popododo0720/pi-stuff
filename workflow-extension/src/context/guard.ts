// context/guard.ts — Tool call guard for workflow stage enforcement
// Blocks write/edit/bash during non-implementation stages.

import type { WorkflowState } from '../types';

/** Tools blocked per workflow state */
const BLOCKED_TOOLS: Record<WorkflowState, string[]> = {
  plan: ['write', 'edit', 'bash'],
  verifyPlan: ['write', 'edit', 'bash'],
  implement: [],
  verifyImpl: ['write', 'edit', 'bash'],
  done: [],
};

/** Reason messages per blocked state */
const BLOCK_REASONS: Partial<Record<WorkflowState, string>> = {
  plan: 'Plan stage: only reading is allowed. No code changes or commands.',
  verifyPlan:
    'Verification stage: only reading is allowed. No code changes or commands.',
  verifyImpl:
    'Verification stage: only reading is allowed. No code changes or commands.',
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
