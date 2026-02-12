// storage/memory.ts — ProjectMemory CRUD operations
// Handles reading/writing the workflow memory JSON file.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MEMORY_DIR, MEMORY_FILE } from '../constants';
import type { ProjectMemory } from '../types';

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
      conventions: raw.conventions ?? [],
      rules: raw.rules ?? [],
      workflows: raw.workflows ?? [],
      currentWork: raw.currentWork ?? [],
      notes: raw.notes ?? [],
    };
  } catch {
    return {
      conventions: [],
      rules: [],
      workflows: [],
      currentWork: [],
      notes: [],
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
