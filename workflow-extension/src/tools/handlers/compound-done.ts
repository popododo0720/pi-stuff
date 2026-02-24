// tools/handlers/compound-done.ts — compoundDone action handler
// Step-by-step compound checklist: validate current step → advance → finalize.

import { COMPOUND_STEPS, shouldSkipStep } from '../../constants';
import { appendCriticalPattern } from '../../storage/critical-patterns';
import {
  loadMemory,
  loadWorkflowMemory,
  saveMemory,
  saveWorkflowMemory,
} from '../../storage/memory';
import { saveSolution } from '../../storage/solution';
import { RESET_MARKER } from '../compact';
import {
  autoCommitTodo,
  autoPush,
  getCurrentBranch,
  getGitCwd,
  runGit,
} from '../git-automation';
import type { HandlerContext, HandlerResult } from './types';

// ── Solution metadata extraction ────────────────────────────────

/**
 * Extract structured metadata from compound summary markdown.
 * Matches **Root Cause:**, **Prevention:**, **Symptoms:** patterns.
 * Returns partial object — missing fields are omitted.
 */
interface SolutionMeta {
  rootCause?: string;
  prevention?: string;
  symptoms?: string[];
}

function extractSolutionMeta(summary: string): SolutionMeta {
  const result: SolutionMeta = {};
  const sectionEnd = /(?:\n\s*\*\*|\n\s*[-*]|\n\n|$)/s;
  const rootMatch = summary.match(
    new RegExp(`\\*\\*Root Cause:\\*\\*\\s*(.+?)${sectionEnd.source}`, 's'),
  );
  if (rootMatch?.[1]?.trim()) {
    result.rootCause = rootMatch[1].trim().replace(/\n/g, ' ');
  }
  const prevMatch = summary.match(
    new RegExp(`\\*\\*Prevention:\\*\\*\\s*(.+?)${sectionEnd.source}`, 's'),
  );
  if (prevMatch?.[1]?.trim()) {
    result.prevention = prevMatch[1].trim().replace(/\n/g, ' ');
  }
  const sympMatch = summary.match(
    new RegExp(`\\*\\*Symptoms:\\*\\*\\s*(.+?)${sectionEnd.source}`, 's'),
  );
  if (sympMatch?.[1]?.trim()) {
    result.symptoms = sympMatch[1]
      .trim()
      .split(/[,،]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return result;
}

// ── Validators ─────────────────────────────────────────────────

async function validateReflect(hctx: HandlerContext): Promise<string | null> {
  const wfMem = loadWorkflowMemory(hctx.ctx.cwd, hctx.session.id);
  const prev = hctx.session.compoundMemorySnapshot;
  if (!prev) return null; // no snapshot → skip check
  const hasNew =
    wfMem.patterns.length > prev.patterns ||
    wfMem.gotchas.length > prev.gotchas ||
    wfMem.decisions.length > prev.decisions;
  if (!hasNew) {
    return (
      '⚠️ No new learnings captured.\n' +
      'Use project_memory(action: "add") to save at least one pattern, gotcha, or decision before calling compoundDone.\n' +
      'If this task truly had no learnings, add a gotcha or decision explaining why.'
    );
  }
  return null;
}

async function validateCleanup(_hctx: HandlerContext): Promise<string | null> {
  return null;
}

async function validateGitCommit(hctx: HandlerContext): Promise<string | null> {
  const gitCwd = getGitCwd(hctx.ctx.cwd);
  const status = await runGit(hctx.pi, ['status', '--porcelain'], gitCwd);
  if (!status.ok) {
    return `❌ git status failed: ${status.stderr || `exit ${status.code}`}`;
  }
  if (status.stdout.length > 0) {
    return (
      `❌ Uncommitted changes remain:\n${status.stdout}\n` +
      'Commit or discard, then call compoundDone.'
    );
  }
  return null;
}

async function validateGitPushBranch(
  hctx: HandlerContext,
): Promise<string | null> {
  const { session, settings } = hctx;
  if (!session.gitBranch) return null;
  const gitCwd = getGitCwd(hctx.ctx.cwd);
  const log = await runGit(
    hctx.pi,
    ['log', `origin/${session.gitBranch}..HEAD`, '--oneline'],
    gitCwd,
  );
  if (!log.ok) {
    if (settings.git?.pushOnComplete) {
      const push = await autoPush(hctx.pi, session.gitBranch, gitCwd);
      return push.ok ? null : `❌ Auto-push failed: ${push.message}`;
    }
    return (
      `❌ git log failed: ${log.stderr || `exit ${log.code}`}\n` +
      `Run: git push origin ${session.gitBranch}`
    );
  }
  if (log.stdout.length > 0) {
    if (settings.git?.pushOnComplete) {
      const push = await autoPush(hctx.pi, session.gitBranch, gitCwd);
      return push.ok ? null : `❌ Auto-push failed: ${push.message}`;
    }
    return (
      `❌ Unpushed commits on branch:\n${log.stdout}\n` +
      `Run: git push origin ${session.gitBranch}`
    );
  }
  return null;
}

async function validateGitMerge(hctx: HandlerContext): Promise<string | null> {
  const { session } = hctx;
  if (!session.gitBranch) return null;
  const gitCwd = getGitCwd(hctx.ctx.cwd);
  const merged = await runGit(hctx.pi, ['branch', '--merged', 'main'], gitCwd);
  if (!merged.ok) {
    return `❌ git branch --merged failed: ${merged.stderr || `exit ${merged.code}`}`;
  }
  // Check each line for exact match (strip leading * and whitespace)
  const branches = merged.stdout
    .split(/\r?\n/)
    .map((line) => line.replace(/^\*?\s*/, '').trim())
    .filter(Boolean);
  if (!branches.includes(session.gitBranch)) {
    return (
      `❌ Branch '${session.gitBranch}' not merged into main.\n` +
      `Run: git checkout main && git merge ${session.gitBranch} --no-ff`
    );
  }
  return null;
}

async function validateGitPushMain(
  hctx: HandlerContext,
): Promise<string | null> {
  const { settings, pi } = hctx;
  const gitCwd = getGitCwd(hctx.ctx.cwd);
  const log = await runGit(
    pi,
    ['log', 'origin/main..main', '--oneline'],
    gitCwd,
  );
  if (!log.ok) {
    if (settings.git?.pushOnComplete) {
      const push = await autoPush(pi, 'main', gitCwd);
      return push.ok ? null : `❌ Auto-push failed: ${push.message}`;
    }
    return `❌ git log failed: ${log.stderr || `exit ${log.code}`}\nRun: git push origin main`;
  }
  if (log.stdout.length > 0) {
    if (settings.git?.pushOnComplete) {
      const push = await autoPush(pi, 'main', gitCwd);
      return push.ok ? null : `❌ Auto-push failed: ${push.message}`;
    }
    return `❌ Main not pushed:\n${log.stdout}\nRun: git push origin main`;
  }
  return null;
}

async function validateGitCleanup(
  hctx: HandlerContext,
): Promise<string | null> {
  const gitCwd = getGitCwd(hctx.ctx.cwd);
  // Ensure HEAD is on main (not detached) after cleanup
  const branch = await runGit(
    hctx.pi,
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    gitCwd,
  );
  if (!branch.ok) {
    return `❌ Cannot detect current branch: ${branch.stderr || `exit ${branch.code}`}`;
  }
  if (branch.stdout === 'HEAD') {
    return (
      '❌ HEAD is detached — you must checkout main before deleting the feature branch.\n' +
      'Run: git checkout main'
    );
  }
  if (branch.stdout !== 'main') {
    return (
      `❌ Working directory is on '${branch.stdout}', expected 'main'.\n` +
      'Run: git checkout main'
    );
  }
  return null;
}

async function validateFinalize(hctx: HandlerContext): Promise<string | null> {
  if (!hctx.params.content?.trim()) {
    return (
      '❌ Finalize requires summary.\n' +
      'Call: workflow_transition(action: "compoundDone", content: "<workflow summary>")'
    );
  }
  return null;
}

const VALIDATORS: Record<
  string,
  (hctx: HandlerContext) => Promise<string | null>
> = {
  reflect: validateReflect,
  cleanup: validateCleanup,
  gitCommit: validateGitCommit,
  gitPushBranch: validateGitPushBranch,
  gitMerge: validateGitMerge,
  gitPushMain: validateGitPushMain,
  gitCleanup: validateGitCleanup,
  finalize: validateFinalize,
};

// ── Helpers ────────────────────────────────────────────────────

function formatTodoList(
  todos: Array<{ title: string; status: string }>,
): string {
  return todos
    .map((t, i) => {
      const icon =
        t.status === 'done' ? '✅' : t.status === 'active' ? '🔨' : '⬜';
      return `${icon} ${i + 1}. ${t.title}`;
    })
    .join('\n');
}

const AUTO_TAG_STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'could',
  'should',
  'may',
  'might',
  'can',
  'shall',
  'to',
  'of',
  'in',
  'for',
  'on',
  'with',
  'at',
  'by',
  'from',
  'as',
  'into',
  'through',
  'during',
  'before',
  'after',
  'above',
  'below',
  'between',
  'out',
  'off',
  'over',
  'under',
  'again',
  'further',
  'then',
  'once',
  'and',
  'but',
  'or',
  'nor',
  'not',
  'so',
  'yet',
  'both',
  'each',
  'few',
  'more',
  'most',
  'other',
  'some',
  'such',
  'no',
  'only',
  'own',
  'same',
  'than',
  'too',
  'very',
  'just',
  'this',
  'that',
  'these',
  'those',
  'it',
  'its',
  'all',
  'any',
  'new',
  'use',
  'used',
  'using',
  'also',
  'added',
  'add',
  'file',
  'files',
  'change',
  'changes',
  'changed',
  'update',
]);

