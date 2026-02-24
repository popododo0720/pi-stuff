// commands/git-worktree.ts — Git state checks and worktree management
// Used at workflow startup to detect git state, create branches, and set up worktrees.
// Distinct from tools/git-automation.ts which handles commit/push during transitions.

import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';

export interface GitStateCheckResult {
  dirty: boolean;
  checkFailed: boolean;
  error?: string;
}

export interface GitWorktreeEntry {
  path: string;
  branch?: string;
  detached: boolean;
}

export async function safeGitStatus(
  pi: ExtensionAPI,
): Promise<GitStateCheckResult> {
  try {
    const result = await pi.exec('git', ['status', '--porcelain']);
    if (result.code !== 0) {
      return {
        dirty: true,
        checkFailed: true,
        error:
          result.stderr.trim() ||
          `git status failed with exit code ${result.code}`,
      };
    }

    return {
      dirty: result.stdout.trim().length > 0,
      checkFailed: false,
    };
  } catch (e) {
    return {
      dirty: true,
      checkFailed: true,
      error: e instanceof Error ? e.message : 'git status failed',
    };
  }
}

export async function safeGitWorktreeList(
  pi: ExtensionAPI,
): Promise<{ summary: string; count?: number; error?: string }> {
  try {
    const result = await pi.exec('git', ['worktree', 'list']);
    if (result.code !== 0) {
      return {
        summary: 'Worktree check failed.',
        error:
          result.stderr.trim() ||
          `git worktree list failed with exit code ${result.code}`,
      };
    }

    const output = result.stdout.trim();
    if (!output) return { summary: 'No worktree info.', count: 0 };

    const lines = output
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const count = lines.length;
    return {
      summary:
        count > 1
          ? `Detected ${count} worktrees.`
          : `Detected ${count} worktree.`,
      count,
    };
  } catch (e) {
    return {
      summary: 'Worktree check failed.',
      error: e instanceof Error ? e.message : 'git worktree list failed',
    };
  }
}

export async function safeGitRoot(
  pi: ExtensionAPI,
): Promise<{ root?: string; error?: string }> {
  try {
    const result = await pi.exec('git', ['rev-parse', '--show-toplevel']);
    if (result.code !== 0) {
      return {
        error:
          result.stderr.trim() ||
          `failed to detect git root (exit ${result.code})`,
      };
    }
    const root = result.stdout.trim();
    if (!root) return { error: 'git root is empty' };
    return { root: resolve(root) };
  } catch (e) {
    return {
      error: e instanceof Error ? e.message : 'failed to detect git root',
    };
  }
}

export async function safeGitCurrentBranch(
  pi: ExtensionAPI,
): Promise<{ branch?: string; detached: boolean; error?: string }> {
  try {
    const result = await pi.exec('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (result.code !== 0) {
      return {
        detached: false,
        error:
          result.stderr.trim() ||
          `failed to detect current branch (exit ${result.code})`,
      };
    }
    const branch = result.stdout.trim();
    if (!branch || branch === 'HEAD') {
      return { detached: true };
    }
    return { branch, detached: false };
  } catch (e) {
    return {
      detached: false,
      error: e instanceof Error ? e.message : 'failed to detect current branch',
    };
  }
}

export function normalizeBranchName(ref?: string): string | undefined {
  if (!ref) return undefined;
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

export async function safeGitWorktreePorcelain(
  pi: ExtensionAPI,
): Promise<{ entries: GitWorktreeEntry[]; error?: string }> {
  try {
    const result = await pi.exec('git', ['worktree', 'list', '--porcelain']);
    if (result.code !== 0) {
      return {
        entries: [],
        error:
          result.stderr.trim() ||
          `git worktree list --porcelain failed (exit ${result.code})`,
      };
    }

    const entries: GitWorktreeEntry[] = [];
    let current: GitWorktreeEntry | null = null;
    const lines = result.stdout.split(/\r?\n/);

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        if (current) entries.push(current);
        current = null;
        continue;
      }

      if (trimmed.startsWith('worktree ')) {
        if (current) entries.push(current);
        current = {
          path: resolve(trimmed.slice('worktree '.length).trim()),
          detached: false,
        };
        continue;
      }

      if (!current) continue;
      if (trimmed.startsWith('branch ')) {
        current.branch = trimmed.slice('branch '.length).trim();
      } else if (trimmed === 'detached') {
        current.detached = true;
      }
    }

    if (current) entries.push(current);
    return { entries };
  } catch (e) {
    return {
      entries: [],
      error:
        e instanceof Error ? e.message : 'git worktree list --porcelain failed',
    };
  }
}

