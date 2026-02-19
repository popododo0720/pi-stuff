// verification/domains/performance.ts — Performance domain checklist

import type { VerificationDomain } from './types';

export const PERFORMANCE_DOMAIN: VerificationDomain = {
  id: 'performance',
  name: 'Performance',
  implPrompt:
    'You are a **Performance** specialist reviewing code changes.\n\n' +
    '- Algorithmic: any O(n²) or worse? can it be reduced?\n' +
    '- N+1 queries: loops that trigger per-item DB/API calls?\n' +
    '- Memory: large allocations in hot paths? unbounded caches/arrays?\n' +
    '- I/O: unnecessary file reads/writes? missing streaming for large data?\n' +
    '- Scale: does this work at 10x/100x current load?\n' +
    '- Caching: missed caching opportunities? cache invalidation correct?\n',
};
