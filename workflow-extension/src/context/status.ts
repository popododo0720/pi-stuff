// context/status.ts — Footer status bar management
// Shows current workflow stage in pi's bottom bar.

import type { ExtensionContext } from '@mariozechner/pi-coding-agent';
import { STATE_EMOJI, STATE_LABELS } from '../constants';
import type { WorkflowSession } from '../types';

/**
 * Update the footer status bar with current workflow state.
 * Clears the status when session is null or done.
 */
export function updateStatusBar(
  ctx: ExtensionContext,
  session: WorkflowSession | null,
): void {
  if (!session || session.state === 'done') {
    ctx.ui.setStatus('workflow', undefined);
    return;
  }
  const emoji = STATE_EMOJI[session.state];
  const label = STATE_LABELS[session.state];
  const desc =
    session.description.length > 30
      ? `${session.description.slice(0, 30)}...`
      : session.description;
  ctx.ui.setStatus('workflow', `${emoji} ${label} | ${desc}`);
}
