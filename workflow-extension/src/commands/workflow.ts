// commands/workflow.ts — /workflow command
// Starts a new workflow session or replaces an existing one.

import { existsSync } from 'node:fs';
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from '@mariozechner/pi-coding-agent';
import { generateWorkflowId } from '../constants';
import { updateStatusBar } from '../context/status';
import { loadMemory, resolveMemoryPath, saveMemory } from '../storage/memory';
import { loadSettings } from '../storage/settings';
import { applyStageConfig } from '../tools/transition';
import type { WorkflowSession } from '../types';
import { cleanupVerificationResults } from '../verification';

interface GitStateCheckResult {
  dirty: boolean;
  checkFailed: boolean;
  error?: string;
}

async function safeGitStatus(pi: ExtensionAPI): Promise<GitStateCheckResult> {
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

async function safeGitWorktreeList(
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
      .split('\n')
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

function toBranchSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
}

async function ensureWorkflowBranch(
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

/**
 * Register the /workflow command.
 * Creates a new workflow session and initializes memory if needed.
 */
export function registerWorkflowCommand(
  pi: ExtensionAPI,
  getSession: () => WorkflowSession | null,
  setSession: (s: WorkflowSession) => void,
) {
  pi.registerCommand('workflow', {
    description:
      'Start automated workflow: plan → verify → implement → verify → compound',
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const description = args.trim();
      const currentSession = getSession();
      const settings = loadSettings(ctx.cwd);

      // Confirm replacement if a workflow is already active
      if (currentSession && currentSession.state !== 'done') {
        const confirmed = await ctx.ui.confirm(
          'Active workflow exists',
          'A workflow is in progress. Replace with a new one?',
        );
        if (!confirmed) return;
      }

      // Initialize memory file if it doesn't exist
      let hasMemory = false;
      try {
        hasMemory = existsSync(resolveMemoryPath(ctx.cwd));
        if (!hasMemory) {
          saveMemory(ctx.cwd, {
            conventions: [],
            rules: [],
            workflows: [],
            currentWork: [],
            notes: [],
            patterns: [],
            gotchas: [],
            decisions: [],
          });
        }
      } catch {
        // Ignore memory initialization errors
      }

      // Check git/worktree state first
      const gitStatus = await safeGitStatus(pi);
      const worktreeInfo = await safeGitWorktreeList(pi);

      // Create new session with unique ID
      const id = generateWorkflowId();
      const session: WorkflowSession = {
        id,
        state: 'plan',
        description: description || 'Workflow',
        planContent: '',
        verifyPlanResult: '',
        retryCount: 0,
        completed: false,
        todos: [],
        activeTodoIndex: -1,
        startupPrepRequired: false,
        startupPrepNote: '',
        startupPrepLocked: false,
      };

      const requireCleanStart = settings.git?.requireCleanStart !== false;
      const useWorkflowBranch = settings.git?.useWorkflowBranch !== false;

      if (gitStatus.checkFailed) {
        // Unknown git state -> force prep TODO #1
        session.startupPrepRequired = true;
        session.startupPrepLocked = true;
        session.startupPrepNote =
          `Git state check failed: ${gitStatus.error || 'unknown error'}. ` +
          `${worktreeInfo.summary}` +
          (worktreeInfo.error ? ` (${worktreeInfo.error})` : '');
        session.todos = [
          {
            title:
              'Git/Worktree preparation: resolve git state check failure before feature work',
            status: 'active',
          },
          {
            title: `Main workflow task: ${session.description}`,
            status: 'pending',
          },
        ];
        session.activeTodoIndex = 0;
        ctx.ui.notify(
          '⚠️ Git state check failed. Added mandatory TODO #1 for repository preparation.',
          'warning',
        );
      } else if (gitStatus.dirty && requireCleanStart) {
        // Dirty tree + clean start required -> ask strategy and force TODO #1
        const strategyOptions = [
          'Commit current changes before feature work',
          'Stash current changes before feature work',
          'Proceed without cleanup (risky)',
          'Cancel workflow start',
        ];
        const selected = await ctx.ui.select(
          'Dirty git tree detected',
          strategyOptions,
        );

        if (!selected || selected === 'Cancel workflow start') {
          ctx.ui.notify('Workflow start cancelled.', 'info');
          return;
        }

        session.startupPrepRequired = true;
        session.startupPrepLocked = true;
        session.startupPrepNote =
          `Dirty tree detected. User cleanup strategy: ${selected}. ${worktreeInfo.summary}` +
          (worktreeInfo.error ? ` (${worktreeInfo.error})` : '');
        session.todos = [
          {
            title: `Git/Worktree preparation: ${selected}`,
            status: 'active',
          },
          {
            title: `Main workflow task: ${session.description}`,
            status: 'pending',
          },
        ];
        session.activeTodoIndex = 0;
      } else {
        // Clean tree (or dirty allowed by settings) -> proceed directly
        session.startupPrepRequired = false;
        session.startupPrepLocked = false;
        session.startupPrepNote =
          (gitStatus.dirty
            ? 'Dirty git tree allowed by settings. '
            : 'Clean git tree. ') +
          `${worktreeInfo.summary}` +
          (worktreeInfo.error ? ` (${worktreeInfo.error})` : '');
      }

      if (worktreeInfo.count && worktreeInfo.count > 1) {
        ctx.ui.notify(
          `ℹ️ Multiple worktrees detected (${worktreeInfo.count}). Worktree switching is manual; this workflow only manages branch strategy.`,
          'info',
        );
      }

      if (
        !session.startupPrepRequired &&
        useWorkflowBranch &&
        !gitStatus.checkFailed
      ) {
        const branchResult = await ensureWorkflowBranch(
          pi,
          session.id,
          session.description,
        );
        if (branchResult.branch) {
          session.gitBranch = branchResult.branch;
        }
        if (branchResult.message) {
          ctx.ui.notify(branchResult.message, 'info');
        }
        if (branchResult.error) {
          ctx.ui.notify(
            `⚠️ Workflow branch setup failed. Continuing on current branch. (${branchResult.error})`,
            'warning',
          );
        }
      }

      // Clean up previous workflow only after new-start decisions are finalized
      cleanupVerificationResults(ctx.cwd);
      if (currentSession) {
        try {
          const memory = loadMemory(ctx.cwd);
          memory.currentWork = memory.currentWork.filter(
            (w) => !w.what.startsWith(`[${currentSession.id}]`),
          );
          saveMemory(ctx.cwd, memory);
        } catch {
          // Ignore cleanup errors
        }
      }

      setSession(session);
      updateStatusBar(ctx, session);

      // Apply plan stage config
      await applyStageConfig(pi, ctx, settings.stages.plan);

      // Show different message for new vs returning users
      if (session.startupPrepRequired) {
        ctx.ui.notify(
          '🧹 Added mandatory TODO #1 for git/worktree preparation before feature work.',
          'info',
        );
      } else {
        ctx.ui.notify(
          hasMemory
            ? '📝 Entered planning mode. Tell me what to build.'
            : "🚀 Starting project setup. Let's organize conventions first.",
          'info',
        );
      }
    },
  });
}
