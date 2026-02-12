// verification/parallel.ts — Parallel model verification
// Runs plan/impl verification against multiple models via `pi -p`.

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import type { VerificationResult, WorkflowSettings } from '../types';

/**
 * Run parallel verification across configured models.
 * Each model receives the same prompt and must output VERDICT: PASS or VERDICT: FAIL.
 * All models must pass for overall success.
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
  signal?: AbortSignal,
): Promise<VerificationResult> {
  if (settings.verifyModels.length === 0) {
    throw new Error(
      'No verification models configured. Use /workflow-settings to add models.',
    );
  }

  // Build verification prompt based on type
  const prompt =
    type === 'plan'
      ? 'You are a code implementation plan verifier. Verify the following plan:\n\n' +
        `Task: ${description}\n\n` +
        `Plan:\n${planContent}\n\n` +
        'Verification criteria:\n' +
        '1. Is the plan clear and specific?\n' +
        '2. Are there any missing steps?\n' +
        '3. Is the file change list realistic?\n' +
        '4. Are the verification criteria measurable?\n\n' +
        'Write a detailed verification result. ' +
        'On the last line, write exactly "VERDICT: PASS" or "VERDICT: FAIL".'
      : 'You are a code implementation verifier. ' +
        'Verify the implementation against the following plan:\n\n' +
        `Task: ${description}\n\n` +
        `Plan:\n${planContent}\n\n` +
        'Read the project files and check:\n' +
        '1. Are all planned items implemented?\n' +
        '2. Does the code work correctly? (Run tests if possible)\n' +
        '3. Is anything missing?\n\n' +
        'Write a detailed verification result. ' +
        'On the last line, write exactly "VERDICT: PASS" or "VERDICT: FAIL".';

  // Run all models in parallel
  const promises = settings.verifyModels.map(async (model) => {
    try {
      // Model format is "provider/model-id" — split for CLI args
      const [provider, ...modelParts] = model.split('/');
      const modelId = modelParts.join('/');
      const args = ['-p', prompt, '--provider', provider, '--model', modelId];
      const result = await pi.exec('pi', args, {
        signal,
        timeout: settings.verifyTimeout,
      });
      const output = `${result.stdout}\n${result.stderr}`.trim();
      const upperOutput = output.toUpperCase();
      const passed =
        upperOutput.includes('VERDICT: PASS') ||
        upperOutput.includes('VERDICT:PASS');
      return { model, passed, output };
    } catch (e) {
      return {
        model,
        passed: false,
        output: `Process execution failed: ${e instanceof Error ? e.message : 'Unknown error'}`,
      };
    }
  });

  const results = await Promise.all(promises);
  // All models must pass for overall success
  const passed = results.every((r) => r.passed);
  return { passed, results };
}

/**
 * Format verification results into a human-readable summary.
 * Truncates long outputs to 300 characters.
 */
export function formatVerificationSummary(results: VerificationResult): string {
  return results.results
    .map((r) => {
      const status = r.passed ? '✅ PASS' : '❌ FAIL';
      const output =
        r.output.length > 300 ? `${r.output.slice(0, 300)}...` : r.output;
      return `[${r.model}] ${status}\n${output}`;
    })
    .join('\n\n');
}
