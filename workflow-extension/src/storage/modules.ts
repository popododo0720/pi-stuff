// storage/modules.ts — ModuleConventions CRUD operations
// Handles per-module convention files stored as JSON in .pi/conventions/.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { CONVENTIONS_DIR, MEMORY_DIR } from '../constants';
import type { ModuleConventions } from '../types';

/**
 * Resolve the absolute path to the conventions directory.
 * Throws if the path escapes the project root.
 */
export function resolveConventionsDir(cwd: string): string {
  const resolved = resolve(join(cwd, MEMORY_DIR, CONVENTIONS_DIR));
  const root = resolve(cwd);
  if (!resolved.startsWith(`${root}/`) && resolved !== root) {
    throw new Error('Conventions path escapes project root');
  }
  return resolved;
}

/**
 * Validate module name — alphanumeric, hyphens, underscores only.
 */
export function isValidModuleName(name: string): boolean {
  return /^[\w-]+$/.test(name) && name.length <= 50;
}

/**
 * List all registered module names.
 */
export function listModules(cwd: string): string[] {
  try {
    const dir = resolveConventionsDir(cwd);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace('.json', ''));
  } catch (e) {
    console.error('[workflow] listModules failed:', e);
    return [];
  }
}

/**
 * Load a single module's conventions from disk.
 * Returns empty defaults if not found.
 */
export function loadModule(cwd: string, name: string): ModuleConventions {
  try {
    const dir = resolveConventionsDir(cwd);
    const filePath = resolve(join(dir, `${name}.json`));
    if (!filePath.startsWith(`${dir}/`)) throw new Error('Invalid path');
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
    return {
      path: raw.path ?? '',
      conventions: raw.conventions ?? [],
      rules: raw.rules ?? [],
    };
  } catch (e) {
    console.error('[workflow] loadModule failed:', e);
    return { path: '', conventions: [], rules: [] };
  }
}

/**
 * Save a module's conventions to disk.
 * Returns null on success, error message on failure.
 */
export function saveModule(
  cwd: string,
  name: string,
  data: ModuleConventions,
): string | null {
  try {
    if (!isValidModuleName(name))
      return 'Module name must be alphanumeric/hyphens only (max 50 chars)';
    const dir = resolveConventionsDir(cwd);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const filePath = resolve(join(dir, `${name}.json`));
    if (!filePath.startsWith(`${dir}/`)) return 'Invalid module name';
    writeFileSync(filePath, JSON.stringify(data, null, '\t'), {
      encoding: 'utf-8',
      mode: 0o600,
    });
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : 'Save failed';
  }
}

/**
 * Delete a module's convention file.
 * Returns null on success, error message on failure.
 */
export function deleteModule(cwd: string, name: string): string | null {
  try {
    const dir = resolveConventionsDir(cwd);
    const filePath = resolve(join(dir, `${name}.json`));
    if (!filePath.startsWith(`${dir}/`)) return 'Invalid module name';
    if (!existsSync(filePath)) return `Module '${name}' not found.`;
    unlinkSync(filePath);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : 'Delete failed';
  }
}

/**
 * Find modules whose path matches any of the recent file paths.
 * Used to inject only relevant module conventions into the prompt.
 */
export function loadMatchingModules(
  cwd: string,
  recentFiles: string[],
): Array<{ name: string; data: ModuleConventions }> {
  const modules = listModules(cwd);
  const matched: Array<{ name: string; data: ModuleConventions }> = [];
  for (const name of modules) {
    const data = loadModule(cwd, name);
    if (!data.path) continue;
    const prefix = data.path.endsWith('/') ? data.path : `${data.path}/`;
    if (
      recentFiles.some((f) => f.startsWith(prefix) || f.startsWith(data.path))
    ) {
      matched.push({ name, data });
    }
  }
  return matched;
}