export function toBranchSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
}

export function getWorkflowWorktreePath(root: string, branch: string): string {
  const repoName = toBranchSlug(basename(root) || 'repo') || 'repo';
  const branchSlug = toBranchSlug(normalizeBranchName(branch) || 'branch');
  return resolve(root, '..', '.pi-worktrees', repoName, branchSlug || 'branch');
}

export async function ensureWorkflowBranch(
  pi: ExtensionAPI,
  workflowId: string,
  description: string,
): Promise<{ branch?: string; message?: string; error?: string }> {
  const slug = toBranchSlug(description || 'workflow') || 'workflow';
  const branch = `wf/${workflowId}-${slug}`;

  const current = await pi.exec('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (current.code !== 0) {
    return {
      error:
        current.stderr.trim() ||
        `failed to detect current branch (exit ${current.code})`,
    };
  }

  const exists = await pi.exec('git', ['rev-parse', '--verify', branch]);
  if (exists.code === 0) {
    const checkout = await pi.exec('git', ['checkout', branch]);
    if (checkout.code !== 0) {
      return {
        error:
          checkout.stderr.trim() ||
          `git checkout failed (exit ${checkout.code})`,
      };
    }
    return {
      branch,
      message: `Switched to existing workflow branch: ${branch}`,
    };
  }

  const create = await pi.exec('git', ['checkout', '-b', branch]);
  if (create.code !== 0) {
    return {
      error:
        create.stderr.trim() || `git checkout -b failed (exit ${create.code})`,
    };
  }
  return { branch, message: `Created workflow branch: ${branch}` };
}

export async function ensureWorkflowWorkspace(
  pi: ExtensionAPI,
  gitRoot: string,
  branch: string,
): Promise<{ path?: string; message?: string; error?: string }> {
  const normalizedBranch = normalizeBranchName(branch);
  if (!normalizedBranch) {
    return { error: 'No branch available for workflow worktree.' };
  }

  const porcelain = await safeGitWorktreePorcelain(pi);
  if (porcelain.error) return { error: porcelain.error };

  const targetPath = resolve(
    getWorkflowWorktreePath(gitRoot, normalizedBranch),
  );

  const existingByBranch = porcelain.entries.find(
    (e) => normalizeBranchName(e.branch) === normalizedBranch,
  );
  if (existingByBranch) {
    return {
      path: existingByBranch.path,
      message: `Reusing existing worktree for ${normalizedBranch}: ${existingByBranch.path}`,
    };
  }

  const existingByPath = porcelain.entries.find(
    (e) => resolve(e.path) === targetPath,
  );
  if (existingByPath) {
    return {
      error:
        `Target worktree path already in use by ${normalizeBranchName(existingByPath.branch) || 'detached HEAD'}: ` +
        targetPath,
    };
  }

  if (existsSync(targetPath)) {
    return {
      error: `Target worktree path exists but is not a registered worktree: ${targetPath}`,
    };
  }

  const add = await pi.exec('git', [
    'worktree',
    'add',
    targetPath,
    normalizedBranch,
  ]);
  if (add.code !== 0) {
    return {
      error:
        add.stderr.trim() ||
        `git worktree add failed for ${normalizedBranch} (exit ${add.code})`,
    };
  }

  return {
    path: targetPath,
    message: `Created workflow worktree (${normalizedBranch}): ${targetPath}`,
  };
}
