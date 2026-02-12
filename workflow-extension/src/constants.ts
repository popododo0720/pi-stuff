import type { WorkflowSettings, WorkflowState } from './types';

// Path and limit configuration constants
export const TOOL_NAME = 'workflow_transition';
export const MEMORY_DIR = '.pi';
export const MEMORY_FILE = 'workflow-memory.json';
export const SETTINGS_FILE = 'workflow-settings.json';
export const CONVENTIONS_DIR = 'conventions';
export const SOLUTIONS_DIR = 'docs/solutions';
export const MAX_MEMORY_ENTRIES = 50;
export const MAX_MEMORY_VALUE_LENGTH = 1000;
export const MAX_RULES = 30;
export const MAX_RULE_PATTERN_LENGTH = 200;
export const MAX_MODULES = 20;
export const MAX_MODULE_CONVENTIONS = 30;

/**
 * Generate a unique workflow ID based on timestamp.
 * Format: wf-YYYYMMDD-HHmmss (e.g. wf-20260212-152010)
 */
export function generateWorkflowId(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `wf-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

// Default values
export const DEFAULT_CONVENTIONS: string[] = [
  'Follow clean code principles — single responsibility per function, intention-revealing names, no duplication',
  'Adhere to SOLID principles — SRP, OCP, LSP, ISP, DIP',
  'No unnecessary complexity — YAGNI, KISS first',
];

export const DEFAULT_SETTINGS: WorkflowSettings = {
  verifyModels: [],
  verifyTimeout: 120_000,
  maxRetries: 3,
  thinkingLevel: 'high',
};

// State maps
export const STATE_EMOJI: Record<WorkflowState, string> = {
  plan: '📝',
  verifyPlan: '🔍',
  implement: '🔨',
  verifyImpl: '✅',
  compound: '🧠',
  done: '🎉',
};

export const STATE_LABELS: Record<WorkflowState, string> = {
  plan: 'Plan',
  verifyPlan: 'Verify Plan',
  implement: 'Implement',
  verifyImpl: 'Verify Impl',
  compound: 'Compound',
  done: 'Done',
};

export const VALID_TRANSITIONS: Record<string, WorkflowState[]> = {
  approvePlan: ['plan'],
  planVerified: ['verifyPlan'],
  planFailed: ['verifyPlan'],
  implDone: ['implement'],
  implVerified: ['verifyImpl'],
  implFailed: ['verifyImpl'],
  replan: ['implement'],
  compoundDone: ['compound'],
};

// Guide texts
export const ONBOARDING_GUIDE =
  '## 🚀 Project Setup\n\n' +
  'Conventions have not been configured for this project yet. Ask briefly before planning.\n\n' +
  '1. Understand the project structure — for multi-module projects, use module_conventions to separate conventions per module.\n' +
  '   (e.g. module_conventions(action: "create", module: "web-server", path: "src/web-server"))\n' +
  '2. Add global conventions via project_memory(category: "conventions").\n' +
  '3. Add directory/file-specific rules via project_memory(category: "rules") or module rules.\n' +
  '4. Once setup is done, proceed to planning.\n\n' +
  'Keep it short. If the user says "skip", proceed immediately.\n';

export const STAGE_GUIDES: Record<WorkflowState, string> = {
  plan:
    '## Current Stage: 📝 Planning\n\n' +
    '⚠️ IMPORTANT: You are ONLY a planner in this stage. Do NOT write or edit any code files. ' +
    'You CAN use bash and read tools to research the codebase. ' +
    'Focus solely on discussing and creating the implementation plan with the user.\n\n' +
    '### Phase 1: Pre-Analysis (before planning)\n' +
    'Analyze the request for:\n' +
    '- Ambiguities or unclear requirements — ask the user to clarify.\n' +
    '- Hidden intentions — what the user actually needs vs what they said.\n' +
    '- Hidden dependencies or side effects on existing code.\n' +
    '- Edge cases and potential failure points.\n' +
    '- Whether similar work exists in past solutions.\n' +
    '- Intent type: refactoring (safety first), new feature (patterns first), bugfix (root cause first).\n\n' +
    '### Phase 2: Research\n' +
    '- Read relevant source files to understand current patterns.\n' +
    '- Check existing conventions in project memory.\n\n' +
    '### Phase 3: Write the Plan\n' +
    'The plan MUST include:\n' +
    '- **Summary** — what and why, in one paragraph.\n' +
    '- **Step-by-step tasks** — each with exact file path (from project root) and specific change description.\n' +
    '- **For each file**: what to add/modify/delete and where (after which function, which line area).\n' +
    '- **Verification criteria** — concrete, executable checks (grep, lint command, test command).\n' +
    '- **What must NOT change** — explicit scope boundaries.\n\n' +
    'When the user approves, call workflow_transition(action: "approvePlan", content: "<full plan>").\n' +
    'Do NOT transition until the user explicitly approves.',

  verifyPlan:
    '## Current Stage: 🔍 Plan Verification\n\n' +
    '⚠️ IMPORTANT: You are ONLY a verifier in this stage. Do NOT modify any code files. ' +
    'You CAN use bash and read tools to check the codebase.\n\n' +
    'Automatic parallel verification failed. Manual verification is required.\n' +
    '- Check if the plan is clear, specific, complete, and has measurable verification criteria.\n' +
    '- Discuss with the user to verify.\n' +
    '- If passed, call workflow_transition(action: "planVerified").\n' +
    '- If issues found, call workflow_transition(action: "planFailed", reason: "...").',

  implement:
    '## Current Stage: 🔨 Implementation\n\n' +
    'Implementing based on the verified plan.\n' +
    '- Implement each item in the plan in order.\n' +
    '- Accept user feedback as you go.\n' +
    '- If the user requests a direction change, call workflow_transition(action: "replan", reason: "...") to return to planning.\n' +
    '- When all implementation is complete, call workflow_transition(action: "implDone").',

  verifyImpl:
    '## Current Stage: ✅ Implementation Verification\n\n' +
    '⚠️ IMPORTANT: You are ONLY a verifier in this stage. Do NOT modify any code files. ' +
    'You CAN use bash and read tools to verify the implementation.\n\n' +
    'Automatic parallel verification failed. Manual verification is required.\n' +
    '- Verify that all plan items are implemented and the code works correctly.\n' +
    '- If passed, call workflow_transition(action: "implVerified").\n' +
    '- If issues found, call workflow_transition(action: "implFailed", reason: "...").',

  compound:
    '## Current Stage: 🧠 Compound\n\n' +
    'The implementation is complete. Now capture what you learned.\n\n' +
    'Analyze this workflow and extract reusable knowledge:\n' +
    '1. **What worked well** — patterns, approaches, or tools that were effective.\n' +
    '2. **What went wrong** — mistakes, failed approaches, or issues encountered.\n' +
    '3. **Reusable insight** — the key takeaway that would help in future similar tasks.\n' +
    '4. **Conventions to add** — if you discovered project preferences, save them via project_memory.\n' +
    '5. **Memory cleanup** — review existing project memory (conventions, rules, notes) and remove outdated or redundant entries. ' +
    'Use project_memory(action: "remove", category: "...", index: N) to clean up.\n\n' +
    'Then call workflow_transition(action: "compoundDone", content: "<compound summary>").\n' +
    'The summary will be saved to docs/solutions/ for future reference.\n' +
    'Keep it concise but specific — focus on what would actually help next time.',

  done: '',
};

// Instruction for AI to save important learnings
export const LEARNING_GUIDE =
  '\n\n### 📌 Learning & Memory\n' +
  'When the user gives important corrections, preferences, or constraints, ' +
  'save them using project_memory for future reference. Only save significant items:\n' +
  '- User says "don\'t do X" or "always do Y" → project_memory(action: "add", category: "conventions", value: "...")\n' +
  '- User points out a pattern-specific rule → project_memory(action: "add", category: "rules", value: "pattern|rule")\n' +
  '- Repeated verification failures reveal a pattern → project_memory(action: "add", category: "notes", value: "...")\n' +
  'Do NOT save trivial or one-time comments. Only save things that should persist across sessions.\n' +
  'Before adding, check if a similar item already exists — update or skip if redundant.\n' +
  'If memory is getting large, use "remove" to clean up outdated entries.';
