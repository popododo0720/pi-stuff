// tools/handlers/impl-done.ts — implDone action handler
// Runs parallel impl verification, transitions based on result.

import { loadMemory, saveMemory } from '../../storage/memory';
import {
  formatVerificationSummary,
  runParallelVerification,
  saveVerificationResult,
  summarizeVerificationOutput,
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
    const todoContext =
      session.activeTodoIndex >= 0 && session.todos.length > 1
        ? {
            currentIndex: session.activeTodoIndex,
            totalCount: session.todos.length,
            completedTitles: session.todos
              .filter(
                (t, i) => t.status === 'done' && i < session.activeTodoIndex,
              )
              .map((t) => t.title),
          }
        : undefined;

    const result = await runParallelVerification(
      'impl',
      session.planContent,
      session.description,
      settings,
      pi,
      ctx.cwd,
      signal,
      params.content,
      todoContext,
    );

    // Infrastructure error → stay in verifyImpl (allow skipVerification)
    if (result.halted) {
      session.state = 'verifyImpl';
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
          'This is NOT a code issue — do NOT modify code to fix this.\n' +
          'Call workflow_transition(action: "skipVerification") to proceed without verification.' +
          (haltResultPath ? `\n\n📋 Full results: ${haltResultPath}` : ''),
      };
    }

    const validResults = result.results.filter((r) => !r.infrastructureError);

    // Passed → compound
    if (result.passed) {
      const mem = loadMemory(ctx.cwd);
      session.compoundMemorySnapshot = {
        patterns: mem.patterns.length,
        gotchas: mem.gotchas.length,
        decisions: mem.decisions.length,
      };
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

    // Auto-save gotcha on first failure for feedback loop
    if (session.retryCount === 1) {
      try {
        const criticals = result.results
          .filter((r) => r.criticalCount > 0)
          .map((r) => summarizeVerificationOutput(r.output))
          .join('; ')
          .slice(0, 200);
        if (criticals) {
          const mem = loadMemory(ctx.cwd);
          mem.gotchas.push(`[auto] Verification failure: ${criticals}`);
          saveMemory(ctx.cwd, mem);
        }
      } catch {
        /* ignore auto-gotcha errors */
      }
    }

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
      const mem = loadMemory(ctx.cwd);
      session.compoundMemorySnapshot = {
        patterns: mem.patterns.length,
        gotchas: mem.gotchas.length,
        decisions: mem.decisions.length,
      };
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
