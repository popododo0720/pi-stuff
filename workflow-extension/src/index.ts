// index.ts — Extension entry point
// Wires all commands, tools, events, and session state management.

import type {
  ExtensionAPI,
  ExtensionContext,
} from '@mariozechner/pi-coding-agent';
import { registerCancelCommand } from './commands/cancel';
import { registerSettingsCommand } from './commands/settings';
import { registerWorkflowCommand } from './commands/workflow';
import { MAX_MEMORY_ENTRIES, MAX_MEMORY_VALUE_LENGTH } from './constants';
import { shouldBlockToolCall } from './context/guard';
import { buildSystemPromptInjection } from './context/prompt';
import { updateStatusBar } from './context/status';
import { loadMemory, saveMemory } from './storage/memory';
import { loadSessionFromDisk, saveSessionToDisk } from './storage/session';
import { loadSettings } from './storage/settings';
import { registerModuleConventionsTool } from './tools/module-conventions';
import { registerProjectMemoryTool } from './tools/project-memory';
import { applyStageConfig, registerTransitionTool } from './tools/transition';
import type { StageConfig, WorkflowSession, WorkflowSettings } from './types';
import { cleanupVerificationResults } from './verification';

function getStageConfig(
  session: WorkflowSession,
  settings: WorkflowSettings,
): StageConfig | undefined {
  switch (session.state) {
    case 'plan':
      return settings.stages.plan;
    case 'verifyPlan':
    case 'verifyImpl':
      return undefined;
    case 'implement':
      return settings.stages.implement;
    case 'compound':
      return settings.stages.compound;
    default:
      return undefined;
  }
}

export default function (pi: ExtensionAPI) {
  // ── Session state (owned here, accessed via closures) ──────────
  let session: WorkflowSession | null = null;
  let currentCwd = '';
  const getSession = () => session;
  const setSession = (s: WorkflowSession | null) => {
    session = s;
    if (currentCwd) saveSessionToDisk(currentCwd, s);
  };

  // ── Register commands ──────────────────────────────────────────
  registerWorkflowCommand(pi, getSession, setSession);
  registerSettingsCommand(pi);
  registerCancelCommand(pi, getSession, setSession);

  // ── Register tools ─────────────────────────────────────────────
  registerTransitionTool(pi, getSession, setSession);
  registerProjectMemoryTool(pi);
  registerModuleConventionsTool(pi);

  // ── Session reconstruction from disk ─────────────────────────
  const reconstruct = async (ctx: ExtensionContext) => {
    currentCwd = ctx.cwd;
    session = loadSessionFromDisk(ctx.cwd);
    updateStatusBar(ctx, session);

    if (!session) return;
    const settings = loadSettings(ctx.cwd);
    await applyStageConfig(pi, ctx, getStageConfig(session, settings));
  };

  for (const event of [
    'session_start',
    'session_switch',
    'session_fork',
    'session_tree',
  ] as const) {
    pi.on(event, async (_e, ctx) => await reconstruct(ctx));
  }

  // ── Tool call guard ─────────────────────────────────────────────
  pi.on('tool_call', async (event) => {
    if (!session || session.state === 'done') return undefined;
    const result = shouldBlockToolCall(
      session.state,
      event.toolName,
      event.input as Record<string, unknown>,
    );
    if (result.block) {
      return { block: true, reason: result.reason };
    }
    return undefined;
  });

  // ── System prompt injection ────────────────────────────────────
  pi.on('before_agent_start', async (event, ctx) => {
    currentCwd = ctx.cwd;

    // Auto-recover: any done workflow resumes as plan on next user message
    if (session && session.state === 'done') {
      session.state = 'plan';
      session.retryCount = 0;
      session.verifyPlanResult = '';
      cleanupVerificationResults(ctx.cwd);
      saveSessionToDisk(ctx.cwd, session);
      updateStatusBar(ctx, session);
    }

    if (session) {
      const settings = loadSettings(ctx.cwd);
      await applyStageConfig(pi, ctx, getStageConfig(session, settings));
    }

    const result = buildSystemPromptInjection(session, ctx, event.systemPrompt);
    if (result) {
      return { systemPrompt: result };
    }
    return undefined;
  });

  // ── Auto-save current work tracking ────────────────────────────
  pi.on('agent_end', async (_e, ctx) => {
    if (!session) return;

    const memory = loadMemory(ctx.cwd);

    // Track new workflow as current work
    if (session.state === 'plan' && !session.planContent) {
      const alreadyTracked = memory.currentWork.some(
        (w) => w.what === `[${session?.id}] ${session?.description}`,
      );
      if (!alreadyTracked && memory.currentWork.length < MAX_MEMORY_ENTRIES) {
        memory.currentWork.push({
          what: `[${session.id}] ${session.description}`.slice(
            0,
            MAX_MEMORY_VALUE_LENGTH,
          ),
          why: 'Workflow in progress',
          startedAt: new Date().toISOString().slice(0, 10),
        });
        saveMemory(ctx.cwd, memory);
      }
    }

    // Done workflows persist — cleanup only via /workflow-cancel or /workflow replacement
  });
}
