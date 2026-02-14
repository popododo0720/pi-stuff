// tools/handlers/replan.ts — replan action handler
// Resets state to plan for re-planning.

import type { HandlerContext, HandlerResult } from './types';

export async function handleReplan(
  hctx: HandlerContext,
): Promise<HandlerResult> {
  const { session, settings } = hctx;

  session.state = 'plan';
  session.verifyPlanResult = '';

  return {
    text: `📝 Returned to planning stage. Revise the plan and resubmit.`,
    stageConfig: settings.stages.plan,
  };
}
