// context/status.ts — Workflow status display
// Shows workflow progress widget above editor with theme colors.

import type { ExtensionContext } from '@mariozechner/pi-coding-agent';
import { Text } from '@mariozechner/pi-tui';
import { STATE_EMOJI, STATE_LABELS } from '../constants';
import type { WorkflowSession, WorkflowState } from '../types';

/** All workflow stages in order for progress display */
const STAGE_ORDER: WorkflowState[] = [
  'plan',
  'verifyPlan',
  'implement',
  'verifyImpl',
  'compound',
  'done',
];

/**
 * Update the workflow widget above editor.
 * Current stage is accent-colored, others are dim.
 * Clears widget when session is null or done.
 */
export function updateStatusBar(
  ctx: ExtensionContext,
  session: WorkflowSession | null,
): void {
  if (!session || session.state === 'done') {
    ctx.ui.setStatus('workflow', undefined);
    ctx.ui.setWidget('workflow', undefined);
    return;
  }

  // Clear footer status (widget only now)
  ctx.ui.setStatus('workflow', undefined);

  // Widget with theme colors
  ctx.ui.setWidget('workflow', (_tui, theme) => {
    const parts = STAGE_ORDER.map((state) => {
      const emoji = STATE_EMOJI[state];
      const label = STATE_LABELS[state];
      const segment = `${emoji} ${label}`;
      if (state === session.state) {
        return theme.fg('accent', segment);
      }
      return theme.fg('dim', segment);
    });
    const progress = parts.join(theme.fg('dim', ' → '));
    return new Text(progress, 0, 0);
  });
}
