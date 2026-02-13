// storage/git.ts — Git commit/push utilities for workflow automation.

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import type { GitAutomationConfig, WorkflowSession } from '../types';

export interface GitResult {
  ok: boolean;
  message: string;
}

/**
 * Build a conventional-commit-style message for a completed TODO.
 */
function buildCommitMessage(
  session: WorkflowSession,
  todoIndex: number,
): string {
  const todo = session.todos[todoIndex];
  const title = todo?.title ?? 'unknown';
  const num = todoIndex + 1;
  const total = session.todos.length;
  // First line: short summary. Body: workflow context.
  return `workflow(${num}/${total}): ${title}\n\nWorkflow: ${session.description}\nID: ${session.id}`;
}

/**
 * Stage all changes and commit with a TODO-specific message.
 * Returns a GitResult describing success or failure.
 */
export async function commitTodo(
  pi: ExtensionAPI,
  session: WorkflowSession,
  todoIndex: number,
): Promise<GitResult> {
  // Stage all tracked + untracked files
  const addResult = await pi.exec('git', ['add', '-A']);
  if (addResult.code !== 0) {
    return {
      ok: false,
      message: `git add failed: ${addResult.stderr.trim() || `exit ${addResult.code}`}`,
    };
  }

  // Check if there's anything to commit
  const diffResult = await pi.exec('git', ['diff', '--cached', '--quiet']);
  if (diffResult.code === 0) {
    // Nothing staged — no changes to commit
    return { ok: true, message: 'No changes to commit.' };
  }

  const msg = buildCommitMessage(session, todoIndex);
  const commitResult = await pi.exec('git', ['commit', '-m', msg]);
  if (commitResult.code !== 0) {
    return {
      ok: false,
      message: `git commit failed: ${commitResult.stderr.trim() || `exit ${commitResult.code}`}`,
    };
  }

  return { ok: true, message: commitResult.stdout.trim() };
}

/**
 * Push current branch to origin.
 */
export async function pushToRemote(pi: ExtensionAPI): Promise<GitResult> {
  const result = await pi.exec('git', ['push']);
  if (result.code !== 0) {
    return {
      ok: false,
      message: `git push failed: ${result.stderr.trim() || `exit ${result.code}`}`,
    };
  }
  return { ok: true, message: result.stdout.trim() || 'Pushed.' };
}

/**
 * Auto-commit (and optionally push) after a TODO is completed.
 * Returns a user-friendly status string. Never throws.
 */
export async function autoCommitTodo(
  pi: ExtensionAPI,
  session: WorkflowSession,
  todoIndex: number,
  config?: GitAutomationConfig,
): Promise<string> {
  if (config?.commitPerTodo === false) return '';

  const parts: string[] = [];

  const commitResult = await commitTodo(pi, session, todoIndex);
  if (!commitResult.ok) {
    return `⚠️ Auto-commit failed: ${commitResult.message}`;
  }
  parts.push(`📦 ${commitResult.message}`);

  if (config?.pushPerTodo) {
    const pushResult = await pushToRemote(pi);
    if (!pushResult.ok) {
      parts.push(`⚠️ Auto-push failed: ${pushResult.message}`);
    } else {
      parts.push(`🚀 ${pushResult.message}`);
    }
  }

  return parts.join('\n');
}