function extractAutoTags(summary: string): string[] {
  const words = summary
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length >= 2 && !AUTO_TAG_STOPWORDS.has(w));
  const freq = new Map<string, number>();
  for (const w of words) freq.set(w, (freq.get(w) ?? 0) + 1);
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([w]) => w);
}

/** Advance step index past any skippable steps. */
function advanceToNextValidStep(
  startStep: number,
  session: {
    gitBranch?: string;
    todos: Array<{ status: string }>;
    activeTodoIndex: number;
  },
  gitEnabled: boolean,
): number {
  let step = startStep;
  while (
    step < COMPOUND_STEPS.length &&
    shouldSkipStep(COMPOUND_STEPS[step], session, gitEnabled)
  ) {
    step++;
  }
  return step;
}

// ── Main Handler ───────────────────────────────────────────────

export async function handleCompoundDone(
  hctx: HandlerContext,
): Promise<HandlerResult> {
  const { session } = hctx;
  const gitEnabled = hctx.settings.git?.enabled !== false;

  // 1. Find current valid step (skip inapplicable steps)
  let step = advanceToNextValidStep(
    session.compoundStep ?? 0,
    session,
    gitEnabled,
  );

  // 2. All steps complete → finalize
  if (step >= COMPOUND_STEPS.length) {
    return await completeCompound(hctx);
  }

  // 3. Validate current step
  const stepDef = COMPOUND_STEPS[step];
  const validator = VALIDATORS[stepDef.id];
  if (validator) {
    const error = await validator(hctx);
    if (error) {
      session.compoundStep = step;
      return {
        text:
          `🧠 Step ${step + 1}/${COMPOUND_STEPS.length}: **${stepDef.label}**\n\n` +
          error,
      };
    }
  }

  // 4. Step-specific post-processing
  if (stepDef.id === 'reflect') {
    // Auto-promotion: patterns with count >= 3 → critical.md
    const wfMem = loadWorkflowMemory(hctx.ctx.cwd, hctx.session.id);
    const promoted: string[] = [];
    const remaining = wfMem.patterns.filter((p) => {
      if (p.count >= 3) {
        appendCriticalPattern(hctx.ctx.cwd, p);
        promoted.push(p.text);
        return false;
      }
      return true;
    });
    if (promoted.length > 0) {
      wfMem.patterns = remaining;
      saveWorkflowMemory(hctx.ctx.cwd, hctx.session.id, wfMem);
    }
  }

  // 5. Advance to next valid step
  step = advanceToNextValidStep(step + 1, session, gitEnabled);
  session.compoundStep = step;

  // 6. All steps complete after advance
  if (step >= COMPOUND_STEPS.length) {
    return await completeCompound(hctx);
  }

  // 7. Show next step instruction
  const nextDef = COMPOUND_STEPS[step];
  return {
    text:
      `✅ Step passed. Next → Step ${step + 1}/${COMPOUND_STEPS.length}: **${nextDef.label}**\n\n` +
      nextDef.instruction,
  };
}

