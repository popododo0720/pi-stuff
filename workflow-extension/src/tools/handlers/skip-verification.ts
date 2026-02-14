// tools/handlers/skip-verification.ts — skipVerification action handler
// Allows skipping verification when models are unavailable (infra errors).

import { loadMemory } from '../../storage/memory';
import type { HandlerContext, HandlerResult } from './types';

export async function handleSkipVerification(
  hctx: HandlerContext,
): Promise<HandlerResult> {
  const { session, settings } = hctx;

  if (session.state === 'verifyPlan') {
    session.state = 'implement';
    session.retryCount = 0;
    session.verifyPlanResult = 'Verification skipped by user';
    return {
      text: '⚠️ Plan verification skipped. Proceeding to implementation.\nNote: No automated quality gate was applied.',
      stageConfig: settings.stages.implement,
    };
  }

  if (session.state === 'verifyImpl') {
    const mem = loadMemory(hctx.ctx.cwd);
    session.compoundMemorySnapshot = {
      patterns: mem.patterns.length,
      gotchas: mem.gotchas.length,
      decisions: mem.decisions.length,
    };
    session.state = 'compound';
    session.retryCount = 0;
    return {
      text: '⚠️ Implementation verification skipped. Proceeding to compound.\nNote: No automated quality gate was applied.',
      stageConfig: settings.stages.compound,
    };
  }

  return { text: 'Cannot skip verification in current state.' };
}
