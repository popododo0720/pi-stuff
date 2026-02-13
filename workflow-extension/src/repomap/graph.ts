// repomap/graph.ts — File dependency graph + PageRank
// Builds a directed graph from import relationships and ranks files by importance.

import { dirname, join, posix } from 'node:path';
import type { ParsedFile } from './parser';

// ── Import resolution (JS/TS only) ──────────────────────────────

const JS_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const INDEX_FILES = JS_EXTENSIONS.map((ext) => `index${ext}`);

/**
 * Resolve a relative import specifier to a project-relative POSIX path.
 * Returns null for bare/external specifiers or unresolvable paths.
 */
export function resolveImport(
  specifier: string,
  fromFile: string,
  allFiles: Set<string>,
): string | null {
  // Only resolve relative imports
  if (!specifier.startsWith('.')) return null;

  const fromDir = dirname(fromFile);
  const resolved = posix.normalize(
    join(fromDir, specifier).split('\\').join('/'),
  );

  // Exact match
  if (allFiles.has(resolved)) return resolved;

  // Try appending extensions
  for (const ext of JS_EXTENSIONS) {
    const candidate = resolved + ext;
    if (allFiles.has(candidate)) return candidate;
  }

  // Try as directory with index file
  for (const idx of INDEX_FILES) {
    const candidate = posix.join(resolved, idx);
    if (allFiles.has(candidate)) return candidate;
  }

  return null;
}

// ── Graph construction ───────────────────────────────────────────

/**
 * Build a directed graph: file → set of files it imports.
 * All parsed files are included as nodes (even with no edges).
 */
export function buildGraph(
  files: ParsedFile[],
  allFiles: Set<string>,
): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();

  // Ensure all files are nodes
  for (const f of files) {
    if (!graph.has(f.path)) graph.set(f.path, new Set());
  }

  // Add edges from imports
  for (const file of files) {
    const edges = graph.get(file.path);
    if (!edges) continue;
    for (const spec of file.imports) {
      const target = resolveImport(spec, file.path, allFiles);
      if (target && target !== file.path) {
        edges.add(target);
      }
    }
  }

  return graph;
}

// ── PageRank ─────────────────────────────────────────────────────

/**
 * Compute PageRank scores for files in the graph.
 * Uses standard algorithm with dangling node mass redistribution.
 */
export function pageRank(
  graph: Map<string, Set<string>>,
  damping = 0.85,
  iterations = 20,
): Map<string, number> {
  const nodes = Array.from(graph.keys());
  const n = nodes.length;
  if (n === 0) return new Map();

  // Initialize ranks
  const rank = new Map<string, number>();
  const initialRank = 1 / n;
  for (const node of nodes) {
    rank.set(node, initialRank);
  }

  // Build reverse adjacency for efficient computation
  const inbound = new Map<string, string[]>();
  for (const node of nodes) {
    inbound.set(node, []);
  }
  for (const [from, edges] of graph) {
    for (const to of edges) {
      inbound.get(to)?.push(from);
    }
  }

  const base = (1 - damping) / n;

  for (let iter = 0; iter < iterations; iter++) {
    // Calculate dangling mass (nodes with no outgoing edges)
    let danglingMass = 0;
    for (const [node, edges] of graph) {
      if (edges.size === 0) {
        danglingMass += rank.get(node) ?? 0;
      }
    }
    const danglingDistribution = (damping * danglingMass) / n;

    const newRank = new Map<string, number>();
    for (const node of nodes) {
      let sum = 0;
      const sources = inbound.get(node) ?? [];
      for (const from of sources) {
        const outDegree = graph.get(from)?.size ?? 0;
        if (outDegree > 0) {
          sum += (rank.get(from) ?? 0) / outDegree;
        }
      }
      newRank.set(node, base + damping * sum + danglingDistribution);
    }

    // Update ranks
    for (const [k, v] of newRank) {
      rank.set(k, v);
    }
  }

  return rank;
}
