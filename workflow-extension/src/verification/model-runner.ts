// verification/model-runner.ts — Single model execution
// Runs a verification prompt against a single model via `pi -p` subprocess.

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import type { ModelVerificationResult } from '../types';
import {
  isFormatProtocolError,
  isInfrastructureError,
} from './error-classification';
import {
  fallbackKeywordScan,
  parseStructuredFindings,
  parseVerdict,
} from './parsing';

/** Max retry attempts when a model returns empty output */
export const MAX_EMPTY_RETRIES = 2;

/** Create infrastructure/format error result (DRY helper) */
function makeInfraResult(
  model: string,
  output: string,
  errorType: 'infrastructure' | 'format' = 'infrastructure',
): ModelVerificationResult {
  return {
    model,
    passed: false,
    output,
    criticalCount: 0,
    warningCount: 0,
    infoCount: 0,
    infrastructureError: true,
    verificationErrorType: errorType,
  };
}

export async function runSingleModel(
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
        return makeInfraResult(
          model,
          'Empty response after all retry attempts.',
        );
      }

      // Infrastructure error — halt verification loop
      if (isInfrastructureError(output)) {
        return makeInfraResult(model, output);
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
          if (
            isFormatProtocolError({
              hasVerdict: false,
              structuredCount: 0,
              fallbackPassed: fallback.passed,
              fallbackCriticalCount: fallback.criticalCount,
            })
          ) {
            return makeInfraResult(model, output, 'format');
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
        return makeInfraResult(
          model,
          `Process execution failed: ${e instanceof Error ? e.message : 'Unknown error'}`,
        );
      }
    }
  }

  return makeInfraResult(model, 'Empty response after all retry attempts.');
}
