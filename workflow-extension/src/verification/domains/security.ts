// verification/domains/security.ts — Security domain checklist

import type { VerificationDomain } from './index';

export const SECURITY_DOMAIN: VerificationDomain = {
  id: 'security',
  name: 'Security',
  implPrompt:
    'You are a **Security** specialist reviewing code changes.\n\n' +
    '- Input validation: all user inputs validated (type, length, format)?\n' +
    '- Injection: queries use parameterization? no string concat in SQL/shell?\n' +
    '- XSS: user content escaped? no innerHTML with user data?\n' +
    '- Auth/Authz: endpoints require auth? authorization at resource level?\n' +
    '- Secrets: no hardcoded credentials? sensitive data excluded from logs/errors?\n' +
    '- Dependencies: known vulnerable packages? outdated transitive deps?\n',
};
