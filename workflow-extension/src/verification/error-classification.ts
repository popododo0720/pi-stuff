// verification/error-classification.ts — Error type detection
// Classifies verification output as infrastructure error, format protocol error, or valid result.

/**
 * Detect infrastructure errors (rate limit, quota, network) in output.
 * Only checks first 500 chars (error messages appear early, not in analysis).
 */
export function isInfrastructureError(output: string): boolean {
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

/**
 * Detect format protocol errors — model returned output but did not follow
 * the structured verification format (no VERDICT, no structured sections,
 * no recognizable fail signals).
 *
 * Call AFTER confirming output is not an infrastructure error and after
 * parsing verdict/findings/fallback. Returns true only when there's truly
 * no parseable content (i.e., the model garbled its output).
 */
export function isFormatProtocolError(params: {
  hasVerdict: boolean;
  structuredCount: number;
  fallbackPassed: boolean;
  fallbackCriticalCount: number;
}): boolean {
  // Format error = no verdict + no structured findings + fallback says FAIL but no fail signals found
  return (
    !params.hasVerdict &&
    params.structuredCount === 0 &&
    !params.fallbackPassed &&
    params.fallbackCriticalCount === 0
  );
}
