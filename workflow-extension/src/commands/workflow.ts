// commands/workflow.ts — /workflow command
// Starts a new workflow session or replaces an existing one.

import { existsSync } from 'node:fs';
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from '@mariozechner/pi-coding-agent';
import { updateStatusBar } from '../context/status';
import { resolveMemoryPath, saveMemory } from '../storage/memory';
import type { WorkflowSession } from '../types';

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
    description: 'Start automated workflow: plan → verify → implement → verify',
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const description = args.trim();
      const currentSession = getSession();

      // Confirm replacement if a workflow is already active
      if (currentSession && currentSession.state !== 'done') {
        const confirmed = await ctx.ui.confirm(
          'Active workflow exists',
          'A workflow is in progress. Replace with a new one?',
        );
        if (!confirmed) return;
      }

      // Create new session
      const session: WorkflowSession = {
        state: 'plan',
        description: description || 'Workflow',
        planContent: '',
        verifyPlanResult: '',
        retryCount: 0,
      };
      setSession(session);

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
          });
        }
      } catch {
        // Ignore memory initialization errors
      }

      updateStatusBar(ctx, session);

      // Show different message for new vs returning users
      ctx.ui.notify(
        hasMemory
          ? '📝 Entered planning mode. Tell me what to build.'
          : "🚀 Starting project setup. Let's organize conventions first.",
        'info',
      );
    },
  });
}
