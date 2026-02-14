// storage/memory.ts — ProjectMemory CRUD operations
// Handles reading/writing the workflow memory JSON file.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MEMORY_DIR, MEMORY_FILE } from '../constants';
import type { PatternEntry, ProjectMemory } from '../types';

/**
 * Resolve the absolute path to the memory file.
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
      patterns: Array.isArray(raw.patterns)
        ? raw.patterns
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
                return p as PatternEntry;
              }
              return null;
            })
            .filter((p): p is PatternEntry => p !== null)
        : [],
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
    writeFileSync(path, JSON.stringify(memory, null, '\t'), {
      encoding: 'utf-8',
      mode: 0o600,
    });
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : 'Save failed';
  }
}