// ── Complete Compound (TODO advance / finalize) ────────────────

async function completeCompound(hctx: HandlerContext): Promise<HandlerResult> {
  const { session } = hctx;
  const summary = hctx.params.content?.trim() || '';
  const tags = summary ? extractAutoTags(summary) : undefined;
  const gitCwd = getGitCwd(hctx.ctx.cwd);

  if (
    session.activeTodoIndex >= 0 &&
    session.activeTodoIndex < session.todos.length
  ) {
    const completedIndex = session.activeTodoIndex;
    session.todos[completedIndex].status = 'done';
    const nextIndex = completedIndex + 1;

    if (nextIndex < session.todos.length) {
      return await advanceToNextTodo(hctx, {
        completedIndex,
        nextIndex,
        summary,
        tags,
        gitCwd,
      });
    }
    // Last TODO — commit + capture endCommit before finalize
    if (
      hctx.settings.git?.enabled !== false &&
      hctx.settings.git?.commitPerTodo !== false
    ) {
      const commit = await autoCommitTodo(
        hctx.pi,
        session,
        completedIndex,
        gitCwd,
      );
      if (commit.commitHash && session.todos[completedIndex]) {
        session.todos[completedIndex].endCommit = commit.commitHash;
      }
      if (commit.ok && hctx.settings.git?.pushPerTodo) {
        const pushBranch =
          session.gitBranch ?? (await getCurrentBranch(hctx.pi, gitCwd));
        if (pushBranch) {
          await autoPush(hctx.pi, pushBranch, gitCwd);
        }
      }
    }
    return await finalizeWorkflow(hctx, { summary, tags });
  }
  return await finalizeWorkflow(hctx, { summary, tags });
}

