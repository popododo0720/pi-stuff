// commands/cancel.ts — /workflow-cancel command
// Cancels the active workflow and clears all UI state.

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from '@mariozechner/pi-coding-agent';
import { updateStatusBar } from '../context/status';
import { loadMemory, saveMemory } from '../storage/memory';
import type { WorkflowSession } from '../types';
import { cleanupVerificationResults } from '../verification';

/**
 * Register the /workflow-cancel command.
 * Immediately cancels the active workflow.
 */
export function registerCancelCommand(
  pi: ExtensionAPI,
  getSession: () => WorkflowSession | null,
  setSession: (s: WorkflowSession | null) => void,
) {
  pi.registerCommand('workflow-cancel', {
    description: 'Cancel the active workflow',
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const session = getSession();
      if (!session) {
        ctx.ui.notify('No active workflow to cancel.', 'info');
        return;
      }

      const confirmed = await ctx.ui.confirm(
        'Cancel workflow',
        `Cancel "${session.description}" (${session.id})?`,
      );
      if (!confirmed) return;

      // Clean up verification files
      cleanupVerificationResults(ctx.cwd);

      // Remove currentWork entry for this workflow
      try {
        const memory = loadMemory(ctx.cwd);
        memory.currentWork = memory.currentWork.filter(
          (w) => !w.what.startsWith(`[${session?.id}]`),
        );
        saveMemory(ctx.cwd, memory);
      } catch {
        // Ignore memory cleanup errors
      }

      // Write cancel marker to session history so reconstruction skips this workflow
      pi.appendEntry({
        type: 'message',
        message: {
          role: 'toolResult',
          toolName: 'workflow_transition',
          toolCallId: `cancel-${Date.now()}`,
          content: [{ type: 'text', text: 'Workflow cancelled.' }],
          details: { cancelled: true },
        },
      });

      setSession(null);
      updateStatusBar(ctx, null);
      ctx.ui.notify('Workflow cancelled.', 'info');
    },
  });
}
