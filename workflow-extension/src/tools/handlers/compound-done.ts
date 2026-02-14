// tools/handlers/compound-done.ts — compoundDone action handler
// Handles TODO progression, git automation, and workflow finalization.

import { appendCriticalPattern } from '../../storage/critical-patterns';
import { loadMemory, saveMemory } from '../../storage/memory';
import { saveSolution } from '../../storage/solution';
import { RESET_MARKER } from '../compact';
import {
  autoCommitTodo,
  autoPush,
  getGitCwd,
  hasUncommittedChanges,
} from '../git-automation';
import type { HandlerContext, HandlerResult } from './types';

/** Format TODO list with status icons. */
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

/** Extract top keywords from summary text for auto-tagging. */
function extractAutoTags(summary: string): string[] {
  const STOPWORDS = new Set([
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
  const words = summary
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w));
  const freq = new Map<string, number>();
  for (const w of words) freq.set(w, (freq.get(w) ?? 0) + 1);
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([w]) => w);
}

export async function handleCompoundDone(
  hctx: HandlerContext,
): Promise<HandlerResult> {
  const { session } = hctx;

  // ── Auto-promotion: patterns with count >= 3 → critical.md ──
  const memory = loadMemory(hctx.ctx.cwd);
  const promoted: string[] = [];
  const remaining = memory.patterns.filter((p) => {
    if (p.count >= 3) {
      appendCriticalPattern(hctx.ctx.cwd, p.text, p.count);
      promoted.push(p.text);
      return false;
    }
    return true;
  });
  if (promoted.length > 0) {
    memory.patterns = remaining;
    saveMemory(hctx.ctx.cwd, memory);
  }
  const promotedNote =
    promoted.length > 0
      ? `📌 Promoted to Critical: ${promoted.join(', ')}\n\n`
      : '';

  const summary = hctx.params.content?.trim() || '';
  const tags = summary ? extractAutoTags(summary) : undefined;
  let solutionPath: string | null = null;
  if (summary) {
    solutionPath = saveSolution(
      hctx.ctx.cwd,
      session.description,
      summary,
      session.id,
      tags,
    );
  }

  const gitCwd = getGitCwd(hctx.ctx.cwd);

  // ── Advance to next TODO ─────────────────────────────────────
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
        solutionPath,
        gitCwd,
        promotedNote,
      });
    }

    // Last TODO — fall through to finalization
    return await finalizeWorkflow(hctx, { solutionPath, promotedNote });
  }

  // No TODOs — finalize directly
  return await finalizeWorkflow(hctx, { solutionPath, promotedNote });
}

// ── Sub-handlers ─────────────────────────────────────────────────

interface AdvanceParams {
  completedIndex: number;
  nextIndex: number;
  summary: string;
  solutionPath: string | null;
  gitCwd: string;
  promotedNote: string;
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

    if (commit.ok && settings.git?.pushPerTodo) {
      const push = await autoPush(pi, session.gitBranch, p.gitCwd);
      gitNotes.push(push.ok ? `🚀 ${push.message}` : `⚠️ ${push.message}`);
    }
  }

  // Advance session state
  session.todos[p.nextIndex].status = 'active';
  session.activeTodoIndex = p.nextIndex;
  session.state = 'implement';
  session.retryCount = 0;

  const doneCount = session.todos.filter((t) => t.status === 'done').length;
  const todoList = formatTodoList(session.todos);
  const compactSummary = p.summary.slice(0, 200);

  return {
    text:
      p.promotedNote +
      `📋 TODO [${doneCount}/${session.todos.length}] — Moving to next item\n\n` +
      `${todoList}\n\n` +
      (p.solutionPath ? `**Solution saved:** ${p.solutionPath}\n\n` : '') +
      (gitNotes.length > 0
        ? `**Git automation:**\n${gitNotes.join('\n')}\n\n`
        : '') +
      `Now implement TODO #${p.nextIndex + 1}: "${session.todos[p.nextIndex].title}"\n` +
      `Refer to the TODO #${p.nextIndex + 1} section in the approved plan above.`,
    stageConfig: settings.stages.implement,
    compact:
      `${RESET_MARKER} Workflow "${session.description}" — TODO #${p.nextIndex} completed. ` +
      `Preserve: unified plan, TODO list progress, key decisions. ` +
      `Previous TODO learning: "${compactSummary}". ` +
      `Discard: implementation details, verification output, code diffs.`,
  };
}

interface FinalizeParams {
  solutionPath: string | null;
  promotedNote: string;
}

async function finalizeWorkflow(
  hctx: HandlerContext,
  p: FinalizeParams,
): Promise<HandlerResult> {
  const { session, pi } = hctx;

  // Lightweight check: model should have completed git cleanup already
  const gitCwd = getGitCwd(hctx.ctx.cwd);
  const hasChanges = await hasUncommittedChanges(pi, gitCwd);
  if (hasChanges) {
    session.state = 'compound';
    return {
      text: '⚠️ Uncommitted changes detected. Complete the git cleanup checklist before calling compoundDone.',
    };
  }

  const completedTodoCount = session.todos.length;
  const todoSummary =
    completedTodoCount > 0
      ? `**TODOs completed:** ${completedTodoCount}/${completedTodoCount}\n`
      : '';

  // Session cleanup
  session.todos = [];
  session.activeTodoIndex = -1;
  session.planContent = '';
  session.verifyPlanResult = '';
  session.retryCount = 0;
  session.startupPrepRequired = false;
  session.startupPrepNote = '';
  session.startupPrepLocked = false;
  session.gitBranch = undefined;
  session.gitWorktreePath = undefined;
  session.state = 'done';
  session.completed = true;

  // Remove currentWork
  try {
    const memory = loadMemory(hctx.ctx.cwd);
    memory.currentWork = memory.currentWork.filter(
      (w) => !w.what.startsWith(`[${session.id}]`),
    );
    saveMemory(hctx.ctx.cwd, memory);
  } catch {
    // Ignore cleanup errors
  }

  return {
    text:
      p.promotedNote +
      '🎉 Workflow Complete!\n\n' +
      `**Task:** ${session.description}\n` +
      `**ID:** ${session.id}\n` +
      todoSummary +
      (p.solutionPath ? `**Solution saved:** ${p.solutionPath}\n` : '') +
      '\nLearnings captured for future reference.',
    compact:
      `${RESET_MARKER} Workflow "${session.description}" completed. ` +
      `Preserve: task description, final outcome, key decisions. ` +
      `Discard: implementation details, verification output, code diffs.`,
  };
}
