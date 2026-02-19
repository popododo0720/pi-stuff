// tools/handlers/impl-done.ts — implDone action handler
// Runs parallel impl verification, transitions based on result.

import { loadMemory, saveMemory } from '../../storage/memory';
import {
  formatVerificationSummary,
  runParallelVerification,
  saveVerificationResult,
  summarizeVerificationOutput,
} from '../../verification';
import {
  detectPreflightCommands,
  formatPreflightFailure,
  runPreflight,
} from '../preflight';
import type { HandlerContext, HandlerResult } from './types';

export async function handleImplDone(
  hctx: HandlerContext,
): Promise<HandlerResult> {
  const { session, settings, params, pi, ctx, signal, onUpdate } = hctx;

  // ── Gate 1: content 필수 ──
  if (!params.content?.trim()) {
    return {
      text:
        '❌ implDone requires content parameter.\n' +
        'Include implementation notes: decisions made, trade-offs, context for verifiers.\n' +
        'Example: workflow_transition(action: "implDone", content: "<your notes>")',
    };
  }

  // ── Gate 2: retry 에스컬레이션 ──
  const maxRetries = settings.maxRetries ?? 5;
  if (session.retryCount >= maxRetries) {
    // Reset retryCount so the user can retry after reviewing
    session.retryCount = 0;
    hctx.flush();
    return {
      text:
        `⚠️ Verification has failed ${maxRetries} times (limit: ${maxRetries}).\n` +
        'retryCount has been reset — you can retry after addressing the issues.\n' +
        'Report the issue to the user and wait for guidance.\n' +
        'User can adjust maxRetries via /settings or help resolve the issue.',
    };
  }

  // ── Gate 3: pre-flight (lint/tsc/test) ──
  const preflightConfig = settings.preflight;
  if (preflightConfig?.enabled !== false) {
    const commands = preflightConfig?.commands?.length
      ? preflightConfig.commands
      : detectPreflightCommands(ctx.cwd);
    if (commands.length > 0) {
      onUpdate?.({
        content: [
          {
            type: 'text' as const,
            text: `🔍 Pre-flight: ${commands.join(', ')}`,
          },
        ],
      });
      const pfResult = await runPreflight(
        pi,
        commands,
        preflightConfig?.timeout ?? 60,
      );
      if (!pfResult.passed) {
        return { text: formatPreflightFailure(pfResult) };
      }
    }
  }

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
      session.compoundStep = 0;
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

    // CRITICAL found → return to implement so AI can fix code
    // (verifyImpl blocks write/edit tools; implement allows them)
    session.retryCount++;
    session.state = 'implement';

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
    const actionGuide =
      '\n\nAnalyze each CRITICAL finding and decide:\n' +
      '- **Code bug** → fix the code, then `implDone` again\n' +
      '- **Plan ambiguity / false positive** → `replan` to revise the plan wording, then resubmit\n' +
      '- **Unclear** → report to user and ask for guidance' +
      (session.retryCount >= 2
        ? '\n\n🚨 Attempt ' +
          session.retryCount +
          ' — if the same CRITICAL keeps recurring, the plan wording is likely the issue, not the code.'
        : '');

    return {
      text:
        `❌ Critical issues found (attempt ${session.retryCount}).\n\n` +
        formatVerificationSummary(result) +
        actionGuide +
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
      session.compoundStep = 0;
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
