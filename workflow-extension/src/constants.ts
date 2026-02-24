import type {
  CompoundStepDef,
  SolutionCategory,
  SolutionSeverity,
  WorkflowSettings,
  WorkflowState,
} from './types';

// Path and limit configuration constants
export const TOOL_NAME = 'workflow_transition';
export const MEMORY_DIR = '.pi';
export const WORKFLOWS_DIR = '.pi/workflows';
export const ACTIVE_WORKFLOW_FILE = 'active';
export const MEMORY_FILE = 'workflow-memory.json';
export const SETTINGS_FILE = 'workflow-settings.json';
export const CONVENTIONS_DIR = 'conventions';
export const SOLUTIONS_DIR = 'docs/solutions';

export const SOLUTION_CATEGORIES: Record<SolutionCategory, string[]> = {
  'build-errors': [
    'build',
    'compile',
    'tsc',
    'lint',
    'bundle',
    'typescript',
    'biome',
  ],
  'performance-issues': [
    'slow',
    'n+1',
    'memory',
    'performance',
    'timeout',
    'cache',
    'leak',
  ],
  'runtime-errors': [
    'crash',
    'exception',
    'error',
    'throw',
    'undefined',
    'null',
    'stack',
  ],
  'logic-errors': [
    'wrong',
    'incorrect',
    'bug',
    'logic',
    'calculation',
    'mismatch',
  ],
  'security-issues': [
    'security',
    'auth',
    'xss',
    'injection',
    'permission',
    'vulnerability',
    'secret',
  ],
  'workflow-issues': [
    'workflow',
    'process',
    'pipeline',
    'ci',
    'deploy',
    'git',
    'branch',
  ],
  general: [],
};

export const SEVERITY_KEYWORDS: Record<SolutionSeverity, string[]> = {
  critical: [
    'crash',
    'data loss',
    'security',
    'blocks',
    'production',
    'broken',
  ],
  high: ['fails', 'regression', 'major', 'wrong output'],
  medium: ['incorrect', 'unexpected', 'slow', 'warning'],
  low: ['minor', 'cosmetic', 'cleanup', 'improvement', 'refactor'],
};

export const MAX_MEMORY_ENTRIES = 50;
export const MAX_MEMORY_VALUE_LENGTH = 1000;
export const MAX_RULES = 30;
export const MAX_RULE_PATTERN_LENGTH = 200;
export const MAX_MODULES = 20;
export const MAX_MODULE_CONVENTIONS = 30;

// ── Output & truncation limits ────────────────────────────────
export const MAX_PREFLIGHT_OUTPUT_CHARS = 2000;
export const MAX_VERIFICATION_SUMMARY_CHARS = 1500;
export const MAX_ERROR_PREFIX_CHARS = 500;
/** Prompt injection 시 solution body 상한 (solution.ts의 MAX_SOLUTION_BODY=1500은 standalone 검색용) */
export const MAX_SOLUTION_BODY_CONTEXT_CHARS = 800;
export const MAX_MEMORY_CONTEXT_CHARS = 6000;

// ── Timeout defaults ──────────────────────────────────────────
export const DEFAULT_PREFLIGHT_TIMEOUT_SECONDS = 60;

// ── Validation bounds ─────────────────────────────────────────
export const TOKEN_BUDGET_MIN = 256;
export const TOKEN_BUDGET_MAX = 8192;
export const MAX_PARALLEL_MIN = 1;
export const MAX_PARALLEL_MAX = 10;
export const SEARCH_TIMEOUT_MIN = 10_000;
export const SEARCH_TIMEOUT_MAX = 300_000;
export const PREFLIGHT_TIMEOUT_MIN = 10;
export const PREFLIGHT_TIMEOUT_MAX = 300;
export const MAX_RETRIES_MIN = 1;
export const MAX_RETRIES_MAX = 20;
export const VERIFY_TIMEOUT_MAX = 600_000;

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
  verifyTimeout: 120_000,
  stages: {},
  git: {
    enabled: true,
    commitPerTodo: true,
    pushPerTodo: false,
    pushOnComplete: true,
    requireCleanStart: true,
    useWorkflowBranch: true,
    useWorkflowWorktree: true,
  },
  preflight: {
    enabled: true,
    commands: [],
    timeout: 60,
  },
  maxRetries: 5,
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

