// tools/compact.ts — Deferred compaction state management
// Calling ctx.compact() directly during tool execution causes a race condition.
// Instead, set a flag and execute compaction in before_agent_start.

export const RESET_MARKER = '[WF_RESET]';

/**
 * Manages deferred compaction state.
 * Singleton `compactManager` for production; create independent instances for tests.
 */
export class CompactManager {
  private pending: string | null = null;

  setPending(msg: string): void {
    this.pending = msg;
  }

  getPending(): string | null {
    return this.pending;
  }

  clear(): void {
    this.pending = null;
  }
}

// Singleton for production use
export const compactManager = new CompactManager();
