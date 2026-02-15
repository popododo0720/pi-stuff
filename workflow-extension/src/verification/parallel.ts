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
        // No verdict → fail safe (model didn't follow format)
        passed = false;
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
  };
}

// ── Structured output format instruction ─────────────────────────

const STRUCTURED_FORMAT_INSTRUCTION =
  '\n\n---\n' +
  '## ⚠️ MANDATORY Output Format — responses not following this format are DISCARDED\n\n' +
  'Your response MUST end with these EXACT sections. Responses without them are invalid.\n\n' +
  '## CRITICAL\n' +
  '- [finding with file path and specific issue]\n' +
  '(Write "- None" if no critical issues)\n\n' +
  '## WARNING\n' +
  '- [finding]\n' +
  '(Write "- None" if no warnings)\n\n' +
  '## INFO\n' +
  '- [finding]\n' +
  '(Write "- None" if no info items)\n\n' +
  'VERDICT: PASS or FAIL\n\n' +
  'Rules:\n' +
  '- You MUST include all four sections above (## CRITICAL, ## WARNING, ## INFO, VERDICT)\n' +
  '- List findings ONLY as bullet points (- ) inside their section\n' +
  '- Any CRITICAL finding → VERDICT: FAIL\n' +
  '- WARNING/INFO only → VERDICT: PASS\n' +
  '- VERDICT must be the LAST line of your response\n' +
  '- Analysis text can go BEFORE the ## CRITICAL section\n';

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

  if (verifyModels.length === 0) {
    throw new Error(
      'No verification models configured. Use /workflow-settings to add models.',
    );
  }

  let prompt =
    type === 'plan'
      ? 'You are a senior architect reviewing a PLAN before implementation begins.\n\n' +
        `Task: ${description}\n\n` +
        `Plan:\n${planContent}\n\n` +
        'Read relevant source files to understand the current codebase, then evaluate:\n\n' +
        '1. **Correctness & Completeness** — right problem? all steps listed? all consumers updated?\n' +
        '2. **Architecture & Design** — follows existing patterns? no duplication? SRP?\n' +
        '3. **Security & Robustness** — inputs validated? edge cases? side effects?\n' +
        '4. **Implementability** — unambiguous steps? signatures specified?\n' +
        '5. **Architecture & SOLID Compliance** (design-level, not code-level)\n' +
        '   - Does the planned structure follow SRP? (each file/module = single responsibility)\n' +
        '   - Is the design extensible without modifying existing code? (OCP)\n' +
        '   - Are dependencies on abstractions rather than concretions? (DIP)\n' +
        '   - Any unnecessary complexity or over-engineering? (KISS/YAGNI)\n' +
        '   Classification: CRITICAL if fixable within plan scope, WARNING if needs larger structural change.\n\n' +
        'Plans describe WHAT to do, not every implementation detail. ' +
        'Do NOT fail for: missing exact line numbers, minor wording, ' +
        'or things a competent developer would naturally handle.\n'
      : 'You are a strict code verifier AND adversarial code breaker.\n\n' +
        `Task: ${description}\n\n` +
        `Plan:\n${planContent}\n\n` +
        'Read the project files and perform THREE phases:\n\n' +
        '**Phase 1: Implementation Verification**\n' +
        '- Are all planned items implemented?\n' +
        '- Does the code work correctly?\n' +
        'Verify by reading actual source files, NOT git diff.\n\n' +
        '**Phase 2: Adversarial Testing**\n' +
        'Try to break this code with concrete inputs/edge cases that would crash, ' +
        'produce wrong results, or expose vulnerabilities.\n\n' +
        '**Phase 3: Clean Code & Architecture Review**\n' +
        'Evaluate each changed/new file for:\n' +
        '- SRP: Does each function/class have exactly one reason to change? Functions >40 lines are suspect.\n' +
        '- OCP: Can new behavior be added via extension, not modification? Check for exhaustive switch/if-else chains.\n' +
        '- LSP: Do subtypes/implementations honor their contracts?\n' +
        '- ISP: Are interfaces minimal and focused?\n' +
        '- DIP: Do modules depend on abstractions? Check for direct `new` of dependencies.\n' +
        '- KISS: Is the solution the simplest that works? Remove unnecessary abstractions.\n' +
        '- YAGNI: Is every piece of code currently needed? No speculative generality.\n' +
        '- Clean Code: Intention-revealing names, no magic numbers, no duplication (DRY), small functions.\n\n' +
        'Classification:\n' +
        '- CRITICAL: Violation in NEW or CHANGED code, fixable within current PR scope\n' +
        '  (e.g. new function with 2+ responsibilities, duplicated logic, missing error handling, magic numbers)\n' +
        '- WARNING: Violation in EXISTING code or requiring structural change beyond current scope\n' +
        '  (e.g. legacy patterns, cross-cutting concerns, existing tight coupling)\n' +
        '  Warnings are recorded and addressed in future planning cycles.\n';

  // Append TODO scope context (focus verifier on current TODO, regression-only for completed ones)
  if (type === 'impl' && todoContext && todoContext.totalCount > 1) {
    const completed = todoContext.completedTitles.join(', ').slice(0, 500);
    prompt +=
      `\n\n**⚠️ TODO Scope**\n` +
      `This is TODO #${todoContext.currentIndex + 1} of ${todoContext.totalCount}.\n` +
      (completed
        ? `Previously completed & verified TODOs: ${completed}\n`
        : '') +
      `- FOCUS verification on TODO #${todoContext.currentIndex + 1} requirements.\n` +
      '- For previously completed TODOs, ONLY check regressions/side-effects caused by current changes.\n' +
      '- Do NOT flag issues in unchanged code from completed TODOs as CRITICAL.\n';
  }

  // Append implementation notes
  if (type === 'impl' && implNotes?.trim()) {
    prompt += `\n## Implementation Notes (from developer)\n${implNotes.trim()}`;
  }

  // Append project-specific checks
  const checks = loadCustomChecks(cwd);
  if (checks.length > 0) {
    prompt += `\n\nProject-specific checks:\n${checks.join('\n\n')}`;
  }

  // Append structured format instruction (always last)
  prompt += STRUCTURED_FORMAT_INSTRUCTION;

  // Launch all models in parallel
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

  // If ANY model hit infra error → halt (don't enter fix loop)
  const hasInfraError = results.some((r) => r.infrastructureError);
  if (hasInfraError) {
    return { passed: false, results, halted: true };
  }

  const passed = results.every((r) => r.passed);
  return { passed, results };
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
    const output = summarizeVerificationOutput(r.output);
    parts.push(`[${r.model}] ${status}${severity}\n${output}`);
  }

  for (const r of infraErrors) {
    const preview = r.output.slice(0, 200).replace(/\n/g, ' ');
    parts.push(`[${r.model}] ⛔ HALTED (infrastructure error)\n${preview}`);
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
        const label = r.infrastructureError
          ? '⛔ HALTED'
          : r.passed
            ? '✅ PASS'
            : '❌ FAIL';
        return `## [${r.model}] ${label}\n\n${r.output}`;
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
