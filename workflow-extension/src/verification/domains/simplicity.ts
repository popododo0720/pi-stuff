// verification/domains/simplicity.ts — Simplicity domain checklist

import type { VerificationDomain } from './types';

export const SIMPLICITY_DOMAIN: VerificationDomain = {
  id: 'simplicity',
  name: 'Simplicity',
  implPrompt:
    'You are a **Simplicity** specialist reviewing code changes.\n\n' +
    '- YAGNI: is every piece of code currently needed? no speculative generality?\n' +
    '- KISS: simplest solution that works? over-abstraction?\n' +
    '- DRY: duplicated logic that should be extracted?\n' +
    '- Readability: intention-revealing names? no magic numbers?\n' +
    '- LOC: can the same result be achieved with less code?\n' +
    '- Unnecessary wrappers: abstractions that add indirection without value?\n',
};
