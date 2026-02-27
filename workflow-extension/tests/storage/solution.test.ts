import { describe, expect, it } from 'vitest';
import {
  classifyCategory,
  classifySeverity,
  extractSymptoms,
} from '../../src/storage/solution';

describe('classifyCategory', () => {
  it('classifies build-related text as build-errors', () => {
    expect(classifyCategory('TypeScript build compile error')).toBe(
      'build-errors',
    );
  });

  it('classifies tsc lint as build-errors', () => {
    expect(classifyCategory('tsc lint failure')).toBe('build-errors');
  });

  it('classifies performance-related text', () => {
    expect(classifyCategory('slow memory leak performance issue')).toBe(
      'performance-issues',
    );
  });

  it('classifies runtime-related text', () => {
    expect(classifyCategory('crash exception undefined null')).toBe(
      'runtime-errors',
    );
  });

  it('classifies logic-related text', () => {
    expect(classifyCategory('wrong incorrect calculation bug')).toBe(
      'logic-errors',
    );
  });

  it('classifies security-related text', () => {
    expect(classifyCategory('security auth xss injection')).toBe(
      'security-issues',
    );
  });

  it('classifies workflow-related text', () => {
    expect(classifyCategory('workflow pipeline ci deploy git')).toBe(
      'workflow-issues',
    );
  });

  it('falls back to general for unmatched text', () => {
    expect(classifyCategory('random topic with no keywords')).toBe('general');
  });

  it('is case-insensitive', () => {
    expect(classifyCategory('BUILD COMPILE ERROR')).toBe('build-errors');
  });

  it('picks the category with most keyword hits', () => {
    // 3 security keywords vs 1 build keyword
    expect(classifyCategory('security auth xss build')).toBe('security-issues');
  });
});

describe('classifySeverity', () => {
  it('classifies critical keywords', () => {
    expect(classifySeverity('data loss crash')).toBe('critical');
  });

  it('classifies high keywords', () => {
    expect(classifySeverity('fails regression major')).toBe('high');
  });

  it('classifies medium keywords', () => {
    expect(classifySeverity('slow warning')).toBe('medium');
  });

  it('classifies low keywords', () => {
    expect(classifySeverity('minor cosmetic cleanup')).toBe('low');
  });

  it('returns medium for unmatched text', () => {
    expect(classifySeverity('normal text')).toBe('medium');
  });

  it('prioritizes higher severity (critical > high)', () => {
    expect(classifySeverity('crash fails')).toBe('critical');
  });

  it('is case-insensitive', () => {
    expect(classifySeverity('CRASH DATA LOSS')).toBe('critical');
  });
});

describe('extractSymptoms', () => {
  it('extracts symptoms from valid frontmatter', () => {
    const content = `---
title: "Test"
symptoms:
  - "symptom 1"
  - "symptom 2"
---

Body text`;
    expect(extractSymptoms(content)).toEqual(['symptom 1', 'symptom 2']);
  });

  it('returns empty array for missing symptoms', () => {
    const content = `---
title: "No Symptoms"
---

Body text`;
    expect(extractSymptoms(content)).toEqual([]);
  });

  it('returns empty array for non-frontmatter content', () => {
    expect(extractSymptoms('Just plain text')).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(extractSymptoms('')).toEqual([]);
  });

  it('handles symptoms without quotes', () => {
    const content = `---
symptoms:
  - unquoted symptom
---`;
    expect(extractSymptoms(content)).toEqual(['unquoted symptom']);
  });

  it('handles single symptom', () => {
    const content = `---
symptoms:
  - "only one"
---`;
    expect(extractSymptoms(content)).toEqual(['only one']);
  });
});
