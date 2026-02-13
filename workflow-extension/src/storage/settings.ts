// storage/settings.ts — WorkflowSettings load/save
// Stores verification model config, timeout, and thinking level.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DEFAULT_SETTINGS, MEMORY_DIR, SETTINGS_FILE } from '../constants';
import type {
  RepoMapConfig,
  StageConfig,
  StageConfigs,
  VerifyStageConfig,
  WorkflowSettings,
} from '../types';

const VALID_THINKING = new Set([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]);

function validateStageConfig(raw: unknown): StageConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const config: StageConfig = {};
  if (typeof r.model === 'string' && r.model) config.model = r.model;
  if (typeof r.thinking === 'string' && VALID_THINKING.has(r.thinking))
    config.thinking = r.thinking as StageConfig['thinking'];
  return config.model || config.thinking ? config : undefined;
}

function validateRepoMapConfig(raw: unknown): RepoMapConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const config: RepoMapConfig = {};
  if (typeof r.enabled === 'boolean') config.enabled = r.enabled;
  if (typeof r.tokenBudget === 'number' && Number.isFinite(r.tokenBudget)) {
    config.tokenBudget = Math.max(
      256,
      Math.min(8192, Math.floor(r.tokenBudget)),
    );
  }
  return config.enabled !== undefined || config.tokenBudget !== undefined
    ? config
    : undefined;
}

function validateVerifyConfig(raw: unknown): VerifyStageConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const models = Array.isArray(r.models)
    ? r.models
        .filter((m): m is string => typeof m === 'string')
        .map((m) => m.trim())
        .filter((m) => m !== '')
    : [];
  const config: VerifyStageConfig = { models };
  if (typeof r.thinking === 'string' && VALID_THINKING.has(r.thinking))
    config.thinking = r.thinking as VerifyStageConfig['thinking'];
  return config.models.length > 0 || config.thinking ? config : undefined;
}

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

    // Backward compat: migrate old verifyModels/thinkingLevel to stages
    const rawStages = raw.stages ?? {};
    if (raw.verifyModels && !rawStages.verify) {
      rawStages.verify = {
        models: raw.verifyModels,
        thinking: raw.thinkingLevel ?? 'high',
      };
    }

    const stages: StageConfigs = {};
    const plan = validateStageConfig(rawStages.plan);
    if (plan) stages.plan = plan;
    const verify = validateVerifyConfig(rawStages.verify);
    if (verify) stages.verify = verify;
    const implement = validateStageConfig(rawStages.implement);
    if (implement) stages.implement = implement;
    const compound = validateStageConfig(rawStages.compound);
    if (compound) stages.compound = compound;

    const timeout =
      typeof raw.verifyTimeout === 'number' &&
      raw.verifyTimeout > 0 &&
      raw.verifyTimeout <= 600_000
        ? raw.verifyTimeout
        : DEFAULT_SETTINGS.verifyTimeout;

    const repoMap = validateRepoMapConfig(raw.repoMap);

    return {
      verifyTimeout: timeout,
      stages,
      ...(repoMap ? { repoMap } : {}),
    };
  } catch {
    return { ...DEFAULT_SETTINGS, stages: {} };
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
