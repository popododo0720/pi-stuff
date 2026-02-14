// tools/compact.ts — Deferred compaction state management
// Tool execution 중 ctx.compact() 직접 호출 시 race condition 발생.
// 대신 플래그만 세팅하고, before_agent_start에서 실행.

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