export const COMPOUND_STEPS: CompoundStepDef[] = [
  {
    id: 'reflect',
    label: 'Reflect & Capture',
    instruction:
      '<critical_requirement>\n' +
      '워크플로우에서 배운 것을 구조화하여 저장하세요.\n\n' +
      '**Step 1: project_memory에 최소 1개 저장 (필수)**\n' +
      '⚠️ 저장 없이 compoundDone 호출 시 거부됩니다.\n' +
      'Pattern 구조화: "패턴|||❌ 잘못된 예시|||✅ 올바른 예시|||이유"\n' +
      '구분자 ||| 사용. 예시/이유 생략 가능. count ≥ 3 도달 시 Critical Patterns에 자동 승격됩니다.\n\n' +
      '**Step 2: Documentation Review (해당 시)**\n' +
      '문서 생성/수정했다면: 명확성, 완전성, YAGNI 점검.\n\n' +
      '**Step 3: Compound Summary (compoundDone content에 작성)**\n' +
      '- **Problem:** 무엇이 문제였는가\n' +
      '- **Root Cause:** 왜 발생했는가\n' +
      '- **Solution:** 어떻게 해결했는가\n' +
      '- **Prevention:** 재발 방지\n' +
      '- **Symptoms:** 징후 키워드 (쉼표 구분)\n' +
      '</critical_requirement>',
    requiresGit: false,
    requiresLastTodo: false,
  },
  {
    id: 'cleanup',
    label: 'Memory Cleanup',
    instruction:
      '오래된 메모리 항목 정리: project_memory(action: "remove").\n' +
      '정리할 것 없으면 바로 compoundDone 호출.',
    requiresGit: false,
    requiresLastTodo: false,
  },
  {
    id: 'gitCommit',
    label: 'Git Commit',
    instruction:
      'git add -A && git status 확인.\n' +
      '변경사항 있으면: git commit -m "chore(workflow): final - <description>"',
    requiresGit: true,
    requiresLastTodo: true,
  },
  {
    id: 'gitPushBranch',
    label: 'Git Push Branch',
    instruction: 'git push origin <branch>',
    requiresGit: true,
    requiresLastTodo: true,
  },
  {
    id: 'gitMerge',
    label: 'Merge to Main',
    instruction:
      'Branch mode: git checkout main && git merge <branch> --no-ff\n' +
      'Worktree mode: git -C <main-repo> merge <branch> --no-ff',
    requiresGit: true,
    requiresLastTodo: true,
  },
  {
    id: 'gitPushMain',
    label: 'Push Main',
    instruction: 'git push origin main',
    requiresGit: true,
    requiresLastTodo: true,
  },
  {
    id: 'gitCleanup',
    label: 'Branch/Worktree Cleanup',
    instruction:
      '⚠️ Order matters — follow exactly:\n' +
      '1. Remove worktree: git worktree remove <main-worktree-path> --force\n' +
      '2. Checkout main in working dir: git checkout main\n' +
      '3. Delete feature branch: git branch -D <branch>\n' +
      '4. Delete remote branch: git push origin --delete <branch>\n\n' +
      'CRITICAL: Step 2 (checkout main) MUST happen BEFORE step 3 (branch delete).\n' +
      'Skipping this causes detached HEAD.',
    requiresGit: true,
    requiresLastTodo: true,
  },
  {
    id: 'finalize',
    label: 'Finalize',
    instruction:
      'compoundDone의 content에 워크플로우 요약 작성 필수.\n' +
      '구조화 권장:\n' +
      '- **Problem:** 무엇이 문제였는가\n' +
      '- **Root Cause:** 왜 발생했는가\n' +
      '- **Solution:** 어떻게 해결했는가\n' +
      '- **Prevention:** 재발 방지\n' +
      '- **Symptoms:** 징후 키워드\n\n' +
      'workflow_transition(action: "compoundDone", content: "<summary>")',
    requiresGit: false,
    requiresLastTodo: false,
  },
];

