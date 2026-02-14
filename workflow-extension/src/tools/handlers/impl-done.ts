// tools/handlers/impl-done.ts — implDone action handler
// Runs parallel impl verification, transitions based on result.

import {
  formatVerificationSummary,
  runParallelVerification,
  saveVerificationResult,
} from '../../verification';
import type { HandlerContext, HandlerResult } from './types';

export async function handleImplDone(
  hctx: HandlerContext,
): Promise<HandlerResult> {
  const { session, settings, params, pi, ctx, signal, onUpdate } = hctx;

  // Transition to verifyImpl and flush so status bar shows verification state
  session.state = 'verifyImpl';
  hctx.flush();

  onUpdate?.({
    content: [
      {
        type: 'text' as const,
        text: `🔍 Verifying implementation... (${(settings.stages.verify?.models ?? []).join(' + ') || 'no models'})`,
      },
    ],
  });

  try {
    const result = await runParallelVerification(
      'impl',
      session.planContent,
      session.description,
      settings,
      pi,
      ctx.cwd,
      signal,
      params.content,
    );

    // Infrastructure error → revert to implement
    if (result.halted) {
      session.state = 'implement';
      const haltResultPath = saveVerificationResult(
        ctx.cwd,
        'impl',
        result,
        session.id,
      );
      const haltedModels = result.results
        .filter((r) => r.infrastructureError)
        .map((r) => r.model)
        .join(', ');
      return {
        text:
          '⛔ Verification halted — model infrastructure error (rate limit / quota / timeout).\n\n' +
          `Affected: ${haltedModels}\n\n` +
          formatVerificationSummary(result) +
          '\n\nRetry `implDone` when the model is available again.\n' +
          'This is NOT a code issue — do NOT modify code to fix this.' +
          (haltResultPath ? `\n\n📋 Full results: ${haltResultPath}` : ''),
      };
    }

    const validResults = result.results.filter((r) => !r.infrastructureError);

    // Passed → compound
    if (result.passed) {
      session.state = 'compound';
      session.retryCount = 0;
      const summary = formatVerificationSummary(result);
      const hasWarnings = validResults.some((r) => r.warningCount > 0);
      const reportNote = hasWarnings
        ? '\n\n📋 **Verification Report** (advisory — not blocking):\n'
        : '\n\n';
      return {
        text:
          '✅ Implementation verified! Moving to compound stage.\n' +
          reportNote +
          summary +
          '\n\nAnalyze what you learned and call workflow_transition(action: "compoundDone", content: "<summary>").',
        stageConfig: settings.stages.compound,
      };
    }

    // CRITICAL found → stay in verifyImpl
    session.retryCount++;
    session.state = 'verifyImpl';
    const implResultPath = saveVerificationResult(
      ctx.cwd,
      'impl',
      result,
      session.id,
    );
    return {
      text:
        `❌ Critical issues found (attempt ${session.retryCount}). Fix 🔴 CRITICAL items to proceed.\n\n` +
        formatVerificationSummary(result) +
        (implResultPath ? `\n\n📋 Full results: ${implResultPath}` : ''),
    };
  } catch (e) {
    const isNoModels =
      e instanceof Error && e.message.includes('No verification models');
    if (isNoModels) {
      session.state = 'compound';
      session.retryCount = 0;
      return {
        text: '⚠️ No verification models configured. Skipping verification.',
        stageConfig: settings.stages.compound,
      };
    }
    session.state = 'implement';
    return {
      text: '⚠️ Auto-verification error. Returned to implement stage — retry implDone when ready.',
    };
  }
}
