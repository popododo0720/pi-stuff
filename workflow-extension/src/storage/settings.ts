// storage/settings.ts — WorkflowSettings load/save
// Stores verification model config, timeout, and thinking level.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DEFAULT_SETTINGS, MEMORY_DIR, SETTINGS_FILE } from '../constants';
import type { WorkflowSettings } from '../types';

/**
 * Resolve the absolute path to the settings file.
 */
function resolveSettingsPath(cwd: string): string {
  return resolve(join(cwd, MEMORY_DIR, SETTINGS_FILE));
}

/**
 * Load workflow settings from disk.
 * Returns defaults if file doesn't exist or is invalid.
 */
export function loadSettings(cwd: string): WorkflowSettings {
  try {
    const path = resolveSettingsPath(cwd);
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    return {
      verifyModels: raw.verifyModels ?? DEFAULT_SETTINGS.verifyModels,
      verifyTimeout: raw.verifyTimeout ?? DEFAULT_SETTINGS.verifyTimeout,
      thinkingLevel: raw.thinkingLevel ?? DEFAULT_SETTINGS.thinkingLevel,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Save workflow settings to disk.
 * Returns null on success, error message on failure.
 */
export function saveSettings(
  cwd: string,
  settings: WorkflowSettings,
): string | null {
  try {
    const path = resolveSettingsPath(cwd);
    const dir = resolve(join(cwd, MEMORY_DIR));
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(settings, null, '\t'), {
      encoding: 'utf-8',
      mode: 0o600,
    });
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : 'Save failed';
  }
}
