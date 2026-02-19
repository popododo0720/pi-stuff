// verification/parallel.ts — Parallel model verification
// Runs plan/impl verification against multiple models via `pi -p`.
// Uses structured output format (## CRITICAL / ## WARNING / ## INFO sections).

import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { loadCustomChecks } from '../storage/checks';
import type {
  ModelVerificationResult,
  VerificationResult,
  WorkflowSettings,
} from '../types';
import { ALL_DOMAINS } from './domains';
import {
  buildCoreImplPrompt,
  buildCorePlanPrompt,
  buildDomainPrompt,
} from './prompt-builder';
import { detectStack, getStackHint } from './stack-detect';

/** Max retry attempts when a model returns empty output */
const MAX_EMPTY_RETRIES = 2;

// ── Structured output parser ─────────────────────────────────────
// Models are prompted to output findings in ## CRITICAL / ## WARNING / ## INFO
// sections with bullet points. This parser reads only those sections.

function parseVerdict(output: string): 'PASS' | 'FAIL' | undefined {
  const lines = output.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim().replace(/\*{1,2}/g, '');
    const match = line.match(/^VERDICT\s*:\s*(PASS|FAIL)\s*$/i);
    if (match) return match[1].toUpperCase() as 'PASS' | 'FAIL';
  }
  return undefined;
}

/**
 * Parse structured findings from model output.
 * Only counts bullet items inside ## CRITICAL / ## WARNING / ## INFO sections.
 * Analysis text outside these sections is ignored (no false positives).
 */
function parseStructuredFindings(output: string): {
  critical: number;
  warning: number;
  info: number;
} {
  type Section = 'critical' | 'warning' | 'info';
  let section: Section | null = null;
  let critical = 0;
  let warning = 0;
  let info = 0;

  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim();

    // Section headers (##, ###, or plain)
    if (/^#{1,3}\s*CRITICAL/i.test(line)) {
      section = 'critical';
      continue;
    }
    if (/^#{1,3}\s*WARNING/i.test(line)) {
      section = 'warning';
      continue;
    }
    if (/^#{1,3}\s*INFO/i.test(line)) {
      section = 'info';
      continue;
    }

    // End section on other headers or VERDICT
    if (/^#{1,3}\s/.test(line) || /^VERDICT\s*:/i.test(line)) {
      section = null;
      continue;
    }

    // Count bullet items in current section
    if (!section) continue;
    const bullet = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.+)$/);
    if (!bullet) continue;

    const text = bullet[1].trim();
    // Skip "None", "N/A", "No critical issues", etc.
    if (
      /^(?:none|n\/a|na|null|0|no\s+\w+\s+(?:issues?|findings?|items?))/i.test(
        text,
      )
    ) {
      continue;
    }

    if (section === 'critical') critical++;
    if (section === 'warning') warning++;
    if (section === 'info') info++;
  }

  return { critical, warning, info };
}

/** Detect infrastructure errors (rate limit, quota, network) in output.
 *  Only checks first 500 chars (error messages appear early, not in analysis). */
function isInfrastructureError(output: string): boolean {
  const prefix = output.slice(0, 500).toLowerCase();
  return (
    /usage limit|rate limit|quota exceeded|too many requests/.test(prefix) ||
    /\b(429|503)\b.*error/i.test(prefix) ||
    /error.*\b(429|503)\b/i.test(prefix) ||
    /try again in\s+~?\d+/.test(prefix) ||
    prefix.startsWith('process execution failed:') ||
    prefix.startsWith('empty response after all retry')
  );
}

// ── Fallback keyword scan ────────────────────────────────────────

/** Pass-signal phrases — conservative, require explicit positive language */
const PASS_SIGNALS = [
  'no issues',
  'no critical',
  'no problems',
  'looks good',
  'lgtm',
  'all correct',
  'all items implemented',
  'everything is correct',
  'no bugs',
  'implementation is correct',
  'correctly implemented',
];

