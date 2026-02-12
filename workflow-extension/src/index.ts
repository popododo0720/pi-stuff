// index.ts — Extension entry point
// Wires all commands, tools, events, and session state management.

import type {
  ExtensionAPI,
  ExtensionContext,
} from '@mariozechner/pi-coding-agent';
import { registerSettingsCommand } from './commands/settings';
import { registerWorkflowCommand } from './commands/workflow';
import {
  MAX_MEMORY_ENTRIES,
  MAX_MEMORY_VALUE_LENGTH,
  TOOL_NAME,
} from './constants';
import { buildSystemPromptInjection } from './context/prompt';
import { updateStatusBar } from './context/status';
import { loadMemory, saveMemory } from './storage/memory';
import { registerModuleConventionsTool } from './tools/module-conventions';
import { registerProjectMemoryTool } from './tools/project-memory';
import { registerTransitionTool } from './tools/transition';
import type { WorkflowSession } from './types';

export default function (pi: ExtensionAPI) {
  // ── Session state (owned here, accessed via closures) ──────────
  let session: WorkflowSession | null = null;
  const getSession = () => session;
  const setSession = (s: WorkflowSession) => {
    session = s;
  };

  // ── Register commands ──────────────────────────────────────────
  registerWorkflowCommand(pi, getSession, setSession);
  registerSettingsCommand(pi);

  // ── Register tools ─────────────────────────────────────────────
  registerTransitionTool(pi, getSession, setSession);
  registerProjectMemoryTool(pi);
  registerModuleConventionsTool(pi);

  // ── Session reconstruction from history ────────────────────────
  // When switching/forking sessions, reconstruct workflow state
  // from the last tool result in the session branch.
  const reconstruct = (ctx: ExtensionContext) => {
    session = null;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== 'message') continue;
      const msg = entry.message;
      if (msg.role !== 'toolResult' || msg.toolName !== TOOL_NAME) continue;
      if (msg.details) session = msg.details as WorkflowSession;
    }
    updateStatusBar(ctx, session);
  };

  // Listen for all session lifecycle events
  for (const event of [
    'session_start',
    'session_switch',
    'session_fork',
    'session_tree',
  ] as const) {
    pi.on(event, async (_e, ctx) => reconstruct(ctx));
  }

  // ── System prompt injection ────────────────────────────────────
  // Inject workflow context + project memory before each agent turn.
  pi.on('before_agent_start', async (event, ctx) => {
    const result = buildSystemPromptInjection(session, ctx, event.systemPrompt);
    if (result) {
      return { systemPrompt: result };
    }
    return undefined;
  });

  // ── Auto-save current work tracking ────────────────────────────
  // Track active workflow in project memory; clean up on completion.
  pi.on('agent_end', async (_e, ctx) => {
    if (!session) return;

    const memory = loadMemory(ctx.cwd);

    // Track new workflow as current work
    if (session.state === 'plan' && !session.planContent) {
      const alreadyTracked = memory.currentWork.some(
        (w) => w.what === session?.description,
      );
      if (!alreadyTracked && memory.currentWork.length < MAX_MEMORY_ENTRIES) {
        memory.currentWork.push({
          what: session.description.slice(0, MAX_MEMORY_VALUE_LENGTH),
          why: 'Workflow in progress',
          startedAt: new Date().toISOString().slice(0, 10),
        });
        saveMemory(ctx.cwd, memory);
      }
    }

    // Clean up completed workflow from current work
    if (session.state === 'done') {
      memory.currentWork = memory.currentWork.filter(
        (w) => w.what !== session?.description,
      );
      saveMemory(ctx.cwd, memory);
      updateStatusBar(ctx, null);
    }
  });
}
