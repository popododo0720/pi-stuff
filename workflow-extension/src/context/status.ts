// context/status.ts — Workflow status display
// Shows workflow dashboard widget above editor + footer status.

import type { ExtensionContext } from '@mariozechner/pi-coding-agent';
import { STATE_EMOJI, STATE_LABELS } from '../constants';
import { loadSettings } from '../storage/settings';
import type { WorkflowSession, WorkflowState } from '../types';

/** All workflow stages in order for progress display */
const STAGE_ORDER: WorkflowState[] = [
  'plan',
  'verifyPlan',
  'implement',
  'verifyImpl',
  'done',
];

/**
 * Build a progress bar showing current stage in the workflow.
 * Current stage is highlighted with [brackets].
 * e.g. "[📝 Plan] → 🔍 Verify → 🔨 Implement → ✅ Verify → 🎉 Done"
 */
function buildProgressBar(currentState: WorkflowState): string {
  return STAGE_ORDER.map((state) => {
    const emoji = STATE_EMOJI[state];
    const label = STATE_LABELS[state];
    if (state === currentState) {
      return `[${emoji} ${label}]`;
    }
    return `${emoji} ${label}`;
  }).join(' → ');
}

/**
 * Update the workflow widget above editor and footer status.
 * Clears both when session is null or done.
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

  const emoji = STATE_EMOJI[session.state];
  const label = STATE_LABELS[session.state];
  const desc =
    session.description.length > 30
      ? `${session.description.slice(0, 30)}...`
      : session.description;

  // Footer status (compact)
  ctx.ui.setStatus('workflow', `${emoji} ${label} | ${desc}`);

  // Load maxRetries from settings
  const { maxRetries } = loadSettings(ctx.cwd);

  // Widget above editor (dashboard)
  const progress = buildProgressBar(session.state);
  ctx.ui.setWidget('workflow', [
    `Workflow: ${session.id} | ${desc}`,
    progress,
    `Retries: ${session.retryCount}/${maxRetries}`,
  ]);
}