/** Fail-signal phrases — multi-word to avoid false positives */
const FAIL_SIGNALS = [
  'critical bug',
  'critical issue',
  'critical error',
  'missing implementation',
  'not implemented',
  'will crash',
  'security vulnerability',
  'data loss',
  'race condition',
  'incorrect implementation',
  'breaks existing',
  'undefined behavior',
  'bug found',
  'issue found',
  'does not work',
  'does not match',
  'vulnerability found',
  'missing error handling',
  'missing validation',
];

/**
 * Fallback keyword scan when model doesn't follow structured format.
 * Conservative: only overrides to PASS if strong positive signals AND no negative signals.
 */
function fallbackKeywordScan(output: string): {
  passed: boolean;
  criticalCount: number;
} {
  const lower = output.toLowerCase();

  const hasPassSignal = PASS_SIGNALS.some((s) => lower.includes(s));
  const hasFailSignal = FAIL_SIGNALS.some((s) => lower.includes(s));
  const failCount = FAIL_SIGNALS.filter((s) => lower.includes(s)).length;

  if (hasPassSignal && !hasFailSignal) {
    return { passed: true, criticalCount: 0 };
  }

  return { passed: false, criticalCount: failCount };
}

// ── Single model execution ───────────────────────────────────────

async function runSingleModel(
  model: string,
  prompt: string,
  pi: ExtensionAPI,
  timeout: number,
  thinkingLevel: string,
  signal?: AbortSignal,
): Promise<ModelVerificationResult> {
  const [provider, ...modelParts] = model.split('/');
  const modelId = modelParts.join('/');
  const args = [
    '-p',
    prompt,
    '--no-extensions',
    '--tools',
    'read,bash,grep,find,ls',
    '--provider',
    provider,
    '--model',
    modelId,
    '--thinking',
    thinkingLevel,
  ];

  for (let attempt = 0; attempt <= MAX_EMPTY_RETRIES; attempt++) {
    try {
      const result = await pi.exec('pi', args, { signal, timeout });
      const output = `${result.stdout}\n${result.stderr}`.trim();

      if (!output && attempt < MAX_EMPTY_RETRIES) {
        continue;
      }

      // Empty output on final attempt → infrastructure error
      if (!output) {
        return {
          model,
          passed: false,
          output: 'Empty response after all retry attempts.',
          criticalCount: 0,
          warningCount: 0,
          infoCount: 0,
          infrastructureError: true,
          verificationErrorType: 'infrastructure',
        };
      }

      // Infrastructure error — halt verification loop
      if (isInfrastructureError(output)) {
        return {
          model,
          passed: false,
          output,
          criticalCount: 0,
          warningCount: 0,
          infoCount: 0,
          infrastructureError: true,
          verificationErrorType: 'infrastructure',
        };
      }

      const severity = parseStructuredFindings(output);
      const verdict = parseVerdict(output);
      const hasCritical = severity.critical > 0;

      // VERDICT takes priority, but CRITICAL findings always block.
      let passed: boolean;
      if (verdict === 'PASS') {
        // Trust PASS, but override if model contradicts itself (listed criticals but said PASS)
        passed = !hasCritical;
      } else if (verdict === 'FAIL') {
        passed = !hasCritical;
      } else {
        // No verdict — try keyword fallback if structured parsing also found nothing
        if (
          severity.critical === 0 &&
          severity.warning === 0 &&
          severity.info === 0
        ) {
          const fallback = fallbackKeywordScan(output);
          passed = fallback.passed;
          severity.critical = fallback.criticalCount;

          // Format protocol error: no verdict, no structured findings,
          // AND no fail signals detected (criticalCount === 0).
          // If fail signals exist, it's a real code FAIL, not format.
          if (!passed && fallback.criticalCount === 0) {
            return {
              model,
              passed: false,
              output,
              criticalCount: 0,
              warningCount: 0,
              infoCount: 0,
              infrastructureError: true,
              verificationErrorType: 'format',
            };
          }
        } else {
          // Had some structured findings but no verdict → fail safe
          passed = false;
        }
      }

      return {
        model,
        passed,
        output,
        criticalCount: severity.critical,
        warningCount: severity.warning,
        infoCount: severity.info,
      };
    } catch (e) {
      if (attempt === MAX_EMPTY_RETRIES) {
        return {
          model,
          passed: false,
          output: `Process execution failed: ${e instanceof Error ? e.message : 'Unknown error'}`,
          criticalCount: 0,
          warningCount: 0,
          infoCount: 0,
          infrastructureError: true,
          verificationErrorType: 'infrastructure',
        };
      }
    }
  }

  return {
    model,
    passed: false,
    output: 'Empty response after all retry attempts.',
    criticalCount: 0,
    warningCount: 0,
    infoCount: 0,
    infrastructureError: true,
    verificationErrorType: 'infrastructure',
  };
}

