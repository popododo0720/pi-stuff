// storage/path-utils.ts — Cross-platform path security utilities

import { sep } from 'node:path';

/**
 * Cross-platform check: resolved path is inside (or equal to) root.
 * Works on both Windows (backslash) and POSIX (forward slash).
 */
export function isInsideRoot(resolved: string, root: string): boolean {
  if (resolved === root) return true;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return resolved.startsWith(prefix);
}
