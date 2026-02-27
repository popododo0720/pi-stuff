// tools/handlers/impl-done.ts — implDone action handler
// Runs parallel impl verification, transitions based on result.

import {
  MAX_IMPLEMENTATION_NOTES_CHARS,
  SELF_AUDIT_TEMPLATE,
} from '../../constants';
import { loadWorkflowMemory, saveWorkflowMemory } from '../../storage/memory';
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

  // ── Gate 1: content required ──
  if (!params.content?.trim()) {
    return {
      text:
        '❌ implDone requires content parameter.\n' +
        'Include implementation notes: decisions made, trade-offs, context for verifiers.\n' +
        'Example: workflow_transition(action: "implDone", content: "<your notes>")',
    };
  }

  // ── Gate 2: self-audit structure check ──
  const contentText = params.content.trim();
  // Extract self-audit section (from header to next ## or --- or end)
  const lines = contentText.split(/\r?\n/);
  const headerLine = lines.findIndex((l) => /^## Self-Audit/i.test(l));
  let auditSection = '';
  if (headerLine >= 0) {
    let endLine = lines.length;
    for (let i = headerLine + 1; i < lines.length; i++) {
      if (/^## /i.test(lines[i]) || /^---/.test(lines[i])) {
        endLine = i;
        break;
      }
    }
    auditSection = lines.slice(headerLine + 1, endLine).join('\n');
  }
  const hasCheckedItem = /^- \[x\]/im.test(auditSection);
  if (headerLine < 0 || !hasCheckedItem) {
    return {
      text:
        '❌ implDone requires a Self-Audit section with at least one checked item.\n\n' +
        'Include this structure in your content parameter:\n```\n' +
        SELF_AUDIT_TEMPLATE +
        '\n```\n\n' +
        'This is a mandatory structural guard. Complete the audit before submitting.',
    };
  }

  // ── Gate 3: retry escalation ──
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

  // ── Gate 4: pre-flight (lint/tsc/test) ──
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

  // Save implementation notes before verification (preserved even on failure)
  const currentTodo = session.todos[session.activeTodoIndex];
  if (currentTodo && contentText) {
    currentTodo.implementationNotes = contentText.slice(
      0,
      MAX_IMPLEMENTATION_NOTES_CHARS,
    );
  }

  // Transition to verifyImpl and flush so status bar shows verification state
  session.state = 'verifyImpl';
  hctx.flush();

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
      (event) => {
        onUpdate?.({
          content: [{ type: 'text' as const, text: JSON.stringify(event) }],
        });
      },
      session.id, // workflowId for learnings injection
    );

    // Save verification result to current TODO
    if (
      session.activeTodoIndex >= 0 &&
      session.todos[session.activeTodoIndex]
    ) {
      session.todos[session.activeTodoIndex].verifyResult =
        formatVerificationSummary(result);
    }

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
        .map((r) => {
          const label = r.domain ? `${r.model}/${r.domain}` : r.model;
          const kind = r.verificationErrorType ?? 'infrastructure';
          return `${label} (${kind})`;
        })
        .join(', ');
      return {
        text:
          '⛔ Verification halted — infrastructure/format error (rate limit / quota / timeout / unstructured output).\n\n' +
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
      const wfMem = loadWorkflowMemory(ctx.cwd, session.id);
      session.compoundMemorySnapshot = {
        patterns: wfMem.patterns.length,
        gotchas: wfMem.gotchas.length,
        decisions: wfMem.decisions.length,
      };
      session.state = 'compound';
      session.retryCount = 0;
      session.compoundStep = 0;
      const summary = formatVerificationSummary(result);
      const hasWarnings = validResults.some((r) => r.warningCount > 0);
      const skippedDomains = result.results.filter(
        (r) => r.infrastructureError && r.retryAttempt,
      );
      const skippedNote =
        skippedDomains.length > 0
          ? `\n\n⚠️ **${skippedDomains.length} domain(s) skipped** (persistent infra/format error after retry). Results based on ${validResults.length} successful verifiers.`
          : '';
      const reportNote = hasWarnings
        ? '\n\n📋 **Verification Report** (advisory — not blocking):\n'
        : '\n\n';
      return {
        text:
          '✅ Implementation verified! Moving to compound stage.\n' +
          skippedNote +
          reportNote +
          summary +
          '\n\nAnalyze what you learned and call workflow_transition(action: "compoundDone", content: "<summary>").',
        stageConfig: settings.stages.compound,
      };
    }

    // CRITICAL found → return to implement so AI can fix code
    // (verifyImpl blocks write/edit tools; implement allows them)
    // Only count code CRITICAL failures toward retry budget (not infra/format/non-critical)
    const hasCodeFailure = validResults.some(
      (r) => !r.passed && !r.verificationErrorType && r.criticalCount > 0,
    );
    if (hasCodeFailure) {
      session.retryCount++;
    }
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
          const wfMem = loadWorkflowMemory(ctx.cwd, session.id);
          wfMem.gotchas.push(`[auto] Verification failure: ${criticals}`);
          saveWorkflowMemory(ctx.cwd, session.id, wfMem);
        }
      } catch (e) {
        console.warn('[impl-done] auto-gotcha save failed:', e);
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
        `❌ Critical issues found (code verification failure ${session.retryCount}/${maxRetries}).\n\n` +
        formatVerificationSummary(result) +
        actionGuide +
        (implResultPath ? `\n\n📋 Full results: ${implResultPath}` : ''),
    };
  } catch (e) {
    const isNoModels =
      e instanceof Error && e.message.includes('No verification models');
    if (isNoModels) {
      const wfMem = loadWorkflowMemory(ctx.cwd, session.id);
      session.compoundMemorySnapshot = {
        patterns: wfMem.patterns.length,
        gotchas: wfMem.gotchas.length,
        decisions: wfMem.decisions.length,
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
