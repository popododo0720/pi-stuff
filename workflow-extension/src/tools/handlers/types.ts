// tools/handlers/types.ts — Shared types for action handlers
// Each handler receives HandlerContext and returns HandlerResult.
// The executor (transition.ts) guarantees setSession + updateStatusBar
// after every handler call — handlers never need to call them directly.

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import type {
  StageConfig,
  WorkflowSession,
  WorkflowSettings,
} from '../../types';

/** Tool result shape for onUpdate streaming callback. */
export interface ToolUpdate {
  content: Array<{ type: 'text'; text: string }>;
}

/** Context passed to every action handler. */
export interface HandlerContext {
  /** Mutable session — handlers mutate directly, executor persists after. */
  session: WorkflowSession;
  settings: WorkflowSettings;
  params: { action: string; content?: string; reason?: string };
  pi: ExtensionAPI;
  ctx: {
    cwd: string;
    modelRegistry?: {
      getAvailable(): Array<{ provider: string; id: string }>;
    };
  };
  signal?: AbortSignal;
  onUpdate?: (result: ToolUpdate) => void;
  /**
   * Flush session + status bar mid-handler (e.g. before long verification).
   * Use sparingly — the executor always flushes after handler returns.
   */
  flush: () => void;
}

/** Result returned by every action handler. */
export interface HandlerResult {
  /** Response message text shown to the user. */
  text: string;
  /** Stage config to apply after flush (model/thinking switch). */
  stageConfig?: StageConfig;
  /** Deferred compaction message (executed in next before_agent_start). */
  compact?: string;
}

/** Action handler function signature. */
export type ActionHandler = (hctx: HandlerContext) => Promise<HandlerResult>;
