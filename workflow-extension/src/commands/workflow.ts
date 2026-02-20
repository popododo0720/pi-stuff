// commands/workflow.ts — /workflow command
// Starts a new workflow session or replaces an existing one.
// Git state checks and worktree management are in git-worktree.ts.

import { existsSync } from 'node:fs';
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from '@mariozechner/pi-coding-agent';
import { generateWorkflowId } from '../constants';
import { updateStatusBar } from '../context/status';
import { loadMemory, resolveMemoryPath, saveMemory } from '../storage/memory';
import {
  listWorkflows,
  loadWorkflowById,
  setActiveWorkflowId,
} from '../storage/session';
import { loadSettings } from '../storage/settings';
import { applyStageConfig } from '../tools/transition';
import type { WorkflowSession } from '../types';
import { cleanupVerificationResults } from '../verification';
import {
  ensureWorkflowBranch,
  ensureWorkflowWorkspace,
  safeGitCurrentBranch,
  safeGitRoot,
  safeGitStatus,
  safeGitWorktreeList,
} from './git-worktree';

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

      let workflowName: string | undefined;

      // Multi-workflow: list existing workflows or start new
      if (!description) {
        const workflows = listWorkflows(ctx.cwd);
        const activeWorkflows = workflows.filter((w) => w.state !== 'done');

        if (activeWorkflows.length > 0) {
          const options = [
            ...activeWorkflows.map(
              (w) => `📋 ${w.name || w.description} (${w.id} - ${w.state})`,
            ),
            '➕ Start new workflow',
          ];
          const selected = await ctx.ui.select('Select workflow', options);

          if (!selected) return;

          if (selected !== '➕ Start new workflow') {
            // Resume selected workflow
            const selectedIdx = options.indexOf(selected);
            const wf = activeWorkflows[selectedIdx];
            const loaded = loadWorkflowById(ctx.cwd, wf.id);
            if (loaded) {
              setActiveWorkflowId(ctx.cwd, loaded.id);
              setSession(loaded);
              // Re-apply stage config for current state
              const stateConfigMap: Record<
                string,
                keyof typeof settings.stages
              > = {
                plan: 'plan',
                verifyPlan: 'verify',
                implement: 'implement',
                verifyImpl: 'verify',
                compound: 'compound',
              };
              const configKey = stateConfigMap[loaded.state];
              if (configKey) {
                await applyStageConfig(pi, ctx, settings.stages[configKey]);
              }
              updateStatusBar(ctx, loaded);
              ctx.ui.notify(
                `🔄 Resumed: ${loaded.name || loaded.description} (${loaded.state})`,
                'info',
              );
              return;
            }
          }
          // Fall through to new workflow creation
        }

        // Ask for name when no description provided
        const nameInput = await ctx.ui.input(
          'Workflow name (brief description)',
        );
        if (!nameInput) return;
        workflowName = nameInput;
      }

      if (description) {
        workflowName = description;
      }

      // Confirm replacement if a workflow is already active
      if (currentSession && currentSession.state !== 'done') {
        const confirmed = await ctx.ui.confirm(
          'Active workflow exists',
          'A workflow is in progress. Start a new one alongside it?',
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
      } catch (e) {
        console.error('[workflow] memory init failed:', e);
      }

      // Check git/worktree state first
      const gitStatus = await safeGitStatus(pi);
      const worktreeInfo = await safeGitWorktreeList(pi);

      // Create new session with unique ID
      const id = generateWorkflowId();
      const session: WorkflowSession = {
        id,
        name: workflowName,
        state: 'plan',
        description: description || workflowName || 'Workflow',
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

      const gitEnabled = settings.git?.enabled !== false;
      const requireCleanStart = settings.git?.requireCleanStart !== false;
      const useWorkflowWorktree =
        gitEnabled && settings.git?.useWorkflowWorktree !== false;
      const useWorkflowBranch =
        gitEnabled &&
        (useWorkflowWorktree || settings.git?.useWorkflowBranch !== false);

      if (
        gitEnabled &&
        settings.git?.pushOnComplete !== false &&
        !useWorkflowBranch
      ) {
        ctx.ui.notify(
          '⚠️ Push on complete is enabled, but workflow branch/worktree strategy is disabled. Final push will be skipped safely.',
          'warning',
        );
      }

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
          `ℹ️ Multiple worktrees detected (${worktreeInfo.count}).`,
          'info',
        );
      }

      if (!gitEnabled) {
        ctx.ui.notify(
          'ℹ️ Git automation is disabled. Skipping workflow branch/worktree preparation.',
          'info',
        );
      }

      if (
        !session.startupPrepRequired &&
        !gitStatus.checkFailed &&
        gitEnabled &&
        useWorkflowBranch
      ) {
        const sourceBranch = await safeGitCurrentBranch(pi);
        if (sourceBranch.error) {
          ctx.ui.notify(
            `⚠️ Could not detect current branch for worktree reuse. (${sourceBranch.error})`,
            'warning',
          );
        }

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

        if (
          useWorkflowWorktree &&
          sourceBranch.branch &&
          !sourceBranch.detached &&
          !branchResult.error
        ) {
          const gitRoot = await safeGitRoot(pi);
          if (gitRoot.root) {
            const workspaceResult = await ensureWorkflowWorkspace(
              pi,
              gitRoot.root,
              sourceBranch.branch,
            );
            if (workspaceResult.path) {
              session.gitWorktreePath = workspaceResult.path;
            }
            if (workspaceResult.message) {
              ctx.ui.notify(workspaceResult.message, 'info');
            }
            if (workspaceResult.error) {
              ctx.ui.notify(
                `⚠️ Workflow worktree setup failed. (${workspaceResult.error})`,
                'warning',
              );
            }
          } else {
            ctx.ui.notify(
              `⚠️ Could not resolve git root for worktree setup. (${gitRoot.error || 'unknown error'})`,
              'warning',
            );
          }
        } else if (useWorkflowWorktree && sourceBranch.detached) {
          ctx.ui.notify(
            '⚠️ Current branch is detached HEAD. Skipping workflow worktree setup.',
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
        } catch (e) {
          console.error('[workflow] memory cleanup failed:', e);
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
