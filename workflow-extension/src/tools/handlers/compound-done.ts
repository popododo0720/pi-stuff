// tools/handlers/compound-done.ts — compoundDone action handler
// Handles TODO progression, git automation, and workflow finalization.

import { loadMemory, saveMemory } from '../../storage/memory';
import { saveSolution } from '../../storage/solution';
import { RESET_MARKER } from '../compact';
import {
  autoCommitFinal,
  autoCommitTodo,
  autoPush,
  getGitCwd,
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

export async function handleCompoundDone(
  hctx: HandlerContext,
): Promise<HandlerResult> {
  const { session } = hctx;

  const summary = hctx.params.content?.trim() || '';
  let solutionPath: string | null = null;
  if (summary) {
    solutionPath = saveSolution(
      hctx.ctx.cwd,
      session.description,
      summary,
      session.id,
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
      });
    }

    // Last TODO — fall through to finalization
    return await finalizeWorkflow(hctx, {
      completedTodoIndex: completedIndex,
      summary,
      solutionPath,
      gitCwd,
    });
  }

  // No TODOs — finalize directly
  return await finalizeWorkflow(hctx, {
    completedTodoIndex: null,
    summary,
    solutionPath,
    gitCwd,
  });
}

// ── Sub-handlers ─────────────────────────────────────────────────

interface AdvanceParams {
  completedIndex: number;
  nextIndex: number;
  summary: string;
  solutionPath: string | null;
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
  completedTodoIndex: number | null;
  summary: string;
  solutionPath: string | null;
  gitCwd: string;
}

async function finalizeWorkflow(
  hctx: HandlerContext,
  p: FinalizeParams,
): Promise<HandlerResult> {
  const { session, settings, pi } = hctx;
  const finalGitNotes: string[] = [];

  if (settings.git?.enabled !== false) {
    const finalCommit = await autoCommitFinal(
      pi,
      session,
      p.completedTodoIndex,
      p.gitCwd,
    );
    if (!finalCommit.ok) {
      session.state = 'compound';
      return {
        text: `❌ Final commit failed. Workflow cannot complete yet.\n\n${finalCommit.message}`,
      };
    }
    finalGitNotes.push(`📦 ${finalCommit.message}`);

    if (settings.git?.pushOnComplete !== false) {
      const branchStrategyEnabled =
        settings.git?.useWorkflowWorktree !== false ||
        settings.git?.useWorkflowBranch !== false;

      if (!session.gitBranch) {
        finalGitNotes.push(
          branchStrategyEnabled
            ? '⚠️ Final push skipped: workflow branch target is missing (e.g., startup prep path).'
            : '⚠️ Final push skipped: branch/worktree strategy is disabled, so no explicit push target is available.',
        );
      } else {
        const finalPush = await autoPush(pi, session.gitBranch, p.gitCwd);
        if (!finalPush.ok) {
          session.state = 'compound';
          return {
            text: `❌ Final push failed. Workflow cannot complete yet.\n\n${finalPush.message}`,
          };
        }
        finalGitNotes.push(`🚀 ${finalPush.message}`);
      }
    }
  }

  const completedTodoCount = session.todos.length;
  const todoSummary =
    completedTodoCount > 0
      ? `**TODOs completed:** ${completedTodoCount}/${completedTodoCount}\n`
      : '';

  // Workflow cleanup
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

  // Remove currentWork entry
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
      '🎉 Workflow Complete!\n\n' +
      `**Task:** ${session.description}\n` +
      `**ID:** ${session.id}\n` +
      todoSummary +
      (p.solutionPath ? `**Solution saved:** ${p.solutionPath}\n` : '') +
      (finalGitNotes.length > 0
        ? `**Git automation:**\n${finalGitNotes.join('\n')}\n`
        : '') +
      '\nLearnings from this workflow have been captured for future reference.',
    compact:
      `${RESET_MARKER} Workflow "${session.description}" completed. ` +
      `Preserve: task description, final outcome, key decisions. ` +
      `Discard: implementation details, verification output, code diffs.`,
  };
}
