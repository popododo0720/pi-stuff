// storage/checks.ts — Custom checks loader
// Reads project-specific verification checks from docs/checks/*.md
// and project-local review context files.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Strip YAML frontmatter (--- ... ---) from markdown content.
 * Requires closing --- on its own line to avoid matching --- inside YAML values.
 */
function extractBody(raw: string): string {
  if (!raw.startsWith('---')) return raw;
  // Find closing --- that starts on its own line
  const match = raw.match(/\n---\s*\n/);
  if (!match || match.index === undefined) return raw;
  return raw.slice(match.index + match[0].length).trim();
}

/**
 * Safely read a file, returning empty string on failure.
 */
function safeReadFile(path: string): string {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Local context files to check (relative to project root).
 * These follow the compound-engineering convention for project-local review context.
 */
const LOCAL_CONTEXT_FILES = [
  'compound-engineering.local.md',
  'workflow.local.md',
  '.pi/workflow.local.md',
];

/**
 * Load all custom check files from docs/checks/ directory
 * plus project-local review context files.
 * Each .md file defines a verification check to append to the prompt.
 * Returns empty array if no checks are found.
 */
export function loadCustomChecks(cwd: string): string[] {
  const results: string[] = [];

  // 1. Load docs/checks/*.md files
  try {
    const dir = resolve(join(cwd, 'docs', 'checks'));
    if (existsSync(dir)) {
      const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
      for (const f of files) {
        try {
          const content = readFileSync(join(dir, f), 'utf-8');
          if (content.trim()) results.push(content);
        } catch (e) {
          console.error('[workflow] loadCustomCheck read failed:', e);
        }
      }
    }
  } catch (e) {
    console.error('[workflow] loadCustomChecks dir scan failed:', e);
  }

  // 2. Load project-local review context files
  for (const relPath of LOCAL_CONTEXT_FILES) {
    const fullPath = resolve(join(cwd, relPath));
    const raw = safeReadFile(fullPath);
    if (raw.trim()) {
      const body = extractBody(raw);
      if (body) results.push(body);
    }
  }

  return results;
}
