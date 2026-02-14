// session-manager.ts — Encapsulated workflow session state
// Replaces the global `let session` / `let currentCwd` closure pattern in index.ts.

import { saveSessionToDisk } from './storage/session';
import type { WorkflowSession } from './types';

/**
 * Manages workflow session lifecycle and persistence.
 * Production: single instance in index.ts.
 * Tests: create independent instances for isolation.
 */
export class SessionManager {
  private session: WorkflowSession | null = null;
  private cwd = '';

  /** Get current session (in-memory). */
  get(): WorkflowSession | null {
    return this.session;
  }

  /** Set session and persist to disk. */
  set(s: WorkflowSession | null): void {
    this.session = s;
    if (this.cwd) saveSessionToDisk(this.cwd, s);
  }

  /** Restore session from disk without re-persisting (avoids redundant writes). */
  restore(s: WorkflowSession | null): void {
    this.session = s;
  }

  getCwd(): string {
    return this.cwd;
  }

  setCwd(cwd: string): void {
    this.cwd = cwd;
  }
}
