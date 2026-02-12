export type WorkflowState =
  | 'plan'
  | 'verifyPlan'
  | 'implement'
  | 'verifyImpl'
  | 'compound'
  | 'done';

export type ThinkingLevel =
  | 'off'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh';

export interface WorkflowSession {
  id: string;
  state: WorkflowState;
  description: string;
  planContent: string;
  verifyPlanResult: string;
  retryCount: number;
}

export interface ConditionalRule {
  pattern: string;
  rule: string;
}

export interface ModuleConventions {
  path: string;
  conventions: string[];
  rules: ConditionalRule[];
}

export interface ProjectMemory {
  conventions: string[];
  rules: ConditionalRule[];
  workflows: Array<{ name: string; description: string }>;
  currentWork: Array<{ what: string; why: string; startedAt: string }>;
  notes: string[];
}

export interface WorkflowSettings {
  verifyModels: string[];
  verifyTimeout: number;
  maxRetries: number;
  thinkingLevel: ThinkingLevel;
}

export interface VerificationResult {
  passed: boolean;
  results: Array<{
    model: string;
    passed: boolean;
    output: string;
  }>;
}
