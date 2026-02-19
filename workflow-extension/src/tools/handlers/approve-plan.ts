// tools/handlers/approve-plan.ts — approvePlan action handler
// Saves plan, runs parallel verification, transitions based on result.

import { savePlanDocument } from '../../storage/plan';
import {
  formatVerificationSummary,
  runParallelVerification,
  saveVerificationResult,
} from '../../verification';
import type { HandlerContext, HandlerResult } from './types';

export async function handleApprovePlan(
  hctx: HandlerContext,
): Promise<HandlerResult> {
  const { session, settings, params, pi, ctx, signal, onUpdate } = hctx;

  if (!params.content?.trim()) {
    return { text: 'Plan content is empty.' };
  }

  session.planContent = params.content;
  const savedPath = savePlanDocument(
    ctx.cwd,
    session.description,
    params.content,
  );

  // Transition to verifyPlan and flush so status bar shows verification state
  session.state = 'verifyPlan';
  hctx.flush();

  onUpdate?.({
    content: [
      {
        type: 'text' as const,
        text:
          `🔍 Verifying plan... (${(settings.stages.verify?.models ?? []).join(' + ') || 'no models'})` +
          (savedPath ? `\n📄 Plan saved: ${savedPath}` : ''),
      },
    ],
  });

  try {
    const result = await runParallelVerification(
      'plan',
      session.planContent,
      session.description,
      settings,
      pi,
      ctx.cwd,
      signal,
    );

    // Infrastructure error → stay in verifyPlan (allow skipVerification)
    if (result.halted) {
      session.state = 'verifyPlan';
      const haltResultPath = saveVerificationResult(
        ctx.cwd,
        'plan',
        result,
        session.id,
      );
      const haltedModels = result.results
        .filter((r) => r.infrastructureError)
        .map((r) => r.model)
        .join(', ');
      return {
        text:
          '⛔ Plan verification halted — model infrastructure error.\n\n' +
          `Affected: ${haltedModels}\n\n` +
          formatVerificationSummary(result) +
          '\n\nRetry `approvePlan` when the model is available again.' +
          '\nCall workflow_transition(action: "skipVerification") to proceed without verification.' +
          (savedPath ? `\n📄 Plan saved: ${savedPath}` : '') +
          (haltResultPath ? `\n📋 Full results: ${haltResultPath}` : ''),
      };
    }

    // Passed → implement
    if (result.passed) {
      session.state = 'implement';
      session.retryCount = 0;
      const summary = formatVerificationSummary(result);
      const hasWarnings = summary.includes('🟡');
      const hasInfo = summary.includes('🔵');
      session.verifyPlanResult =
        hasWarnings || hasInfo
          ? `Plan passed with notes:\n${summary}`
          : 'Auto-verification passed';
      return {
        text:
          '✅ Plan verified! Moving to implementation.' +
          (savedPath ? `\n📄 Plan saved: ${savedPath}` : '') +
          (hasWarnings
            ? '\n\n⚠️ **Address these warnings during implementation:**'
            : '') +
          `\n\n${summary}`,
        stageConfig: settings.stages.implement,
      };
    }

    // Failed → return to plan so AI can revise the plan text
    session.retryCount++;
    session.state = 'plan';
    session.verifyPlanResult = formatVerificationSummary(result);
    const resultPath = saveVerificationResult(
      ctx.cwd,
      'plan',
      result,
      session.id,
    );

    const replanHint =
      session.retryCount >= 2
        ? '\n\n⚠️ Same issues recurring — revise the specific plan wording that verifiers flagged. ' +
          'Do NOT resubmit the same plan text.'
        : '';

    return {
      text:
        `❌ Plan verification failed (attempt ${session.retryCount}). Revise the plan and resubmit with approvePlan.\n\n` +
        formatVerificationSummary(result) +
        replanHint +
        (resultPath ? `\n\n📋 Full results: ${resultPath}` : ''),
      stageConfig: settings.stages.plan,
    };
  } catch (e) {
    const isNoModels =
      e instanceof Error && e.message.includes('No verification models');
    if (isNoModels) {
      session.state = 'implement';
      session.retryCount = 0;
      session.verifyPlanResult =
        'Auto-verification unavailable — no models configured';
      return {
        text:
          '⚠️ No verification models configured. Skipping verification.' +
          (savedPath ? `\n📄 Plan saved: ${savedPath}` : ''),
        stageConfig: settings.stages.implement,
      };
    }
    session.state = 'plan';
    return {
      text:
        '⚠️ Auto-verification error. Returned to plan stage — retry approvePlan when ready.' +
        (savedPath ? `\n📄 Plan saved: ${savedPath}` : ''),
      stageConfig: settings.stages.plan,
    };
  }
}