// ── Parallel verification ────────────────────────────────────────

export async function runParallelVerification(
  type: 'plan' | 'impl',
  planContent: string,
  description: string,
  settings: WorkflowSettings,
  pi: ExtensionAPI,
  cwd: string,
  signal?: AbortSignal,
  implNotes?: string,
  todoContext?: {
    currentIndex: number;
    totalCount: number;
    completedTitles: string[];
  },
): Promise<VerificationResult> {
  const verifyConfig = settings.stages.verify;
  const verifyModels = verifyConfig?.models ?? [];
  const verifyThinking = verifyConfig?.thinking ?? 'high';
  const stacks = detectStack(cwd);
  const stackHint = getStackHint(stacks);
  const checks = loadCustomChecks(cwd);
  const customChecks = checks.length > 0 ? checks : undefined;

  if (type === 'plan') {
    // ── Plan: existing multi-model structure, no domain checks ──
    if (verifyModels.length === 0) {
      throw new Error(
        'No verification models configured. Plan verification requires core models. Use /workflow-settings to add models.',
      );
    }
    const prompt = buildCorePlanPrompt({
      description,
      planContent,
      stackHint,
      customChecks,
    });
    const promises = verifyModels.map((model) =>
      runSingleModel(
        model,
        prompt,
        pi,
        settings.verifyTimeout,
        verifyThinking,
        signal,
      ),
    );
    const results = await Promise.all(promises);
    if (results.some((r) => r.infrastructureError)) {
      return { passed: false, results, halted: true };
    }
    return { passed: results.every((r) => r.passed), results };
  }

  // ── Impl: Core + Domain parallel ──
  const corePrompt = buildCoreImplPrompt({
    description,
    planContent,
    implNotes,
    todoContext,
    stackHint,
    customChecks,
  });

  const corePromises = verifyModels.map((model) =>
    runSingleModel(
      model,
      corePrompt,
      pi,
      settings.verifyTimeout,
      verifyThinking,
      signal,
    ),
  );

  // ── Build domain task descriptors (stable index for retry) ──
  interface DomainTask {
    domain: (typeof ALL_DOMAINS)[number];
    model: string;
    prompt: string;
    thinking: string;
  }

  const domainConfig = verifyConfig?.domains ?? {};
  const domainTasks: DomainTask[] = [];

  for (const domain of ALL_DOMAINS) {
    if (domainConfig[domain.id]?.enabled === false) continue;
    const dc = domainConfig[domain.id];
    const models = dc?.models?.length
      ? dc.models
      : verifyModels.length > 0
        ? [verifyModels[ALL_DOMAINS.indexOf(domain) % verifyModels.length]]
        : [];
    if (models.length === 0) continue;
    const thinking = dc?.thinking ?? verifyThinking;
    const prompt = buildDomainPrompt(domain, {
      description,
      planContent,
      todoContext,
      stackHint,
    });
    for (const model of models) {
      domainTasks.push({ domain, model, prompt, thinking });
    }
  }

  // Must have at least one verification call
  if (corePromises.length === 0 && domainTasks.length === 0) {
    throw new Error(
      'No verification models configured. Use /workflow-settings to add models.',
    );
  }

  // Execute core + domain in parallel
  const domainPromises = domainTasks.map((task) =>
    runSingleModel(
      task.model,
      task.prompt,
      pi,
      settings.verifyTimeout,
      task.thinking,
      signal,
    ).then(
      (r): ModelVerificationResult => ({ ...r, domain: task.domain.name }),
    ),
  );

  const [coreResults, domainResults] = await Promise.all([
    Promise.all(corePromises),
    Promise.all(domainPromises),
  ]);

  // Core infra/format error → halt
  if (coreResults.some((r) => r.infrastructureError)) {
    return {
      passed: false,
      results: [...coreResults, ...domainResults],
      halted: true,
    };
  }

  // ── Domain partial retry: retry only infra/format failures (parallel) ──
  const retryIndices = domainResults
    .map((r, i) => (r.verificationErrorType ? i : -1))
    .filter((i) => i >= 0);

  if (retryIndices.length > 0) {
    const retryPromises = retryIndices.map((i) => {
      const task = domainTasks[i];
      return runSingleModel(
        task.model,
        task.prompt,
        pi,
        settings.verifyTimeout,
        task.thinking,
        signal,
      ).then((retried): [number, ModelVerificationResult] => [
        i,
        { ...retried, domain: task.domain.name, retryAttempt: 1 },
      ]);
    });
    const retryResults = await Promise.all(retryPromises);
    for (const [i, result] of retryResults) {
      domainResults[i] = result;
    }
  }

  const allResults = [...coreResults, ...domainResults];
  const validResults = allResults.filter((r) => !r.infrastructureError);

  // All results are infra/format errors → halt
  if (validResults.length === 0) {
    return { passed: false, results: allResults, halted: true };
  }

  const passed = validResults.every((r) => r.passed);
  return { passed, results: allResults };
}

