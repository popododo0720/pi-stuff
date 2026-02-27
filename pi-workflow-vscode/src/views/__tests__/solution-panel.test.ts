import { describe, expect, it } from 'vitest';
import { parseSolutionFile } from '../solution-parser';

const VALID_SOLUTION = `---
title: "Fix Windows path issue"
date: 2026-02-26
workflowId: wf-20260223-142522
type: solution
category: general
severity: medium
tags: [windows, path, dirname]
symptoms:
  - "Windows"
  - "WASM load failure"
rootCause: "require.resolve() returns OS-specific separator"
prevention: "Use path module functions instead of string literals"
---

## Solution Body

- **Problem:** repomap WASM path fails on Windows
- **Solution:** Replace string manipulation with dirname()
`;

describe('parseSolutionFile', () => {
  it('parses valid frontmatter with all fields', () => {
    const result = parseSolutionFile(VALID_SOLUTION, 'docs/solutions/general/2026-02-26-fix.md');
    expect(result).not.toBeNull();
    expect(result!.title).toBe('Fix Windows path issue');
    expect(result!.date).toBe('2026-02-26');
    expect(result!.category).toBe('general');
    expect(result!.severity).toBe('medium');
    expect(result!.tags).toEqual(['windows', 'path', 'dirname']);
    expect(result!.symptoms).toEqual(['Windows', 'WASM load failure']);
    expect(result!.rootCause).toBe("require.resolve() returns OS-specific separator");
    expect(result!.prevention).toBe("Use path module functions instead of string literals");
    expect(result!.filePath).toBe('docs/solutions/general/2026-02-26-fix.md');
  });

  it('extracts body after frontmatter', () => {
    const result = parseSolutionFile(VALID_SOLUTION, 'test.md');
    expect(result).not.toBeNull();
    expect(result!.body).toContain('## Solution Body');
    expect(result!.body).toContain('Replace string manipulation with dirname()');
  });

  it('returns null for empty string', () => {
    expect(parseSolutionFile('', 'test.md')).toBeNull();
  });

  it('returns null for content without frontmatter', () => {
    expect(parseSolutionFile('# Just a heading\nSome text', 'test.md')).toBeNull();
  });

  it('returns null for content with only opening ---', () => {
    expect(parseSolutionFile('---\ntitle: "test"\n', 'test.md')).toBeNull();
  });

  it('handles minimal frontmatter', () => {
    const minimal = `---
title: "Minimal"
---

Body text here.
`;
    const result = parseSolutionFile(minimal, 'test.md');
    expect(result).not.toBeNull();
    expect(result!.title).toBe('Minimal');
    expect(result!.category).toBe('general');
    expect(result!.severity).toBe('medium');
    expect(result!.tags).toEqual([]);
    expect(result!.symptoms).toEqual([]);
    expect(result!.body).toBe('Body text here.');
  });

  it('handles quoted title with escaped quotes', () => {
    const content = `---
title: "Fix \\"broken\\" thing"
date: 2026-01-01
---
Body
`;
    const result = parseSolutionFile(content, 'test.md');
    expect(result).not.toBeNull();
    expect(result!.title).toBe('Fix \\"broken\\" thing');
  });

  it('handles body containing --- (not confused with frontmatter boundary)', () => {
    const content = `---
title: "Test"
---

Some text

---

This is a separator in the body, not frontmatter.
`;
    const result = parseSolutionFile(content, 'test.md');
    expect(result).not.toBeNull();
    expect(result!.body).toContain('---');
    expect(result!.body).toContain('This is a separator in the body');
  });

  it('handles tags as inline array', () => {
    const content = `---
title: "Tags Test"
tags: [alpha, beta, gamma]
---
`;
    const result = parseSolutionFile(content, 'test.md');
    expect(result).not.toBeNull();
    expect(result!.tags).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('handles empty tags array', () => {
    const content = `---
title: "No Tags"
tags: []
---
`;
    const result = parseSolutionFile(content, 'test.md');
    expect(result).not.toBeNull();
    expect(result!.tags).toEqual([]);
  });

  it('handles multiple symptoms', () => {
    const content = `---
title: "Symptoms Test"
symptoms:
  - "symptom one"
  - "symptom two"
  - "symptom three"
---
`;
    const result = parseSolutionFile(content, 'test.md');
    expect(result).not.toBeNull();
    expect(result!.symptoms).toEqual(['symptom one', 'symptom two', 'symptom three']);
  });

  it('uses defaults for missing optional fields', () => {
    const content = `---
title: "Only Title"
---
`;
    const result = parseSolutionFile(content, 'path.md');
    expect(result).not.toBeNull();
    expect(result!.date).toBe('');
    expect(result!.category).toBe('general');
    expect(result!.severity).toBe('medium');
    expect(result!.rootCause).toBe('');
    expect(result!.prevention).toBe('');
  });

  it('preserves filePath as given', () => {
    const content = `---
title: "Path Test"
---
`;
    const result = parseSolutionFile(content, 'docs/solutions/build-errors/2026-01-01-fix.md');
    expect(result).not.toBeNull();
    expect(result!.filePath).toBe('docs/solutions/build-errors/2026-01-01-fix.md');
  });

  it('uses Untitled when title is missing', () => {
    const content = `---
date: 2026-01-01
---
`;
    const result = parseSolutionFile(content, 'test.md');
    expect(result).not.toBeNull();
    expect(result!.title).toBe('Untitled');
  });
});
