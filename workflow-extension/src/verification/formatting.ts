// verification/formatting.ts — Verification output formatting & persistence
// Formats verification results for display and saves to disk.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import type { VerificationResult } from '../types';
import { summarizeVerificationOutput } from './parsing';

// ── Output formatting ────────────────────────────────────────────

export function formatVerificationSummary(results: VerificationResult): string {
  const infraErrors = results.results.filter((r) => r.infrastructureError);
  const validResults = results.results.filter((r) => !r.infrastructureError);

  const parts: string[] = [];

  for (const r of validResults) {
    const status = r.passed ? '✅ PASS' : '❌ FAIL';
    const counts: string[] = [];
    if (r.criticalCount > 0) counts.push(`🔴${r.criticalCount}`);
    if (r.warningCount > 0) counts.push(`🟡${r.warningCount}`);
    if (r.infoCount > 0) counts.push(`🔵${r.infoCount}`);
    const severity = counts.length > 0 ? ` (${counts.join(' ')})` : '';
    const retrySuffix = r.retryAttempt ? ' (retry)' : '';
    const label = r.domain ? `${r.model}/${r.domain}` : r.model;
    const output = summarizeVerificationOutput(r.output);
    parts.push(`[${label}] ${status}${severity}${retrySuffix}\n${output}`);
  }

  for (const r of infraErrors) {
    const label = r.domain ? `${r.model}/${r.domain}` : r.model;
    const preview = r.output.slice(0, 200).replace(/\n/g, ' ');
    const retrySuffix = r.retryAttempt ? ' (retry)' : '';
    const kind = r.verificationErrorType ?? 'infrastructure';
    // HALTED = first failure (no retry attempted or not a domain retry target)
    // SKIPPED = persistent failure after domain retry
    const statusIcon = r.retryAttempt ? '⛔ SKIPPED' : '⛔ HALTED';
    parts.push(`[${label}] ${statusIcon} (${kind})${retrySuffix}\n${preview}`);
  }

  return parts.join('\n\n');
}

// ── File I/O ─────────────────────────────────────────────────────

export function saveVerificationResult(
  cwd: string,
  type: 'plan' | 'impl',
  results: VerificationResult,
  workflowId?: string,
): string | null {
  try {
    const dir = resolve(join(cwd, '.pi', 'verifications'));
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const prefix = workflowId ? `${workflowId}-` : '';
    const dateStr = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = join(dir, `${prefix}${type}-${dateStr}.md`);
    const content = results.results
      .map((r) => {
        const modelLabel = r.domain ? `${r.model}/${r.domain}` : r.model;
        const retrySuffix = r.retryAttempt ? ' (retry)' : '';
        let statusLabel: string;
        if (r.infrastructureError) {
          const kind = r.verificationErrorType ?? 'infrastructure';
          const icon = r.retryAttempt ? '⛔ SKIPPED' : '⛔ HALTED';
          statusLabel = `${icon} (${kind})`;
        } else {
          statusLabel = r.passed ? '✅ PASS' : '❌ FAIL';
        }
        return `## [${modelLabel}] ${statusLabel}${retrySuffix}\n\n${r.output}`;
      })
      .join('\n\n---\n\n');
    writeFileSync(filePath, content, 'utf-8');
    return filePath;
  } catch (e) {
    console.error('[workflow] saveVerificationResult failed:', e);
    return null;
  }
}

export function cleanupVerificationResults(cwd: string): void {
  try {
    const dir = resolve(join(cwd, '.pi', 'verifications'));
    if (!existsSync(dir)) return;
    for (const file of readdirSync(dir)) {
      unlinkSync(join(dir, file));
    }
    rmdirSync(dir);
  } catch (e) {
    console.error('[workflow] cleanupVerificationResults failed:', e);
  }
}
