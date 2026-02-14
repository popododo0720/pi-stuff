// storage/critical-patterns.ts — Critical Patterns (Tier 1 memory)
// Always-loaded patterns file for high-value learnings.
// Patterns are auto-promoted from project memory when count >= 3.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const CRITICAL_PATTERNS_DIR = 'docs/patterns';
export const CRITICAL_PATTERNS_FILE = 'critical.md';
export const MAX_CRITICAL_CHARS = 1000;

/**
 * Resolve absolute path to critical patterns file.
 * Validates path doesn't escape project root.
 */
export function resolveCriticalPath(cwd: string): string {
  const resolved = resolve(
    join(cwd, CRITICAL_PATTERNS_DIR, CRITICAL_PATTERNS_FILE),
  );
  const root = resolve(cwd);
  if (!resolved.startsWith(`${root}/`) && resolved !== root) {
    throw new Error('Critical patterns path escapes project root');
  }
  return resolved;
}

/**
 * Load critical patterns as raw markdown string.
 * Returns empty string if file doesn't exist.
 */
export function loadCriticalPatterns(cwd: string): string {
  try {
    const path = resolveCriticalPath(cwd);
    if (!existsSync(path)) return '';
    return readFileSync(path, 'utf-8').trim();
  } catch (e) {
    console.error('[workflow] loadCriticalPatterns failed:', e);
    return '';
  }
}

/**
 * Save critical patterns content to disk.
 */
export function saveCriticalPatterns(cwd: string, content: string): void {
  const path = resolveCriticalPath(cwd);
  const dir = resolve(join(cwd, CRITICAL_PATTERNS_DIR));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, content, 'utf-8');
}

/**
 * Append a pattern to critical patterns file.
 * Evicts oldest entries (FIFO) when exceeding MAX_CRITICAL_CHARS.
 */
export function appendCriticalPattern(
  cwd: string,
  pattern: string,
  count: number,
): void {
  let content = loadCriticalPatterns(cwd);
  // Truncate single line to prevent single-entry overflow
  const newLine = `- ${pattern} (발견: ${count}회)`.slice(
    0,
    MAX_CRITICAL_CHARS,
  );
  content = content ? `${content}\n${newLine}` : newLine;
  // FIFO eviction: remove oldest lines until under budget
  while (content.length > MAX_CRITICAL_CHARS) {
    const firstLineEnd = content.indexOf('\n');
    if (firstLineEnd < 0) break;
    content = content.slice(firstLineEnd + 1);
  }
  saveCriticalPatterns(cwd, content);
}
