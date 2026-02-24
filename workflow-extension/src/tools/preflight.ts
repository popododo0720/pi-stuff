// tools/preflight.ts — Pre-flight checks for implDone gate
// Auto-detects and runs lint/tsc/test before verification.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import {
  DEFAULT_PREFLIGHT_TIMEOUT_SECONDS,
  MAX_PREFLIGHT_OUTPUT_CHARS,
} from '../constants';

/**
 * Auto-detect pre-flight commands from project configuration.
 * Reads package.json scripts, checks for tsconfig.json and biome.json.
 */
export function detectPreflightCommands(cwd: string): string[] {
  const commands: string[] = [];

  // package.json scripts
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf-8'));
    const scripts = pkg?.scripts || {};
    if (scripts.lint) {
      commands.push('npm run lint');
    }
    if (
      scripts.test &&
      typeof scripts.test === 'string' &&
      !scripts.test.startsWith('echo "Error')
    ) {
      commands.push('npm test');
    }
  } catch (e) {
    console.warn('[preflight] package.json read failed:', e);
  }

  // tsconfig.json → tsc
  try {
    if (existsSync(join(cwd, 'tsconfig.json'))) {
      commands.push('npx tsc --noEmit');
    }
  } catch (e) {
    console.warn('[preflight] tsconfig.json check failed:', e);
  }

  // biome.json → biome check (only if no lint command already)
  try {
    if (
      existsSync(join(cwd, 'biome.json')) &&
      !commands.some((c) => c.includes('lint'))
    ) {
      commands.push('npx biome check .');
    }
  } catch (e) {
    console.warn('[preflight] biome.json check failed:', e);
  }

  return commands;
}

export interface PreflightResult {
  passed: boolean;
  results: Array<{
    command: string;
    ok: boolean;
    output: string;
    code: number;
  }>;
}

/**
 * Run pre-flight commands sequentially with timeout.
 * Returns aggregate pass/fail result.
 */
export async function runPreflight(
  pi: ExtensionAPI,
  commands: string[],
  timeout = DEFAULT_PREFLIGHT_TIMEOUT_SECONDS,
): Promise<PreflightResult> {
  const results: PreflightResult['results'] = [];
  let passed = true;
  const timeoutMs = timeout * 1000;

  for (const command of commands) {
    const parts = command.split(/\s+/);
    const cmd = parts[0];
    const args = parts.slice(1);
    try {
      const r = await pi.exec(cmd, args, { timeout: timeoutMs });
      const output = `${r.stdout}\n${r.stderr}`
        .trim()
        .slice(0, MAX_PREFLIGHT_OUTPUT_CHARS);
      const ok = r.code === 0;
      if (!ok) passed = false;
      results.push({ command, ok, output, code: r.code });
    } catch (e) {
      passed = false;
      const msg = e instanceof Error ? e.message : String(e);
      results.push({
        command,
        ok: false,
        output: `Timeout or error: ${msg}`.slice(0, MAX_PREFLIGHT_OUTPUT_CHARS),
        code: -1,
      });
    }
  }

  return { passed, results };
}

/**
 * Format pre-flight failure for display.
 */
export function formatPreflightFailure(result: PreflightResult): string {
  const lines = [
    '❌ Pre-flight check failed. Fix errors before calling implDone.\n',
  ];
  for (const r of result.results) {
    if (r.ok) {
      lines.push(`✅ ${r.command}`);
    } else {
      lines.push(`❌ ${r.command} (exit ${r.code}):\n${r.output}`);
    }
  }
  return lines.join('\n');
}
