// storage/checks.ts — Custom checks loader
// Reads project-specific verification checks from docs/checks/*.md.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Load all custom check files from docs/checks/ directory.
 * Each .md file defines a verification check to append to the prompt.
 * Returns empty array if directory doesn't exist or has no .md files.
 */
export function loadCustomChecks(cwd: string): string[] {
  try {
    const dir = resolve(join(cwd, 'docs', 'checks'));
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => {
        try {
          return readFileSync(join(dir, f), 'utf-8');
        } catch {
          return '';
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}
