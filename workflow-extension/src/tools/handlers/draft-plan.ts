// tools/handlers/draft-plan.ts — Save plan draft for preview/editing
// Sets session.planContent without state change, triggering plan panel auto-open.

import type { HandlerContext, HandlerResult } from './types';

export async function handleDraftPlan(
  hctx: HandlerContext,
): Promise<HandlerResult> {
  const { session, params } = hctx;

  if (!params.content?.trim()) {
    return { text: 'Draft content is empty.' };
  }

  session.planContent = params.content;

  return {
    text:
      '📝 Plan draft saved. The plan panel is now open for preview and editing.\n' +
      'When the user approves, call workflow_transition(action: "approvePlan") to submit.',
  };
}
