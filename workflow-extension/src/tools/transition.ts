// tools/transition.ts — workflow_transition tool
// Manages state machine: plan → verify → implement → verify → compound → done.

import { StringEnum } from '@mariozechner/pi-ai';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import { STATE_EMOJI, TOOL_NAME, VALID_TRANSITIONS } from '../constants';
import { updateStatusBar } from '../context/status';
import { savePlanDocument } from '../storage/plan';
import { loadSettings } from '../storage/settings';
import { saveSolution } from '../storage/solution';
import type { WorkflowSession } from '../types';
import {
  formatVerificationSummary,
  runParallelVerification,
  saveVerificationResult,
} from '../verification';

// Helper to build a text content response
function textResult(text: string, session?: WorkflowSession) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(session ? { details: session } : {}),
  };
}

/**
 * Register the workflow_transition tool.
 * Handles all state transitions with automatic parallel verification.
 */
export function registerTransitionTool(
  pi: ExtensionAPI,
  getSession: () => WorkflowSession | null,
  setSession: (s: WorkflowSession) => void,
) {
  pi.registerTool({
    name: TOOL_NAME,
    label: 'Workflow Transition',
    description:
      'Transition the current workflow stage. ' +
      'Supports: approvePlan, planVerified, planFailed, ' +
      'implDone, implVerified, implFailed, replan, compoundDone.',
    parameters: Type.Object({
      action: StringEnum([
        'approvePlan',
        'planVerified',
        'planFailed',
        'implDone',
        'implVerified',
        'implFailed',
        'replan',
        'compoundDone',
      ] as const),
      content: Type.Optional(
        Type.String({
          description:
            'Step deliverable (plan content, verification result, compound summary)',
        }),
      ),
      reason: Type.Optional(Type.String({ description: 'Failure reason' })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const session = getSession();
      if (!session) {
        return textResult('No active workflow. Start with /workflow.');
      }

      const settings = loadSettings(ctx.cwd);
      const maxRetries = settings.maxRetries;

      // Validate transition is allowed from current state
      const allowed = VALID_TRANSITIONS[params.action];
      if (!allowed || !allowed.includes(session.state)) {
        return textResult(
          `Invalid transition: cannot ${params.action} in ${session.state} state.`,
        );
      }

      switch (params.action) {
        // ── Plan approved → auto-verify ──────────────────────────
        case 'approvePlan': {
          if (!params.content?.trim()) {
            return textResult('Plan content is empty.');
          }
          session.planContent = params.content;

          const savedPath = savePlanDocument(
            ctx.cwd,
            session.description,
            params.content,
          );

          session.state = 'verifyPlan';
          setSession(session);
          updateStatusBar(ctx, session);

          onUpdate?.({
            content: [
              {
                type: 'text' as const,
                text:
                  `🔍 Verifying plan... (${settings.verifyModels.join(' + ') || 'no models'})` +
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
              signal,
            );

            if (result.passed) {
              session.state = 'implement';
              session.retryCount = 0;
              session.verifyPlanResult = 'Auto-verification passed';
              setSession(session);
              updateStatusBar(ctx, session);
              return textResult(
                '✅ Plan verified! Moving to implementation.' +
                  (savedPath ? `\n📄 Plan saved: ${savedPath}` : '') +
                  `\n\n${formatVerificationSummary(result)}`,
                session,
              );
            }

            session.retryCount++;
            if (session.retryCount >= maxRetries) {
              session.retryCount = 0;
            }
            session.state = 'plan';
            session.verifyPlanResult = formatVerificationSummary(result);
            const resultPath = saveVerificationResult(
              ctx.cwd,
              'plan',
              result,
              session.id,
            );
            setSession(session);
            updateStatusBar(ctx, session);
            return textResult(
              `❌ Plan verification failed (${session.retryCount}/${maxRetries}). Please revise.\n\n` +
                formatVerificationSummary(result) +
                (resultPath ? `\n\n📋 Full results: ${resultPath}` : ''),
              session,
            );
          } catch (e) {
            const isNoModels =
              e instanceof Error &&
              e.message.includes('No verification models');
            setSession(session);
            updateStatusBar(ctx, session);
            return textResult(
              isNoModels
                ? '⚠️ No verification models. Falling back to manual verification. Use /workflow-settings to configure.' +
                    (savedPath ? `\n📄 Plan saved: ${savedPath}` : '')
                : '⚠️ Auto-verification error. Falling back to manual verification.' +
                    (savedPath ? `\n📄 Plan saved: ${savedPath}` : ''),
              session,
            );
          }
        }

        // ── Manual plan verification passed ──────────────────────
        case 'planVerified':
          session.state = 'implement';
          session.retryCount = 0;
          session.verifyPlanResult = params.content || 'Verification passed';
          break;

        // ── Manual plan verification failed ──────────────────────
        case 'planFailed':
          session.retryCount++;
          if (session.retryCount >= maxRetries) {
            session.retryCount = 0;
          }
          session.state = 'plan';
          session.verifyPlanResult = params.reason || 'Verification failed';
          break;

        // ── Implementation done → auto-verify ────────────────────
        case 'implDone': {
          session.state = 'verifyImpl';
          setSession(session);
          updateStatusBar(ctx, session);

          onUpdate?.({
            content: [
              {
                type: 'text' as const,
                text: `✅ Verifying implementation... (${settings.verifyModels.join(' + ') || 'no models'})`,
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
              signal,
            );

            if (result.passed) {
              // Verified → move to compound
              session.state = 'compound';
              session.retryCount = 0;
              setSession(session);
              updateStatusBar(ctx, session);
              return textResult(
                '✅ Implementation verified! Moving to compound stage.\n\n' +
                  'Analyze what you learned and call workflow_transition(action: "compoundDone", content: "<summary>").\n\n' +
                  formatVerificationSummary(result),
                session,
              );
            }

            session.retryCount++;
            if (session.retryCount >= maxRetries) {
              session.retryCount = 0;
              session.state = 'plan';
              session.verifyPlanResult =
                'Implementation verification failed after max retries. Revise the plan.';
              const implResultPath = saveVerificationResult(
                ctx.cwd,
                'impl',
                result,
                session.id,
              );
              setSession(session);
              updateStatusBar(ctx, session);
              return textResult(
                `Max retries reached. Returning to plan stage for revision.\n\n` +
                  formatVerificationSummary(result) +
                  (implResultPath
                    ? `\n\n📋 Full results: ${implResultPath}`
                    : ''),
                session,
              );
            }
            session.state = 'implement';
            const implResultPath = saveVerificationResult(
              ctx.cwd,
              'impl',
              result,
              session.id,
            );
            setSession(session);
            updateStatusBar(ctx, session);
            return textResult(
              `❌ Implementation verification failed (${session.retryCount}/${maxRetries}). Please fix.\n\n` +
                formatVerificationSummary(result) +
                (implResultPath
                  ? `\n\n📋 Full results: ${implResultPath}`
                  : ''),
              session,
            );
          } catch (e) {
            const isNoModels =
              e instanceof Error &&
              e.message.includes('No verification models');
            setSession(session);
            updateStatusBar(ctx, session);
            return textResult(
              isNoModels
                ? '⚠️ No verification models. Falling back to manual verification. Use /workflow-settings to configure.'
                : '⚠️ Auto-verification error. Falling back to manual verification.',
              session,
            );
          }
        }

        // ── Manual impl verification passed → compound ───────────
        case 'implVerified':
          session.state = 'compound';
          session.retryCount = 0;
          setSession(session);
          updateStatusBar(ctx, session);
          return textResult(
            '✅ Implementation verified! Moving to compound stage.\n\n' +
              'Analyze what you learned and call workflow_transition(action: "compoundDone", content: "<summary>").',
            session,
          );

        // ── Manual impl verification failed ──────────────────────
        case 'implFailed':
          session.retryCount++;
          if (session.retryCount >= maxRetries) {
            session.retryCount = 0;
            session.state = 'plan';
            session.verifyPlanResult =
              params.reason ||
              'Implementation verification failed after max retries.';
            setSession(session);
            updateStatusBar(ctx, session);
            return textResult(
              'Max retries reached. Returning to plan stage for revision. ' +
                `Reason: ${params.reason || 'Verification failed'}`,
              session,
            );
          }
          session.state = 'implement';
          break;

        // ── Compound done → save solution → done ─────────────────
        case 'compoundDone': {
          const summary = params.content?.trim() || '';
          let solutionPath: string | null = null;
          if (summary) {
            solutionPath = saveSolution(
              ctx.cwd,
              session.description,
              summary,
              session.id,
            );
          }
          session.state = 'done';
          setSession(session);
          updateStatusBar(ctx, session);
          return textResult(
            '🎉 Workflow Complete!\n\n' +
              `**Task:** ${session.description}\n` +
              `**ID:** ${session.id}\n` +
              `**Retries used:** ${session.retryCount}\n` +
              (solutionPath ? `**Solution saved:** ${solutionPath}\n` : '') +
              '\nLearnings from this workflow have been captured for future reference.',
            session,
          );
        }

        // ── Replan ───────────────────────────────────────────────
        case 'replan':
          session.state = 'plan';
          session.verifyPlanResult = '';
          break;
      }

      // Common exit
      setSession(session);
      updateStatusBar(ctx, session);

      const statusText =
        session.state === 'done'
          ? `${STATE_EMOJI.done} Workflow complete! Task: "${session.description}"`
          : `${STATE_EMOJI[session.state]} Transitioned to: ${session.state} | Task: "${session.description}"`;

      return textResult(statusText, session);
    },
  });
}
