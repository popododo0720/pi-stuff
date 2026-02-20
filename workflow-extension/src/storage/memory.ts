// storage/memory.ts — ProjectMemory + WorkflowMemory CRUD operations
// Global memory: .pi/workflow-memory.json (conventions, rules, notes, etc.)
// Per-workflow memory: .pi/workflows/{id}-memory.json (patterns, gotchas, decisions)

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MEMORY_DIR, MEMORY_FILE } from '../constants';
import type { PatternEntry, ProjectMemory, WorkflowMemory } from '../types';
import { atomicWriteFileSync } from './atomic-write';

// ── Pattern parsing helper ─────────────────────────────────────

/**
 * Parse raw pattern entries from JSON into typed PatternEntry[].
 * Handles both legacy string format and structured {text, count, ...} format.
 */
export function parsePatterns(raw: unknown[]): PatternEntry[] {
  return raw
    .map((p: unknown) => {
      if (typeof p === 'string') return { text: p, count: 1 };
      if (
        typeof p === 'object' &&
        p !== null &&
        'text' in p &&
        'count' in p &&
        typeof (p as Record<string, unknown>).text === 'string' &&
        typeof (p as Record<string, unknown>).count === 'number'
      ) {
        const entry = p as Record<string, unknown>;
        return {
          text: entry.text as string,
          count: entry.count as number,
          ...(typeof entry.wrong === 'string' ? { wrong: entry.wrong } : {}),
          ...(typeof entry.correct === 'string'
            ? { correct: entry.correct }
            : {}),
          ...(typeof entry.why === 'string' ? { why: entry.why } : {}),
        };
      }
      return null;
    })
    .filter((p): p is PatternEntry => p !== null);
}

// ── Global memory ──────────────────────────────────────────────

/**
 * Resolve the absolute path to the global memory file.
 * Throws if the resolved path escapes the project root.
 */
export function resolveMemoryPath(cwd: string): string {
  const resolved = resolve(join(cwd, MEMORY_DIR, MEMORY_FILE));
  const root = resolve(cwd);
  if (!resolved.startsWith(`${root}/`) && resolved !== root) {
    throw new Error('Memory path escapes project root');
  }
  return resolved;
}

/**
 * Load project memory from disk.
 * Returns empty defaults if file doesn't exist or is invalid.
 */
export function loadMemory(cwd: string): ProjectMemory {
  try {
    const path = resolveMemoryPath(cwd);
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    return {
      conventions: Array.isArray(raw.conventions) ? raw.conventions : [],
      rules: Array.isArray(raw.rules) ? raw.rules : [],
      workflows: Array.isArray(raw.workflows) ? raw.workflows : [],
      currentWork: Array.isArray(raw.currentWork) ? raw.currentWork : [],
      notes: Array.isArray(raw.notes) ? raw.notes : [],
      patterns: Array.isArray(raw.patterns) ? parsePatterns(raw.patterns) : [],
      gotchas: Array.isArray(raw.gotchas) ? raw.gotchas : [],
      decisions: Array.isArray(raw.decisions) ? raw.decisions : [],
    };
  } catch (e) {
    console.error('[workflow] loadMemory failed:', e);
    return {
      conventions: [],
      rules: [],
      workflows: [],
      currentWork: [],
      notes: [],
      patterns: [],
      gotchas: [],
      decisions: [],
    };
  }
}

/**
 * Save project memory to disk.
 * Returns null on success, error message string on failure.
 */
export function saveMemory(cwd: string, memory: ProjectMemory): string | null {
  try {
    const path = resolveMemoryPath(cwd);
    const dir = resolve(join(cwd, MEMORY_DIR));
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    atomicWriteFileSync(path, JSON.stringify(memory, null, '\t'), {
      encoding: 'utf-8',
      mode: 0o600,
    });
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : 'Save failed';
  }
}

// ── Per-workflow memory ────────────────────────────────────────

/**
 * Resolve the absolute path to a workflow-specific memory file.
 * Stored alongside workflow session JSONs in .pi/workflows/.
 */
export function resolveWorkflowMemoryPath(
  cwd: string,
  workflowId: string,
): string {
  const resolved = resolve(
    join(cwd, '.pi/workflows', `${workflowId}-memory.json`),
  );
  const root = resolve(cwd);
  if (!resolved.startsWith(`${root}/`) && resolved !== root) {
    throw new Error('Workflow memory path escapes project root');
  }
  return resolved;
}

/**
 * Load per-workflow compound learnings (patterns, gotchas, decisions).
 * Returns empty defaults if file doesn't exist or is invalid.
 */
export function loadWorkflowMemory(
  cwd: string,
  workflowId: string,
): WorkflowMemory {
  try {
    const path = resolveWorkflowMemoryPath(cwd, workflowId);
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    return {
      patterns: Array.isArray(raw.patterns) ? parsePatterns(raw.patterns) : [],
      gotchas: Array.isArray(raw.gotchas) ? raw.gotchas : [],
      decisions: Array.isArray(raw.decisions) ? raw.decisions : [],
    };
  } catch {
    return { patterns: [], gotchas: [], decisions: [] };
  }
}

/**
 * Save per-workflow compound learnings to disk.
 * Returns null on success, error message string on failure.
 */
export function saveWorkflowMemory(
  cwd: string,
  workflowId: string,
  memory: WorkflowMemory,
): string | null {
  try {
    const path = resolveWorkflowMemoryPath(cwd, workflowId);
    const dir = resolve(join(cwd, '.pi/workflows'));
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    atomicWriteFileSync(path, JSON.stringify(memory, null, '\t'), {
      encoding: 'utf-8',
      mode: 0o600,
    });
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : 'Save failed';
  }
}
