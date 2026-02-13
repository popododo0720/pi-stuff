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
): Promise<VerificationResult> {
  if (settings.verifyModels.length === 0) {
    throw new Error(
      'No verification models configured. Use /workflow-settings to add models.',
    );
  }

  // Build verification prompt based on type
  let prompt =
    type === 'plan'
      ? 'You are reviewing a PLAN, not code. Evaluate at the design level.\n\n' +
        `Task: ${description}\n\n` +
        `Plan:\n${planContent}\n\n` +
        'Evaluate:\n' +
        '1. Does the plan address the right problem?\n' +
        '2. Is the approach sound and complete?\n' +
        '3. Are file targets identified? (exact line numbers NOT required)\n' +
        '4. Are there obvious missing steps or architectural risks?\n\n' +
        'Do NOT fail for: missing exact line numbers, missing exact code snippets, ' +
        'verification criteria depth, or minor wording issues.\n' +
        'Only FAIL for: wrong approach, missing critical steps, or architectural flaws.\n\n' +
        'Write a brief verification result. ' +
        'IMPORTANT: You MUST end your response with exactly "VERDICT: PASS" or "VERDICT: FAIL" on its own line. Responses without an explicit VERDICT line are treated as FAIL.'
      : 'You are a strict code verifier AND adversarial code breaker.\n\n' +
        `Task: ${description}\n\n` +
        `Plan:\n${planContent}\n\n` +
        'Read the project files and perform TWO phases:\n\n' +
        '## Phase 1: Implementation Verification\n' +
        '1. Are all planned items implemented?\n' +
        '2. Does the code work correctly? (Run tests if possible)\n' +
        '3. Is anything missing?\n' +
        '4. Code quality — SOLID, YAGNI/KISS, separation of concerns, security, extensibility\n\n' +
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

  // Append project-specific checks from docs/checks/*.md
  const checks = loadCustomChecks(cwd);
  if (checks.length > 0) {
    prompt += `\n\nProject-specific checks:\n${checks.join('\n\n')}`;
  }

  // Launch all models in parallel
  const promises = settings.verifyModels.map((model) =>
    runSingleModel(
      model,
      prompt,
      pi,
      settings.verifyTimeout,
      settings.thinkingLevel,
      signal,
    ),
  );

  // Add self-critique as 3rd parallel verifier for impl verification
  if (type === 'impl' && settings.verifyModels.length > 0) {
    const selfCritiquePrompt =
      'You are a meticulous code reviewer performing a thorough self-critique.\n\n' +
      `Task: ${description}\n\n` +
      `Plan:\n${planContent}\n\n` +
      'Read the project files and perform an exhaustive self-review:\n\n' +
      '1. **Plan compliance** — compare every planned item against the implementation. Is anything missing or partially done?\n' +
      '2. **Boundary values** — for each function, check input/output edge cases: null, undefined, empty strings, empty arrays, zero, negative numbers\n' +
      '3. **Import/export chain** — verify all imports resolve correctly and exports are used as intended across files\n' +
      '4. **Type correctness** — check interface contracts, type narrowing, and casting safety\n' +
      '5. **Error handling** — find uncaught exceptions, missing try/catch, unhandled promise rejections\n' +
      '6. **Integration side effects** — does this change break any existing code that depends on modified functions/types?\n\n' +
      '## Classify each finding:\n' +
      '🔴 CRITICAL: Real bugs, type errors, crashes, missing planned items\n' +
      '🟡 WARNING: Convention violations, naming issues, unhandled edge cases\n' +
      '🔵 INFO: Style suggestions, optimization opportunities\n\n' +
      '## Verdict rules:\n' +
      '- Any 🔴 CRITICAL or 🟡 WARNING → VERDICT: FAIL (with details)\n' +
      '- Only 🔵 INFO findings → VERDICT: PASS (note the suggestions)\n' +
      '- No findings → VERDICT: PASS\n\n' +
      'IMPORTANT: You MUST end your response with exactly "VERDICT: PASS" or "VERDICT: FAIL" on its own line. Responses without an explicit VERDICT line are treated as FAIL.';

    promises.push(
      runSingleModel(
        `${settings.verifyModels[0]}`,
        selfCritiquePrompt,
        pi,
        settings.verifyTimeout,
        settings.thinkingLevel,
        signal,
      ).then((r) => ({ ...r, model: `${r.model} (self-critique)` })),
    );
  }

  const results = await Promise.all(promises);
  // All models must pass for overall success
  const passed = results.every((r) => r.passed);
  return { passed, results };
}

/**
 * Format verification results into a human-readable summary.
 * Truncates long outputs to 300 characters for inline display.
 */
export function formatVerificationSummary(results: VerificationResult): string {
  return results.results
    .map((r) => {
      const status = r.passed ? '✅ PASS' : '❌ FAIL';
      const severity =
        r.criticalCount + r.warningCount + r.infoCount > 0
          ? ` (🔴${r.criticalCount} 🟡${r.warningCount} 🔵${r.infoCount})`
          : '';
      const output =
        r.output.length > 300 ? `${r.output.slice(0, 300)}...` : r.output;
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
