// storage/critical-patterns.ts — Critical Patterns (Tier 1 memory)
// Always-loaded patterns file for high-value learnings.
// Patterns are auto-promoted from project memory when count >= 3.
// Format: structured ## N. blocks with optional ❌/✅ examples.

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { PatternEntry } from '../types';
import { atomicWriteFileSync } from './atomic-write';
import { isInsideRoot } from './path-utils';

export const CRITICAL_PATTERNS_DIR = 'docs/patterns';
export const CRITICAL_PATTERNS_FILE = 'critical.md';
export const MAX_CRITICAL_CHARS = 3000;

/**
 * Resolve absolute path to critical patterns file.
 * Validates path doesn't escape project root.
 */
export function resolveCriticalPath(cwd: string): string {
  const resolved = resolve(
    join(cwd, CRITICAL_PATTERNS_DIR, CRITICAL_PATTERNS_FILE),
  );
  const root = resolve(cwd);
  if (!isInsideRoot(resolved, root)) {
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
  atomicWriteFileSync(path, content, 'utf-8');
}

/** Count ## N. pattern blocks in content */
function countPatternBlocks(content: string): number {
  if (!content.trim()) return 0;
  return (content.match(/^## \d+\./gm) || []).length;
}

/** Renumber ## N. headers sequentially from 1 */
function renumberBlocks(content: string): string {
  let num = 0;
  return content.replace(/^## \d+\./gm, () => {
    num++;
    return `## ${num}.`;
  });
}

/**
 * Sanitize text to prevent fake ## N. block headers in content.
 * Replaces leading "## " at start of lines with "\\## " to prevent regex injection.
 */
function sanitizeBlockContent(text: string): string {
  return text.replace(/^## /gm, '\\## ');
}

/**
 * Append a structured pattern block to critical patterns file.
 * Takes PatternEntry directly — same shape used in project memory.
 * Format: ## N. title (found: X times) + optional ❌ WRONG / ✅ CORRECT / Why sections.
 * Evicts oldest blocks (FIFO) when exceeding MAX_CRITICAL_CHARS.
 */
export function appendCriticalPattern(
  cwd: string,
  pattern: PatternEntry,
): void {
  let content = loadCriticalPatterns(cwd);
  const nextNum = countPatternBlocks(content) + 1;

  let block = `## ${nextNum}. ${sanitizeBlockContent(pattern.text)} (found: ${pattern.count} times)`;
  if (pattern.wrong) {
    block += `\n\n### ❌ WRONG\n${sanitizeBlockContent(pattern.wrong)}`;
  }
  if (pattern.correct) {
    block += `\n\n### ✅ CORRECT\n${sanitizeBlockContent(pattern.correct)}`;
  }
  if (pattern.why) {
    block += `\n\n**Why:** ${sanitizeBlockContent(pattern.why)}`;
  }

  // Per-block overflow guard
  if (block.length > MAX_CRITICAL_CHARS) {
    block = block.slice(0, MAX_CRITICAL_CHARS);
  }

  content = content ? `${content}\n\n${block}` : block;

  // FIFO eviction by block — regex-based to avoid mid-block splits
  while (content.length > MAX_CRITICAL_CHARS) {
    const match = content.match(/\n## \d+\./);
    if (match === null) break;
    content = content.slice((match.index as number) + 1);
    content = renumberBlocks(content);
  }

  saveCriticalPatterns(cwd, content);
}
