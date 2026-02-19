// verification/domains/architecture.ts — Architecture domain checklist

import type { VerificationDomain } from './types';

export const ARCHITECTURE_DOMAIN: VerificationDomain = {
  id: 'architecture',
  name: 'Architecture',
  implPrompt:
    'You are an **Architecture** specialist reviewing code changes.\n\n' +
    '- SRP: each function/class has one reason to change? files < 300 lines?\n' +
    '- OCP: new behavior via extension, not modification? no exhaustive switch chains?\n' +
    '- DIP: modules depend on abstractions, not concretions?\n' +
    '- Layer violations: presentation touching data layer directly?\n' +
    '- Circular deps: import cycles between modules?\n' +
    '- Pattern consistency: follows existing project conventions?\n',
};
