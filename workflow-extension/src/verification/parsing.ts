// verification/parsing.ts — Structured output parser & summarizer
// Parses ## CRITICAL / ## WARNING / ## INFO sections from model output.

import {
  MAX_ERROR_PREFIX_CHARS,
  MAX_VERIFICATION_SUMMARY_CHARS,
} from '../constants';

// ── Verdict parser ───────────────────────────────────────────────

export function parseVerdict(output: string): 'PASS' | 'FAIL' | undefined {
  const lines = output.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim().replace(/\*{1,2}/g, '');
    const match = line.match(/^VERDICT\s*:\s*(PASS|FAIL)\s*$/i);
    if (match) return match[1].toUpperCase() as 'PASS' | 'FAIL';
  }
  return undefined;
}

// ── Structured findings parser ───────────────────────────────────

/**
 * Parse structured findings from model output.
 * Only counts bullet items inside ## CRITICAL / ## WARNING / ## INFO sections.
 * Analysis text outside these sections is ignored (no false positives).
 */
export function parseStructuredFindings(output: string): {
  critical: number;
  warning: number;
  info: number;
} {
  type Section = 'critical' | 'warning' | 'info';
  let section: Section | null = null;
  let critical = 0;
  let warning = 0;
  let info = 0;

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();

    // Section headers (#, ##, ###)
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
      /^(?:none\.?|n\/a|na|null|0|no\s+\w+\s+(?:issues?|findings?|items?|concerns?|problems?|violations?)|nothing\s+(?:found|to\s+report|critical|notable)|all\s+(?:good|clear|correct|pass)|no\s+(?:issues?|concerns?|problems?|findings?))\s*\.?$/i.test(
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

// ── Fallback keyword scan ────────────────────────────────────────

/** Pass-signal phrases — conservative, require explicit positive language */
export const PASS_SIGNALS = [
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
export const FAIL_SIGNALS = [
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
export function fallbackKeywordScan(output: string): {
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

// ── Output summarizer ────────────────────────────────────────────

/**
 * Extract structured findings sections + verdict for summary display.
 * Ignores free-text analysis, only shows ## CRITICAL/WARNING/INFO sections.
 */
export function summarizeVerificationOutput(output: string): string {
  const maxLength = MAX_VERIFICATION_SUMMARY_CHARS;
  const lines = output.split(/\r?\n/);
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
    const fallback = output.slice(0, MAX_ERROR_PREFIX_CHARS);
    const suffix = verdictLine ? `\n${verdictLine}` : '';
    return `${fallback}\n...(unstructured output, see full results)${suffix}`;
  }

  let summary = findings.join('\n');

  // Ensure verdict at end
  if (verdictLine) {
    const budget = maxLength - verdictLine.length - 20;
    if (summary.length > budget) {
      summary = `${summary.slice(0, budget)}\n...(truncated)`;
    }
    summary = `${summary}\n${verdictLine}`;
  } else if (summary.length > maxLength) {
    summary = `${summary.slice(0, maxLength)}\n...(truncated)`;
  }

  return summary;
}