// ── Output formatting ────────────────────────────────────────────

/**
 * Extract structured findings sections + verdict for summary display.
 * Ignores free-text analysis, only shows ## CRITICAL/WARNING/INFO sections.
 */
export function summarizeVerificationOutput(output: string): string {
  const MAX_LENGTH = 1500;
  const lines = output.split('\n');
  const findings: string[] = [];
  let verdictLine = '';
  let inSection = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (/^VERDICT\s*:/i.test(trimmed)) {
      verdictLine = trimmed;
      continue;
    }

    // Capture findings section headers + content
    if (/^#{1,3}\s*(?:CRITICAL|WARNING|INFO)/i.test(trimmed)) {
      inSection = true;
      findings.push(trimmed);
      continue;
    }

    // End section on other headers
    if (/^#{1,3}\s/.test(trimmed) && inSection) {
      inSection = false;
      continue;
    }

    if (inSection && trimmed) {
      findings.push(line); // Keep original indentation
    }
  }

  // Fallback: no structured sections found
  if (findings.length === 0) {
    const fallback = output.slice(0, 500);
    const suffix = verdictLine ? `\n${verdictLine}` : '';
    return `${fallback}\n...(unstructured output, see full results)${suffix}`;
  }

  let summary = findings.join('\n');

  // Ensure verdict at end
  if (verdictLine) {
    const budget = MAX_LENGTH - verdictLine.length - 20;
    if (summary.length > budget) {
      summary = `${summary.slice(0, budget)}\n...(truncated)`;
    }
    summary = `${summary}\n${verdictLine}`;
  } else if (summary.length > MAX_LENGTH) {
    summary = `${summary.slice(0, MAX_LENGTH)}\n...(truncated)`;
  }

  return summary;
}

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
