// verification/parallel.ts — Parallel model verification
// Runs plan/impl verification against multiple models via `pi -p`.
// Retries on empty responses to handle transient failures.

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

/** Count severity markers in verification output */
function parseSeverity(output: string): {
  critical: number;
  warning: number;
  info: number;
} {
  const critical = (output.match(/🔴/g) || []).length;
  const warning = (output.match(/🟡/g) || []).length;
  const info = (output.match(/🔵/g) || []).length;
  return { critical, warning, info };
}

/**
 * Execute a single model verification with retry on empty response.
 * Retries up to MAX_EMPTY_RETRIES times if stdout is empty.
 */
async function runSingleModel(
  model: string,
  prompt: string,
  pi: ExtensionAPI,
  timeout: number,
  thinkingLevel: string,
  signal?: AbortSignal,
): Promise<ModelVerificationResult> {
  // Model format is "provider/model-id" — split for CLI args
  const [provider, ...modelParts] = model.split('/');
  const modelId = modelParts.join('/');
  const args = [
    '-p',
    prompt,
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

      // Retry if output is empty (concurrency issue)
      if (!output && attempt < MAX_EMPTY_RETRIES) {
        continue;
      }

      const upperOutput = output.toUpperCase();
      const passed =
        upperOutput.includes('VERDICT: PASS') ||
        upperOutput.includes('VERDICT:PASS');
      const severity = parseSeverity(output);
      return {
        model,
        passed,
        output,
        criticalCount: severity.critical,
        warningCount: severity.warning,
        infoCount: severity.info,
      };
    } catch (e) {
      // On last attempt, return error; otherwise retry
      if (attempt === MAX_EMPTY_RETRIES) {
        return {
          model,
          passed: false,
          output: `Process execution failed: ${e instanceof Error ? e.message : 'Unknown error'}`,
          criticalCount: 0,
          warningCount: 0,
          infoCount: 0,
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
  };
}

/**
 * Run parallel verification across configured models.
 * Each model receives the same prompt and must output VERDICT: PASS or VERDICT: FAIL.
 * All models must pass for overall success.
 *
 * Retries on empty responses up to 2 times per model.
 *
 * @param type - 'plan' for plan verification, 'impl' for implementation verification
 * @param planContent - The approved plan content
 * @param description - Task description
 * @param settings - Workflow settings with model list and timeout
 * @param pi - Extension API for exec()
 * @param signal - Optional abort signal
 * @throws Error if no verification models are configured
 */
export async function runParallelVerification(
  type: 'plan' | 'impl',
  planContent: string,
  description: string,
  settings: WorkflowSettings,
  pi: ExtensionAPI,
  cwd: string,
  signal?: AbortSignal,
  implNotes?: string,
): Promise<VerificationResult> {
  const verifyConfig = settings.stages.verify;
  const verifyModels = verifyConfig?.models ?? [];
  const verifyThinking = verifyConfig?.thinking ?? 'high';

  if (verifyModels.length === 0) {
    throw new Error(
      'No verification models configured. Use /workflow-settings to add models.',
    );
  }

  // Build verification prompt based on type
  let prompt =
    type === 'plan'
      ? 'You are a senior architect reviewing a PLAN before implementation begins.\n\n' +
        `Task: ${description}\n\n` +
        `Plan:\n${planContent}\n\n` +
        'Read relevant source files to understand the current codebase, then evaluate the plan:\n\n' +
        '## 1. Correctness & Completeness\n' +
        '- Does the plan address the right problem?\n' +
        '- Are ALL steps listed? (no implicit "also do X" — every change must be explicit)\n' +
        '- Are file targets identified? (exact line numbers NOT required)\n' +
        '- For each changed function/type: are ALL consumers listed that need updating?\n' +
        '- Are input validation and error handling covered for new/changed functions?\n\n' +
        '## 2. Architecture & Design\n' +
        '- Does the approach follow existing patterns in the codebase?\n' +
        '- Is there unnecessary duplication? (could existing utils be reused?)\n' +
        '- Are responsibilities cleanly separated? (SRP, no god functions)\n' +
        '- Will this create circular dependencies or tight coupling?\n\n' +
        '## 3. Security & Robustness\n' +
        '- Are untrusted inputs validated? (user input, file I/O, JSON parsing)\n' +
        '- Are edge cases considered? (empty, null, malformed, boundary values)\n' +
        '- Could the changes break existing functionality? (side effects)\n\n' +
        '## 4. Implementability\n' +
        '- Is each step unambiguous enough that a developer can implement without guessing?\n' +
        '- Are function signatures and type definitions specified for new APIs?\n\n' +
        '## Classify each finding:\n' +
        '🔴 CRITICAL: Wrong approach, missing critical step, architectural flaw, security vulnerability, breaking change not addressed\n' +
        '🟡 WARNING: Missing consumer update, missing input validation, missing edge case handling, ambiguous step\n' +
        '🔵 INFO: Style suggestion, minor optimization, nitpick, implementation-level detail\n\n' +
        '## Verdict rules:\n' +
        '- Any 🔴 CRITICAL → VERDICT: FAIL\n' +
        '- 🟡 WARNING only (no 🔴) → VERDICT: PASS (note warnings — implementer will address them)\n' +
        '- Only 🔵 INFO → VERDICT: PASS\n' +
        '- No findings → VERDICT: PASS\n\n' +
        'Plans describe WHAT to do, not every implementation detail. ' +
        'Do NOT fail for: missing exact line numbers, missing exact code snippets, minor wording, ' +
        'implementation-level details (exact validation logic, exact error messages, exact variable names), ' +
        'or things a competent developer would naturally handle during implementation.\n' +
        'IMPORTANT: You MUST end your response with exactly "VERDICT: PASS" or "VERDICT: FAIL" on its own line. Responses without an explicit VERDICT line are treated as FAIL.'
      : 'You are a strict code verifier AND adversarial code breaker.\n\n' +
        `Task: ${description}\n\n` +
        `Plan:\n${planContent}\n\n` +
        'Read the project files and perform TWO phases:\n\n' +
        '## Phase 1: Implementation Verification\n' +
        '1. Are all planned items implemented?\n' +
        '2. Does the code work correctly? (Run tests if possible)\n' +
        '3. Is anything missing?\n' +
        '4. Code quality — SOLID, YAGNI/KISS, separation of concerns, security, extensibility\n' +
        'IMPORTANT: Verify by reading the actual source files, NOT by git diff. ' +
        'Git diff may include unrelated changes from previous work. ' +
        'Only evaluate files and changes mentioned in the plan.\n\n' +
        '## Phase 2: Adversarial Testing\n' +
        'Try to break this code. Find concrete inputs, edge cases, or scenarios that would:\n' +
        '- Crash the program or cause unhandled exceptions\n' +
        '- Produce wrong results\n' +
        '- Expose security vulnerabilities\n' +
        '- Violate the stated requirements\n\n' +
        '## Classify each finding:\n' +
        '🔴 CRITICAL: Real bugs, security vulnerabilities, crashes, wrong results, missing planned items\n' +
        '🟡 WARNING: Convention violations, naming issues, unhandled edge cases\n' +
        '🔵 INFO: Style suggestions, optimization opportunities\n\n' +
        '## Verdict rules:\n' +
        '- Any 🔴 CRITICAL or 🟡 WARNING → VERDICT: FAIL (with specific scenarios)\n' +
        '- Only 🔵 INFO findings → VERDICT: PASS (note the suggestions)\n' +
        '- No findings → VERDICT: PASS\n\n' +
        'IMPORTANT: You MUST end your response with exactly "VERDICT: PASS" or "VERDICT: FAIL" on its own line. Responses without an explicit VERDICT line are treated as FAIL.';

  // Append implementation notes from the developer (impl only)
  if (type === 'impl' && implNotes?.trim()) {
    prompt +=
      '\n\n## Implementation Notes (from developer)\n' +
      'The developer provided the following context. Consider these when evaluating:\n' +
      implNotes.trim();
  }

  // Append project-specific checks from docs/checks/*.md
  const checks = loadCustomChecks(cwd);
  if (checks.length > 0) {
    prompt += `\n\nProject-specific checks:\n${checks.join('\n\n')}`;
  }

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
  // All models must pass for overall success
  const passed = results.every((r) => r.passed);
  return { passed, results };
}

/**
 * Summarize verification output by extracting severity markers + context.
 * Compresses raw output while preserving actionable information.
 * Falls back to raw prefix when no severity markers (🔴/🟡/🔵) are found.
 * VERDICT line is always guaranteed at the end of the summary.
 */
function summarizeVerificationOutput(output: string): string {
  const MAX_LENGTH = 1500;
  const lines = output.split('\n');
  const findings: string[] = [];
  let verdictLine = '';
  let infoCount = 0;
  let hasSeverityMarkers = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // VERDICT line — capture separately to guarantee placement at end
    if (/VERDICT:/i.test(line)) {
      verdictLine = line;
      continue;
    }

    // 🔴 CRITICAL — include line + next 2 context lines
    if (line.includes('🔴')) {
      hasSeverityMarkers = true;
      findings.push(line);
      for (let j = 1; j <= 2 && i + j < lines.length; j++) {
        const ctx = lines[i + j];
        if (
          ctx.includes('🔴') ||
          ctx.includes('🟡') ||
          ctx.includes('🔵') ||
          /VERDICT:/i.test(ctx)
        )
          break;
        findings.push(ctx);
      }
      continue;
    }

    // 🟡 WARNING — include line + next 2 context lines
    if (line.includes('🟡')) {
      hasSeverityMarkers = true;
      findings.push(line);
      for (let j = 1; j <= 2 && i + j < lines.length; j++) {
        const ctx = lines[i + j];
        if (
          ctx.includes('🔴') ||
          ctx.includes('🟡') ||
          ctx.includes('🔵') ||
          /VERDICT:/i.test(ctx)
        )
          break;
        findings.push(ctx);
      }
      continue;
    }

    // 🔵 INFO — count only
    if (line.includes('🔵')) {
      hasSeverityMarkers = true;
      infoCount++;
    }
  }

  // Add INFO summary
  if (infoCount > 0) {
    findings.push(`🔵 INFO: ${infoCount} suggestion(s) (see full results)`);
  }

  // Fallback: no severity markers found (verifier used plain text)
  if (!hasSeverityMarkers) {
    const fallback = output.slice(0, 500);
    const suffix = verdictLine ? `\n${verdictLine}` : '';
    return `${fallback}\n...(no severity markers found, see full results)${suffix}`;
  }

  // Build summary: findings first, then VERDICT guaranteed at the end
  let summary = findings.join('\n');
  if (verdictLine) {
    const verdictSpace = verdictLine.length + 1;
    const truncateLimit = MAX_LENGTH - verdictSpace - 40;
    if (summary.length + verdictSpace > MAX_LENGTH) {
      summary = `${summary.slice(0, Math.max(0, truncateLimit))}\n...(truncated, see full results)`;
    }
    summary = `${summary}\n${verdictLine}`;
  } else if (summary.length > MAX_LENGTH) {
    summary = `${summary.slice(0, MAX_LENGTH)}\n...(truncated, see full results)`;
  }

  return summary;
}

/**
 * Format verification results into a human-readable summary.
 * Uses marker-based extraction (🔴/🟡/🔵) for structured output.
 */
export function formatVerificationSummary(results: VerificationResult): string {
  return results.results
    .map((r) => {
      const status = r.passed ? '✅ PASS' : '❌ FAIL';
      const severity =
        r.criticalCount + r.warningCount + r.infoCount > 0
          ? ` (🔴${r.criticalCount} 🟡${r.warningCount} 🔵${r.infoCount})`
          : '';
      const output = summarizeVerificationOutput(r.output);
      return `[${r.model}] ${status}${severity}\n${output}`;
    })
    .join('\n\n');
}

/**
 * Save full verification results to a file for detailed review.
 * Returns the saved file path, or null on failure.
 */
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
        const status = r.passed ? '✅ PASS' : '❌ FAIL';
        return `## [${r.model}] ${status}\n\n${r.output}`;
      })
      .join('\n\n---\n\n');
    writeFileSync(filePath, content, 'utf-8');
    return filePath;
  } catch {
    return null;
  }
}

/**
 * Clean up all verification result files.
 * Called when workflow completes (done state).
 */
export function cleanupVerificationResults(cwd: string): void {
  try {
    const dir = resolve(join(cwd, '.pi', 'verifications'));
    if (!existsSync(dir)) return;
    for (const file of readdirSync(dir)) {
      unlinkSync(join(dir, file));
    }
    rmdirSync(dir);
  } catch {
    // Ignore cleanup errors
  }
}
