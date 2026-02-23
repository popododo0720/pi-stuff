// verification/stack-detect.ts — Tech stack auto-detection
// Detects primary tech stacks from project file markers.
// Used by verification to inject stack-specific review hints.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
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
 * Check if package.json lists typescript as a dependency.
 */
function hasTypeScriptDep(cwd: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf-8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    return 'typescript' in deps;
  } catch {
    return false;
  }
}

/**
 * Check if .ts files exist in src/ or project root (shallow check).
 */
function hasTsFiles(cwd: string): boolean {
  try {
    const checkDirs = [cwd, join(cwd, 'src')];
    for (const dir of checkDirs) {
      if (!existsSync(dir)) continue;
      const files = readdirSync(dir);
      if (files.some((f) => f.endsWith('.ts') || f.endsWith('.tsx'))) return true;
    }
    return false;
  } catch {
    return false;
  }
}

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

  // Secondary TypeScript detection: package.json dep or .ts files present
  // Handles projects without tsconfig.json (e.g. tsx/tsgo direct execution)
  if (!scores.has('typescript')) {
    let tsScore = 0;
    if (hasTypeScriptDep(cwd)) tsScore += 2;
    if (hasTsFiles(cwd)) tsScore += 2;
    if (tsScore > 0) scores.set('typescript', tsScore);
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
