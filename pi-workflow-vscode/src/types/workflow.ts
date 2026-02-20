// types/workflow.ts — Workflow session types mirrored from pi workflow extension
// Read-only: these types match the shape of .pi/workflow-session.json

export type WorkflowState =
  | 'plan'
  | 'verifyPlan'
  | 'implement'
  | 'verifyImpl'
  | 'compound'
  | 'done';

export interface TodoItem {
  title: string;
  status: 'pending' | 'active' | 'done';
}

export interface WorkflowSession {
  id: string;
  name?: string;
  state: WorkflowState;
  description: string;
  planContent: string;
  verifyPlanResult: string;
  retryCount: number;
  completed: boolean;
  todos: TodoItem[];
  activeTodoIndex: number;
  gitBranch?: string;
  compoundStep?: number;
}

// Runtime validation sets
export const VALID_STATES = new Set<string>([
  'plan',
  'verifyPlan',
  'implement',
  'verifyImpl',
  'compound',
  'done',
]);

export const VALID_TODO_STATUSES = new Set<string>([
  'pending',
  'active',
  'done',
]);

// Display constants
export const STATE_EMOJI: Record<WorkflowState, string> = {
  plan: '📝',
  verifyPlan: '🔍',
  implement: '🔨',
  verifyImpl: '✅',
  compound: '🧠',
  done: '🎉',
};

export const STATE_LABELS: Record<WorkflowState, string> = {
  plan: 'Planning',
  verifyPlan: 'Verifying Plan',
  implement: 'Implementing',
  verifyImpl: 'Verifying',
  compound: 'Compound',
  done: 'Done',
};

export interface WorkflowListItem {
  id: string;
  name?: string;
  state: WorkflowState;
  description: string;
  active: boolean;
}
