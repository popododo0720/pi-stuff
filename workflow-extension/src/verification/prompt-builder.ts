// verification/prompt-builder.ts — Verification prompt construction
// Extracts inline prompts from parallel.ts into composable builder functions.

import type { VerificationDomain } from './domains';

/** Wrap content in an XML tag with optional attributes */
export function xmlTag(
  name: string,
  content: string,
  attrs?: Record<string, string>,
): string {
  const attrStr = attrs
    ? ` ${Object.entries(attrs)
        .map(([k, v]) => `${k}="${v}"`)
        .join(' ')}`
    : '';
  return `<${name}${attrStr}>\n${content}\n</${name}>`;
}

/** Protected artifacts — included in all verification prompts */
const PROTECTED_ARTIFACTS = xmlTag(
  'critical_requirement',
  'Protected artifacts — NEVER suggest modifying these workflow pipeline documents:\n' +
    '- docs/plans/**\n- docs/solutions/**\n- docs/patterns/**\n- docs/templates/**\n' +
    'Do not flag these for deletion, cleanup, or gitignore.',
);

/** Structured output format — models must end with these sections */
export const STRUCTURED_FORMAT = xmlTag(
  'validation_gate',
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
    '- Analysis text can go BEFORE the ## CRITICAL section\n' +
    '- State each finding decisively. Do NOT hedge or self-contradict.\n',
  { blocking: 'true' },
);

// ── Shared helpers ───────────────────────────────────────────────

interface TodoContext {
  currentIndex: number;
  totalCount: number;
  completedTitles: string[];
}

function appendTodoScope(prompt: string, todoContext?: TodoContext): string {
  if (!todoContext || todoContext.totalCount <= 1) return prompt;
  const completed = todoContext.completedTitles.join(', ').slice(0, 500);
  return (
    prompt +
    `\n\n**⚠️ TODO Scope**\n` +
    `This is TODO #${todoContext.currentIndex + 1} of ${todoContext.totalCount}.\n` +
    (completed ? `Previously completed & verified TODOs: ${completed}\n` : '') +
    `- FOCUS verification on TODO #${todoContext.currentIndex + 1} requirements.\n` +
    '- For previously completed TODOs, ONLY check regressions/side-effects.\n' +
    '- Do NOT flag issues in unchanged code from completed TODOs as CRITICAL.\n'
  );
}

function appendOptional(
  prompt: string,
  stackHint?: string,
  customChecks?: string[],
): string {
  let result = prompt;
  if (stackHint) result += `\n\n**Tech Stack:**\n${stackHint}`;
  if (customChecks?.length)
    result += `\n\nProject-specific checks:\n${customChecks.join('\n\n')}`;
  return result;
}

// ── Plan prompt ──────────────────────────────────────────────────

export function buildCorePlanPrompt(opts: {
  description: string;
  planContent: string;
  stackHint?: string;
  customChecks?: string[];
}): string {
  let prompt =
    'You are a senior architect reviewing a PLAN before implementation begins.\n\n' +
    `Task: ${opts.description}\n\n` +
    `Plan:\n${opts.planContent}\n\n` +
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
    'or things a competent developer would naturally handle.\n\n' +
    PROTECTED_ARTIFACTS;
  prompt = appendOptional(prompt, opts.stackHint, opts.customChecks);
  prompt += `\n\n${STRUCTURED_FORMAT}`;
  return prompt;
}

// ── Impl core prompt ─────────────────────────────────────────────

export function buildCoreImplPrompt(opts: {
  description: string;
  planContent: string;
  implNotes?: string;
  todoContext?: TodoContext;
  stackHint?: string;
  customChecks?: string[];
}): string {
  let prompt =
    'You are a strict code verifier AND adversarial code breaker.\n\n' +
    `Task: ${opts.description}\n\n` +
    `Plan:\n${opts.planContent}\n\n` +
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
    '  Warnings are recorded and addressed in future planning cycles.\n\n' +
    PROTECTED_ARTIFACTS;

  prompt = appendTodoScope(prompt, opts.todoContext);

  if (opts.implNotes?.trim()) {
    prompt += `\n\n## Implementation Notes (from developer)\n${opts.implNotes.trim()}`;
  }

  prompt = appendOptional(prompt, opts.stackHint, opts.customChecks);
  prompt += `\n\n${STRUCTURED_FORMAT}`;
  return prompt;
}

// ── Domain prompt ────────────────────────────────────────────────

export function buildDomainPrompt(
  domain: VerificationDomain,
  opts: {
    description: string;
    planContent: string;
    todoContext?: TodoContext;
    stackHint?: string;
  },
): string {
  let prompt =
    `You are a **${domain.name}** specialist reviewing an implementation.\n\n` +
    `Task: ${opts.description}\n\n` +
    `Plan (verify implementation against this):\n${opts.planContent}\n\n` +
    'Read actual source files to verify.\n\n' +
    domain.implPrompt +
    '\n' +
    'Classification: CRITICAL = fixable in current scope. WARNING = needs broader change.\n\n' +
    PROTECTED_ARTIFACTS;

  prompt = appendTodoScope(prompt, opts.todoContext);
  if (opts.stackHint) prompt += `\n\n**Tech Stack:**\n${opts.stackHint}`;
  prompt += `\n\n${STRUCTURED_FORMAT}`;
  return prompt;
}
