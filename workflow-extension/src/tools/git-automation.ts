// tools/git-automation.ts — Git automation helpers for workflow transitions
// Extracted from transition.ts for single responsibility.

import { resolve } from 'node:path';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import type { WorkflowSession } from '../types';

export async function runGit(
  pi: ExtensionAPI,
  args: string[],
  cwd?: string,
): Promise<{ ok: boolean; stdout: string; stderr: string; code: number }> {
  try {
    const gitArgs = cwd ? ['-C', cwd, ...args] : args;
    const result = await pi.exec('git', gitArgs);
    return {
      ok: result.code === 0,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
      code: result.code,
    };
  } catch (e) {
    return {
      ok: false,
      stdout: '',
      stderr: e instanceof Error ? e.message : 'git command failed',
      code: -1,
    };
  }
}

export function getGitCwd(cwd: string): string {
  return resolve(cwd);
}

export async function hasUncommittedChanges(
  pi: ExtensionAPI,
  gitCwd: string,
): Promise<boolean> {
  const status = await runGit(pi, ['status', '--porcelain'], gitCwd);
  if (!status.ok) return false;
  return status.stdout.length > 0;
}

export async function autoCommitTodo(
  pi: ExtensionAPI,
  session: WorkflowSession,
  todoIndex: number,
  gitCwd: string,
): Promise<{ ok: boolean; message: string; commitHash?: string }> {
  const add = await runGit(pi, ['add', '-A'], gitCwd);
  if (!add.ok) {
    return {
      ok: false,
      message: `git add failed: ${add.stderr || `exit ${add.code}`}`,
    };
  }

  const hasChanges = await hasUncommittedChanges(pi, gitCwd);
  if (!hasChanges) {
    const currentHead = await runGit(pi, ['rev-parse', 'HEAD'], gitCwd);
    return {
      ok: true,
      message: 'No changes to commit for this TODO.',
      commitHash: currentHead.ok ? currentHead.stdout : undefined,
    };
  }

  const todo = session.todos[todoIndex];
  const title = todo?.title ?? 'unknown';
  const msg = `chore(workflow): TODO #${todoIndex + 1} - ${title}`;
  const commit = await runGit(pi, ['commit', '-m', msg], gitCwd);
  if (!commit.ok) {
    return {
      ok: false,
      message: `git commit failed: ${commit.stderr || `exit ${commit.code}`}`,
    };
  }

  const hash = await runGit(pi, ['rev-parse', 'HEAD'], gitCwd);
  return {
    ok: true,
    message: `Committed TODO #${todoIndex + 1}${hash.ok && hash.stdout ? ` (${hash.stdout.slice(0, 7)})` : ''}`,
    commitHash: hash.ok ? hash.stdout : undefined,
  };
}

export async function autoCommitFinal(
  pi: ExtensionAPI,
  session: WorkflowSession,
  completedTodoIndex: number | null,
  gitCwd: string,
): Promise<{ ok: boolean; message: string }> {
  const add = await runGit(pi, ['add', '-A'], gitCwd);
  if (!add.ok) {
    return {
      ok: false,
      message: `git add failed: ${add.stderr || `exit ${add.code}`}`,
    };
  }

  const hasChanges = await hasUncommittedChanges(pi, gitCwd);
  if (!hasChanges) {
    return { ok: true, message: 'No changes to commit for finalization.' };
  }

  const finalTitle =
    completedTodoIndex !== null
      ? session.todos[completedTodoIndex]?.title || 'unknown'
      : 'workflow completion';
  const msg =
    completedTodoIndex !== null
      ? `chore(workflow): final - TODO #${completedTodoIndex + 1} - ${finalTitle}`
      : `chore(workflow): final - ${session.description}`;

  const commit = await runGit(pi, ['commit', '-m', msg], gitCwd);
  if (!commit.ok) {
    return {
      ok: false,
      message: `git commit failed: ${commit.stderr || `exit ${commit.code}`}`,
    };
  }

  const hash = await runGit(pi, ['rev-parse', '--short', 'HEAD'], gitCwd);
  return {
    ok: true,
    message: `Final commit created${hash.ok && hash.stdout ? ` (${hash.stdout})` : ''}`,
  };
}

export async function autoPush(
  pi: ExtensionAPI,
  branch: string | undefined,
  gitCwd: string,
): Promise<{ ok: boolean; message: string }> {
  if (!branch) {
    return {
      ok: false,
      message:
        'Push target branch is not set. Push skipped to avoid unintended current-branch push.',
    };
  }

  const push = await runGit(pi, ['push', 'origin', branch], gitCwd);
  if (!push.ok) {
    return {
      ok: false,
      message: `git push failed: ${push.stderr || `exit ${push.code}`}`,
    };
  }
  return {
    ok: true,
    message: `Pushed origin/${branch}`,
  };
}

export async function getCurrentBranch(
  pi: ExtensionAPI,
  gitCwd: string,
): Promise<string | undefined> {
  const result = await runGit(
    pi,
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    gitCwd,
  );
  if (!result.ok || result.stdout === 'HEAD') return undefined;
  return result.stdout.trim();
}
