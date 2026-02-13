// repomap/index.ts — Main entry point for repo map generation
// Collects files, parses ASTs, builds graph, ranks, and renders text output.

import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildGraph, pageRank } from './graph';
import { getSupportedExtensions, parseFile } from './parser';

// ── Constants ────────────────────────────────────────────────────

const MAX_FILES = 500;
const DEFAULT_TOKEN_BUDGET = 2048;
const CHARS_PER_TOKEN = 4;
const CACHE_TTL_MS = 30_000;

const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '__pycache__',
  '.venv',
  'venv',
  'vendor',
  '.pi',
  '.cache',
  'coverage',
  '.turbo',
]);

// ── File collection ──────────────────────────────────────────────

function collectFiles(cwd: string, maxFiles = MAX_FILES): string[] {
  const supportedExts = getSupportedExtensions();
  const files: string[] = [];

  function walk(dir: string): void {
    if (files.length >= maxFiles) return;

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (files.length >= maxFiles) return;

      const fullPath = join(dir, entry);

      try {
        const stat = lstatSync(fullPath);

        // Skip symlinks
        if (stat.isSymbolicLink()) continue;

        if (stat.isDirectory()) {
          if (!EXCLUDED_DIRS.has(entry) && !entry.startsWith('.')) {
            walk(fullPath);
          }
        } else if (stat.isFile()) {
          const ext =
            entry.lastIndexOf('.') >= 0
              ? entry.slice(entry.lastIndexOf('.')).toLowerCase()
              : '';
          if (supportedExts.has(ext)) {
            files.push(fullPath);
          }
        }
      } catch {
        // Skip inaccessible files
      }
    }
  }

  walk(cwd);
  return files;
}

// ── Cache ────────────────────────────────────────────────────────

let cache: { key: string; result: string; timestamp: number } | null = null;

function getCached(key: string): string | null {
  if (
    cache &&
    cache.key === key &&
    Date.now() - cache.timestamp < CACHE_TTL_MS
  ) {
    return cache.result;
  }
  return null;
}

function setCache(key: string, result: string): void {
  cache = { key, result, timestamp: Date.now() };
}

// ── Render ───────────────────────────────────────────────────────

function renderRepoMap(
  rankedFiles: Array<{
    path: string;
    symbols: Array<{ name: string; kind: string; line: number }>;
  }>,
  tokenBudget: number,
): string {
  const maxChars = tokenBudget * CHARS_PER_TOKEN;
  const lines: string[] = [];
  let totalChars = 0;

  for (const file of rankedFiles) {
    const headerLine = file.path;
    const symbolLines = file.symbols.map((s) => `│ ${s.kind} ${s.name}`);

    // Calculate cost of adding this file
    const fileCost =
      headerLine.length +
      1 +
      symbolLines.reduce((sum, l) => sum + l.length + 1, 0);

    if (totalChars + fileCost > maxChars && lines.length > 0) break;

    lines.push(headerLine);
    for (const sl of symbolLines) {
      lines.push(sl);
    }
    totalChars += fileCost;
  }

  return lines.join('\n');
}

// ── Main API ─────────────────────────────────────────────────────

/**
 * Generate a repo map string for the given project directory.
 * Returns empty string on failure (graceful degradation).
 *
 * @param cwd Project root directory
 * @param tokenBudget Approximate token budget for the output
 */
export async function generateRepoMap(
  cwd: string,
  tokenBudget = DEFAULT_TOKEN_BUDGET,
): Promise<string> {
  try {
    const cacheKey = `${cwd}:${tokenBudget}`;
    const cached = getCached(cacheKey);
    if (cached !== null) return cached;

    // Collect files
    const filePaths = collectFiles(cwd);
    if (filePaths.length === 0) return '';

    // Parse all files in parallel
    const parseResults = await Promise.all(
      filePaths.map((fp) => parseFile(fp, cwd)),
    );
    const parsedFiles = parseResults.filter(
      (r): r is NonNullable<typeof r> => r !== null,
    );
    if (parsedFiles.length === 0) return '';

    // Build file path set (project-relative POSIX)
    const allFilePaths = new Set(parsedFiles.map((f) => f.path));

    // Build graph and compute PageRank
    const graph = buildGraph(parsedFiles, allFilePaths);
    const ranks = pageRank(graph);

    // Sort by rank (descending)
    const ranked = parsedFiles
      .map((f) => ({
        path: f.path,
        symbols: f.symbols,
        rank: ranks.get(f.path) ?? 0,
      }))
      .sort((a, b) => b.rank - a.rank);

    // Render within token budget
    const result = renderRepoMap(ranked, tokenBudget);
    setCache(cacheKey, result);
    return result;
  } catch {
    return '';
  }
}
