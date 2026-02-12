// commands/cancel.ts — /workflow-cancel command
// Cancels the active workflow and clears all UI state.

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from '@mariozechner/pi-coding-agent';
import { updateStatusBar } from '../context/status';
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
      if (!session || session.state === 'done') {
        ctx.ui.notify('No active workflow to cancel.', 'info');
        return;
      }

      const confirmed = await ctx.ui.confirm(
        'Cancel workflow',
        `Cancel "${session.description}" (${session.id})?`,
      );
      if (!confirmed) return;

      cleanupVerificationResults(ctx.cwd);
      setSession(null);
      updateStatusBar(ctx, null);
      ctx.ui.notify('Workflow cancelled.', 'info');
    },
  });
}
