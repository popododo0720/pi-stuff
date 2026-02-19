// verification/domains/index.ts — Domain verification registry

import { ARCHITECTURE_DOMAIN } from './architecture';
import { DATA_INTEGRITY_DOMAIN } from './data-integrity';
import { PERFORMANCE_DOMAIN } from './performance';
import { SECURITY_DOMAIN } from './security';
import { SIMPLICITY_DOMAIN } from './simplicity';

import type { VerificationDomain } from './types';

export type { VerificationDomain } from './types';

export const ALL_DOMAINS: VerificationDomain[] = [
  SECURITY_DOMAIN,
  PERFORMANCE_DOMAIN,
  ARCHITECTURE_DOMAIN,
  DATA_INTEGRITY_DOMAIN,
  SIMPLICITY_DOMAIN,
];

export const DOMAIN_IDS: string[] = ALL_DOMAINS.map((d) => d.id);