// ── advanceToNextTodo (preserved from original) ────────────────

interface AdvanceParams {
  completedIndex: number;
  nextIndex: number;
  summary: string;
  tags?: string[];
  gitCwd: string;
}

async function advanceToNextTodo(
  hctx: HandlerContext,
  p: AdvanceParams,
): Promise<HandlerResult> {
  const { session, settings, pi } = hctx;
  const gitNotes: string[] = [];

  if (
    settings.git?.enabled !== false &&
    settings.git?.commitPerTodo !== false
  ) {
    const commit = await autoCommitTodo(
      pi,
      session,
      p.completedIndex,
      p.gitCwd,
    );
    gitNotes.push(commit.ok ? `📦 ${commit.message}` : `⚠️ ${commit.message}`);
    // Save endCommit for the completed TODO
    if (commit.commitHash && session.todos[p.completedIndex]) {
      session.todos[p.completedIndex].endCommit = commit.commitHash;
    }

    if (commit.ok && settings.git?.pushPerTodo) {
      const pushBranch =
        session.gitBranch ?? (await getCurrentBranch(pi, p.gitCwd));
      if (pushBranch) {
        const push = await autoPush(pi, pushBranch, p.gitCwd);
        gitNotes.push(push.ok ? `🚀 ${push.message}` : `⚠️ ${push.message}`);
      }
    }
  }

  let solutionPath: string | null = null;
  if (p.summary) {
    const meta = extractSolutionMeta(p.summary);
    solutionPath = saveSolution(
      hctx.ctx.cwd,
      session.description,
      p.summary,
      session.id,
      { tags: p.tags, ...meta },
    );
  }

  // Advance session state
  session.todos[p.nextIndex].status = 'active';
  session.activeTodoIndex = p.nextIndex;
  session.state = 'implement';
  session.retryCount = 0;
  session.compoundStep = undefined;
  // Capture startCommit for next TODO
  const nextHead = await runGit(hctx.pi, ['rev-parse', 'HEAD'], p.gitCwd);
  if (nextHead.ok) {
    session.todos[p.nextIndex].startCommit = nextHead.stdout;
  }

  // Clear startup prep flags only when mandatory prep TODO (index 0) completes
  if (session.startupPrepRequired && p.completedIndex === 0) {
    session.startupPrepRequired = false;
    session.startupPrepNote = '';
    session.startupPrepLocked = false;
  }

  const doneCount = session.todos.filter((t) => t.status === 'done').length;
  const todoList = formatTodoList(session.todos);
  const compactSummary = p.summary.slice(0, 200);

  return {
    text:
      `📋 TODO [${doneCount}/${session.todos.length}] — Moving to next item\n\n` +
      `${todoList}\n\n` +
      (solutionPath ? `**Solution saved:** ${solutionPath}\n\n` : '') +
      (gitNotes.length > 0
        ? `**Git automation:**\n${gitNotes.join('\n')}\n\n`
        : '') +
      `Now implement TODO #${p.nextIndex + 1}: "${session.todos[p.nextIndex].title}"\n` +
      `Refer to the TODO #${p.nextIndex + 1} section in the approved plan above.`,
    stageConfig: settings.stages.implement,
    compact:
      `${RESET_MARKER} Workflow "${session.description}" — TODO #${p.completedIndex + 1} completed. ` +
      `Preserve: unified plan, TODO list progress, key decisions. ` +
      `Previous TODO learning: "${compactSummary}". ` +
      `Discard: implementation details, verification output, code diffs.`,
  };
}

