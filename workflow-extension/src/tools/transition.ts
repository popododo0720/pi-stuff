// tools/transition.ts — workflow_transition tool (executor)
// Thin executor: validates → delegates to handler → guarantees post-processing.
// All action logic lives in tools/handlers/*.ts.

import { StringEnum } from '@mariozechner/pi-ai';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import { TOOL_NAME, VALID_TRANSITIONS } from '../constants';
import { updateStatusBar } from '../context/status';
import { loadSettings } from '../storage/settings';
import type { StageConfig, WorkflowSession } from '../types';
import { compactManager } from './compact';
import type { HandlerContext, HandlerResult } from './handlers';
import { handlers } from './handlers';

/** Apply stage-specific model and thinking level. */
export async function applyStageConfig(
  pi: ExtensionAPI,
  ctx: {
    modelRegistry?: { getAvailable(): Array<{ provider: string; id: string }> };
  },
  config?: StageConfig,
): Promise<void> {
  if (!config) return;
  if (config.model) {
    const [provider, ...idParts] = config.model.split('/');
    const modelId = idParts.join('/');
    const available = ctx.modelRegistry?.getAvailable() ?? [];
    const found = available.find(
      (m) => m.provider === provider && m.id === modelId,
    );
    if (found) {
      await pi.setModel(found);
    }
  }
  if (config.thinking) {
    pi.setThinkingLevel(config.thinking);
  }
}

/** Build a text content response for tool return. */
function textResult(text: string, session?: WorkflowSession) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(session ? { details: session } : {}),
  };
}

/** Register the workflow_transition tool. */
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
      'Supports: approvePlan, implDone, replan, compoundDone, setTodos.',
    parameters: Type.Object({
      action: StringEnum([
        'approvePlan',
        'implDone',
        'replan',
        'compoundDone',
        'setTodos',
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
      // ── Pre-validation ───────────────────────────────────────
      const session = getSession();
      if (!session) {
        return textResult('No active workflow. Start with /workflow.');
      }

      const settings = loadSettings(ctx.cwd);

      const allowed = VALID_TRANSITIONS[params.action];
      if (!allowed || !allowed.includes(session.state)) {
        return textResult(
          `Invalid transition: cannot ${params.action} in ${session.state} state.`,
        );
      }

      const handler = handlers[params.action];
      if (!handler) {
        return textResult(`Unknown action: ${params.action}`);
      }

      // ── Build handler context ────────────────────────────────
      const hctx: HandlerContext = {
        session,
        settings,
        params,
        pi,
        ctx,
        signal,
        onUpdate,
        flush: () => {
          setSession(session);
          updateStatusBar(ctx, session);
        },
      };

      // ── Execute handler ──────────────────────────────────────
      const originalState = session.state;
      let result: HandlerResult;
      try {
        result = await handler(hctx);
      } catch (e) {
        session.state = originalState;
        setSession(session);
        updateStatusBar(ctx, session);
        return textResult(
          `❌ Internal error during ${params.action}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      // ── Guaranteed post-processing (single point, never skipped) ──
      setSession(session);
      updateStatusBar(ctx, session);

      if (result.stageConfig) {
        await applyStageConfig(pi, ctx, result.stageConfig);
      }
      if (result.compact) {
        compactManager.setPending(result.compact);
      }

      return textResult(result.text, session);
    },
  });
}
