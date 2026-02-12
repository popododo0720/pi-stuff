// context/pattern.ts — File pattern matching and path extraction
// Used to match conditional rules against recent file paths.

import type { ExtensionContext } from '@mariozechner/pi-coding-agent';

/**
 * Check if a file path matches a glob-like pattern.
 * Supports: trailing slash (directory), *.ext, ** (recursive), * (single segment).
 */
export function matchesPattern(filePath: string, pattern: string): boolean {
  // Directory prefix match
  if (pattern.endsWith('/')) {
    return filePath.startsWith(pattern);
  }
  // Extension match (e.g. "*.ts")
  if (pattern.startsWith('*.')) {
    return filePath.endsWith(pattern.slice(1));
  }
  // Glob-to-regex conversion
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\0')
    .replace(/\*/g, '[^/]*')
    .replace(/\0/g, '.*');
  try {
    return new RegExp(`^${escaped}$`).test(filePath);
  } catch {
    return false;
  }
}

/**
 * Extract file paths mentioned in recent session messages.
 * Scans the last N entries for path-like strings.
 */
export function extractRecentFilePaths(
  ctx: ExtensionContext,
  limit = 20,
): string[] {
  const paths = new Set<string>();
  const branch = ctx.sessionManager.getBranch();
  const recent = branch.slice(-limit);
  const pathRegex = /(?:[\s"'`(,:]|^)((?:[\w@.-]+\/)+[\w@.-]+\.[\w]+)/g;

  for (const entry of recent) {
    if (entry.type !== 'message') continue;
    // Session entries have varying shapes; safely extract text content
    // biome-ignore lint/suspicious/noExplicitAny: pi session entry type is complex
    const content = (entry as any).message?.content;
    const text =
      typeof content === 'string' ? content : JSON.stringify(content ?? '');
    for (const m of text.matchAll(pathRegex)) {
      paths.add(m[1]);
    }
  }
  return [...paths];
}
