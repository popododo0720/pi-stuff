// verification/domains/data-integrity.ts — Data integrity domain checklist

import type { VerificationDomain } from './index';

export const DATA_INTEGRITY_DOMAIN: VerificationDomain = {
  id: 'data-integrity',
  name: 'Data Integrity',
  implPrompt:
    'You are a **Data Integrity** specialist reviewing code changes.\n\n' +
    '- Validation: all data validated before persistence? constraints enforced?\n' +
    '- Transactions: multi-step writes wrapped in transactions? rollback on error?\n' +
    '- Migration safety: backward-compatible schema changes? reversible?\n' +
    '- Referential integrity: foreign keys respected? orphan cleanup?\n' +
    '- Serialization: JSON/YAML round-trip safe? encoding issues?\n' +
    '- Concurrency: race conditions on shared state? file locking needed?\n',
};