// ── finalizeWorkflow ───────────────────────────────────────────

interface FinalizeParams {
  summary: string;
  tags?: string[];
}

async function finalizeWorkflow(
  hctx: HandlerContext,
  p: FinalizeParams,
): Promise<HandlerResult> {
  const { session } = hctx;

  let solutionPath: string | null = null;
  if (p.summary) {
    const meta = extractSolutionMeta(p.summary);
    solutionPath = saveSolution(
      hctx.ctx.cwd,
      session.description,
      p.summary,
      session.id,
      { tags: p.tags, ...meta },
    );
  }

  const completedTodoCount = session.todos.length;
  const todoSummary =
    completedTodoCount > 0
      ? `**TODOs completed:** ${completedTodoCount}/${completedTodoCount}\n`
      : '';

  // Session cleanup — preserve todos/gitBranch/planContent for done-state review
  session.activeTodoIndex = -1;
  session.verifyPlanResult = '';
  session.retryCount = 0;
  session.startupPrepRequired = false;
  session.startupPrepNote = '';
  session.startupPrepLocked = false;
  session.gitWorktreePath = undefined;
  session.compoundMemorySnapshot = undefined;
  session.compoundStep = undefined;
  session.state = 'done';
  session.completed = true;

  // Remove currentWork
  try {
    const curMemory = loadMemory(hctx.ctx.cwd);
    curMemory.currentWork = curMemory.currentWork.filter(
      (w) => !w.what.startsWith(`[${session.id}]`),
    );
    saveMemory(hctx.ctx.cwd, curMemory);
  } catch (e) {
    console.error('[workflow] currentWork cleanup failed:', e);
  }

  return {
    text:
      '🎉 Workflow Complete!\n\n' +
      `**Task:** ${session.description}\n` +
      `**ID:** ${session.id}\n` +
      todoSummary +
      (solutionPath ? `**Solution saved:** ${solutionPath}\n` : '') +
      '\nLearnings captured for future reference.',
    compact:
      `${RESET_MARKER} Workflow "${session.description}" completed. ` +
      `Preserve: task description, final outcome, key decisions. ` +
      `Discard: implementation details, verification output, code diffs.`,
  };
}
