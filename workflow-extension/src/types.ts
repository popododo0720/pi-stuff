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

export interface TodoItem {
  title: string;
  status: 'pending' | 'active' | 'done';
}

export interface PatternEntry {
  text: string;
  count: number;
  wrong?: string;
  correct?: string;
  why?: string;
}

export interface CompoundStepDef {
  id: string;
  label: string;
  instruction: string;
  requiresGit: boolean;
  requiresLastTodo: boolean;
}

export interface WorkflowSession {
  id: string;
  state: WorkflowState;
  description: string;
  planContent: string;
  verifyPlanResult: string;
  retryCount: number;
  completed: boolean;
  todos: TodoItem[];
  activeTodoIndex: number;
  startupPrepRequired?: boolean;
  startupPrepNote?: string;
  startupPrepLocked?: boolean;
  gitBranch?: string;
  gitWorktreePath?: string;
  compoundMemorySnapshot?: {
    patterns: number;
    gotchas: number;
    decisions: number;
  };
  compoundStep?: number;
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
  patterns: PatternEntry[];
  gotchas: string[];
  decisions: string[];
}

export type SolutionCategory =
  | 'build-errors'
  | 'performance-issues'
  | 'runtime-errors'
  | 'logic-errors'
  | 'security-issues'
  | 'workflow-issues'
  | 'general';

export type SolutionSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface StageConfig {
  model?: string;
  thinking?: ThinkingLevel;
}

export interface VerifyStageConfig {
  models: string[];
  thinking?: ThinkingLevel;
}

export interface StageConfigs {
  plan?: StageConfig;
  verify?: VerifyStageConfig;
  implement?: StageConfig;
  compound?: StageConfig;
}

export interface RepoMapConfig {
  enabled?: boolean;
  tokenBudget?: number;
}

export interface GitAutomationConfig {
  enabled?: boolean;
  commitPerTodo?: boolean;
  pushPerTodo?: boolean;
  pushOnComplete?: boolean;
  requireCleanStart?: boolean;
  useWorkflowBranch?: boolean;
  useWorkflowWorktree?: boolean;
}

export interface PreflightConfig {
  enabled?: boolean;
  commands?: string[];
  timeout?: number; // per-command timeout in seconds, default 60
}

export interface WorkflowSettings {
  verifyTimeout: number;
  stages: StageConfigs;
  repoMap?: RepoMapConfig;
  git?: GitAutomationConfig;
  preflight?: PreflightConfig;
  maxRetries?: number; // verify failure threshold, default 5
}

export interface ModelVerificationResult {
  model: string;
  passed: boolean;
  output: string;
  criticalCount: number;
  warningCount: number;
  infoCount: number;
  infrastructureError?: boolean;
}

export interface VerificationResult {
  passed: boolean;
  results: ModelVerificationResult[];
  halted?: boolean;
}
