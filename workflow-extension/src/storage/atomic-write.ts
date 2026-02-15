// storage/atomic-write.ts — Atomic file write via temp + rename
// Prevents data corruption from crashes during write operations.

import type { WriteFileOptions } from 'node:fs';
import { renameSync, unlinkSync, writeFileSync } from 'node:fs';

/**
 * Write data to a file atomically.
 * Writes to a temp file first, then renames (atomic on most filesystems).
 * Falls back to direct write if rename fails (cross-device, etc).
 */
export function atomicWriteFileSync(
  path: string,
  data: string,
  options?: WriteFileOptions,
): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data, options);
  try {
    renameSync(tmp, path);
  } catch {
    // Fallback: direct write (cross-device rename 실패 시)
    writeFileSync(path, data, options);
    try {
      unlinkSync(tmp);
    } catch {
      /* orphan cleanup best-effort */
    }
  }
}