export function shouldSkipStep(
  step: CompoundStepDef,
  session: {
    gitBranch?: string;
    todos: Array<{ status: string }>;
    activeTodoIndex: number;
  },
): boolean {
  if (step.requiresGit && !session.gitBranch) return true;
  if (
    step.requiresLastTodo &&
    session.todos.length > 0 &&
    session.activeTodoIndex < session.todos.length - 1
  )
    return true;
  return false;
}

export const VALID_TRANSITIONS: Record<string, WorkflowState[]> = {
  approvePlan: ['plan', 'verifyPlan'],
  implDone: ['implement', 'verifyImpl'],
  replan: ['implement', 'verifyImpl', 'verifyPlan'],
  compoundDone: ['compound'],
  setTodos: ['plan'],
  skipVerification: ['verifyPlan', 'verifyImpl'],
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

// Shared self-audit template used in both gate rejection and stage guide
export const SELF_AUDIT_TEMPLATE =
  '## Self-Audit\n' +
  '- [x] Re-read all changed function signatures and return types\n' +
  '- [x] Verified parser/format consistency across files\n' +
  '- [x] Checked edge cases: (list specific ones)\n' +
  '- [x] Ran verification commands: (list results)';

export const STAGE_GUIDES: Record<WorkflowState, string> = {
  plan:
    '## Current Stage: 📝 Planning\n\n' +
    '⚠️ IMPORTANT: You are ONLY a planner in this stage. Do NOT write or edit any code files. ' +
    'You CAN use bash and read tools to research the codebase. ' +
    'Focus solely on discussing and creating the implementation plan with the user.\n\n' +
    '### Large Tasks → TODO Breakdown\n' +
    'For large tasks, break them into smaller TODO items first:\n' +
    'Call workflow_transition(action: "setTodos", content: \'["item1", "item2", "item3"]\')\n' +
    '**After setting TODOs, write ONE unified plan covering ALL TODO items in separate sections.**\n' +
    'Each TODO will be implemented sequentially, but planned together for better architecture.\n\n' +
    '⚠️ If startup git/worktree preparation is required, keep that mandatory TODO as #1 and plan it first before feature work.\n\n' +
    '### Phase 1: Pre-Analysis (before planning)\n' +
    '<critical_requirement>\n' +
    'Before writing the plan, complete this analysis:\n\n' +
    '**Impact Analysis:**\n' +
    '- Identify ALL files that will be touched and their dependents\n' +
    '- Map user flows affected — who uses this? what breaks if wrong?\n' +
    '- Check for hidden dependencies or side effects\n\n' +
    '**Stakeholder Perspectives:**\n' +
    '- Developer: maintainable? testable? debuggable?\n' +
    '- User: breaks existing behavior? UX regression?\n' +
    '- Ops: deployment impact? monitoring? rollback plan?\n' +
    '- Security: new attack surface? auth changes? data exposure?\n\n' +
    '**Gap Detection:**\n' +
    '- What is NOT mentioned but probably needed? (error handling, logging, tests)\n' +
    '- Edge cases the user has not considered\n' +
    '- Intent type: refactoring (safety first), new feature (patterns first), bugfix (root cause first)\n' +
    '- Check Relevant Past Solutions below for documented learnings\n' +
    '</critical_requirement>\n\n' +
    '### Phase 2: Research\n' +
    '- Read relevant source files to understand current patterns.\n' +
    '- Check existing conventions in project memory.\n' +
    '- **Review "Relevant Past Solutions" section below** — apply documented learnings.\n\n' +
    '### Phase 3: Write the Plan\n' +
    '**If TODOs are set**: Structure the plan with clear sections for each TODO:\n' +
    '```\n' +
    '## TODO #1: [title]\n' +
    '- Summary\n' +
    '- Steps...\n\n' +
    '## TODO #2: [title]\n' +
    '- Summary\n' +
    '- Steps...\n' +
    '```\n\n' +
    '### Plan Detail Level\n' +
    'Match plan depth to task complexity:\n\n' +
    '**MINIMAL** — 간단한 변경 (1-2 파일): 변경 파일과 요약만.\n' +
    '**STANDARD** (기본): 파일별 변경사항, 시그니처, cross-file impact, verification criteria.\n' +
    '**DETAILED** — 대규모 리팩토링: 전후 비교, Phase 분리, 롤백 계획.\n\n' +
    'The plan MUST include:\n' +
    '- **Summary** — what and why, in one paragraph.\n' +
    '- **Step-by-step tasks** — each with exact file path (from project root) and specific change description.\n' +
    '- **For each file**: what to add/modify/delete and where (after which function, which line area).\n' +
    '  Include: function signatures, type definitions, import changes — enough that the implementer has zero ambiguity.\n' +
    '- **Cross-file impact** — if a type/function/export changes, list EVERY consumer file that must update.\n' +
    '- **Verification criteria** — concrete, executable checks (grep, lint command, test command).\n' +
    '- **What must NOT change** — explicit scope boundaries.\n' +
    '- **IMPORTANT**: The plan is the SINGLE SOURCE OF TRUTH for verification.\n' +
    '  Verifiers will ONLY check items in the plan. If something is not in the plan, it will not be verified.\n' +
    '  If something should be done, it MUST be in the plan.\n\n' +
    'When the user approves, call workflow_transition(action: "approvePlan", content: "<full plan>").\n' +
    'Do NOT transition until the user explicitly approves.\n' +
    'Discussing the plan is NOT approval. Wait for explicit words like "approve", "go", "submit", "승인", "ㄱㄱ", "제출해".',

  verifyPlan:
    '## Current Stage: 🔍 Plan Verification — FAILED / HALTED\n\n' +
    '⚠️ MANDATORY: Fix ALL code issues found by verification. Do NOT bypass verification for code problems.\n' +
    'For infrastructure errors (rate limit, timeout), call workflow_transition(action: "skipVerification") to proceed.\n\n' +
    '1. Read the verification feedback above carefully.\n' +
    '2. Fix every 🔴 CRITICAL and 🟡 WARNING issue in your plan.\n' +
    '3. Discuss changes with the user if needed.\n' +
    '4. Call workflow_transition(action: "replan") to return to plan stage.\n' +
    '5. Then resubmit with workflow_transition(action: "approvePlan", content: "<fixed plan>").',

  implement:
    '## Current Stage: 🔨 Implementation\n\n' +
    'Implementing based on the verified plan.\n' +
    '**If TODOs are active**: Implement ONLY the current TODO section from the plan. Do NOT implement other TODO sections yet.\n' +
    '- Implement each item in the current TODO section in order.\n' +
    '- Accept user feedback as you go.\n' +
    '- If the user requests a direction change, call workflow_transition(action: "replan", reason: "...") to return to planning.\n' +
    '- Track progress: maintain a mental checklist of current TODO items. Do NOT stop until all items are complete.\n' +
    '- If stuck on one item, note the blocker and continue with the next.\n' +
    '- **Pre-flight checks**: lint/type-check/test are run automatically when you call implDone.\n' +
    '  If they fail, fix the errors and retry. No need to run manually.\n' +
    '- **MANDATORY**: Include a Self-Audit section in content parameter when calling implDone.\n' +
    '  Your content MUST include:\n  ```\n  ' +
    SELF_AUDIT_TEMPLATE.replace(/\n/g, '\n  ') +
    '\n  ```\n' +
    '  Without this section, implDone will be rejected.\n' +
    '- **Quick checklist (before implDone)**:\n' +
    "     a. Skim the plan's current TODO section — are all steps addressed?\n" +
    '     b. Run verification criteria from the plan (grep, lint, test).\n' +
    '     c. Do NOT re-analyze or refactor working code. Trust the verification stage to catch real issues.\n\n' +
    '⚠️ NEVER bypass verification. If verification fails, fix the issues and resubmit. Do NOT attempt manual overrides.',

  verifyImpl:
    '## Current Stage: ✅ Implementation Verification — HALTED\n\n' +
    'Verification was halted due to infrastructure errors (rate limit, quota, timeout).\n' +
    'This is NOT a code issue — do NOT modify code.\n\n' +
    '- Retry: call workflow_transition(action: "implDone", content: "<notes>") when the model is available.\n' +
    '- Skip: call workflow_transition(action: "skipVerification") to proceed without verification.\n' +
    '- Replan: call workflow_transition(action: "replan", reason: "...") if the plan needs changes.',

  compound:
    '## Current Stage: 🧠 Compound\n\n' +
    'Follow the checklist below. Complete the current step, then call workflow_transition(action: "compoundDone") to advance.\n',

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
