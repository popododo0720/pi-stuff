// verification/stack-detect.ts — Tech stack auto-detection
// Detects primary tech stacks from project file markers.
// Used by verification to inject stack-specific review hints.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type TechStack =
  | 'typescript'
  | 'python'
  | 'ruby'
  | 'java'
  | 'go'
  | 'rust'
  | 'general';

interface StackMarker {
  stack: TechStack;
  /** Files whose existence indicates this stack */
  files: string[];
  /** Weight — higher means stronger signal */
  weight: number;
}

const MARKERS: StackMarker[] = [
  {
    stack: 'typescript',
    files: ['tsconfig.json', 'tsconfig.base.json'],
    weight: 3,
  },
  {
    stack: 'python',
    files: [
      'requirements.txt',
      'pyproject.toml',
      'setup.py',
      'Pipfile',
      'poetry.lock',
    ],
    weight: 3,
  },
  {
    stack: 'ruby',
    files: ['Gemfile', 'Rakefile', '.ruby-version'],
    weight: 3,
  },
  {
    stack: 'java',
    files: ['pom.xml', 'build.gradle', 'build.gradle.kts'],
    weight: 3,
  },
  { stack: 'go', files: ['go.mod', 'go.sum'], weight: 3 },
  { stack: 'rust', files: ['Cargo.toml', 'Cargo.lock'], weight: 3 },
];

const STACK_HINTS: Record<TechStack, string> = {
  typescript:
    'TypeScript project — check strict mode compliance, type safety, ' +
    'import ordering (type imports first), null/undefined handling.',
  python:
    'Python project — check type hints, PEP 8 style, ' +
    'virtual environment usage, dependency management.',
  ruby:
    'Ruby project — check Gemfile dependencies, ' +
    'RuboCop compliance, convention over configuration patterns.',
  java:
    'Java project — check Maven/Gradle build config, ' +
    'null safety, checked exceptions, SOLID principles.',
  go:
    'Go project — check error handling (no ignored errors), ' +
    'goroutine safety, module dependencies.',
  rust:
    'Rust project — check ownership/borrowing, ' +
    'error handling (Result/Option), unsafe blocks.',
  general: '',
};

/**
 * Detect tech stacks from project file markers.
 * Returns detected stacks sorted by weight (strongest first).
 * Falls back to ['general'] if nothing detected.
 */
export function detectStack(cwd: string): TechStack[] {
  const scores = new Map<TechStack, number>();

  for (const marker of MARKERS) {
    const hits = marker.files.filter((f) => existsSync(join(cwd, f))).length;
    if (hits > 0) {
      scores.set(
        marker.stack,
        (scores.get(marker.stack) ?? 0) + hits * marker.weight,
      );
    }
  }

  if (scores.size === 0) return ['general'];

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([stack]) => stack);
}

/**
 * Get stack-specific verification hints for detected stacks.
 * Accepts pre-detected stack array from detectStack().
 */
export function getStackHint(stacks: TechStack[]): string {
  const hints = stacks.map((s) => STACK_HINTS[s]).filter((h) => h.length > 0);
  return hints.length > 0 ? hints.join('\n') : '';
}
