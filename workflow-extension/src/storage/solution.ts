// storage/solution.ts — Solution document save and search
// Saves compound learnings to docs/solutions/<category>/ for future reference.
// Provides keyword-based search with severity weighting for relevant solutions.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import {
  SEVERITY_KEYWORDS,
  SOLUTION_CATEGORIES,
  SOLUTIONS_DIR,
} from '../constants';
import type { SolutionCategory, SolutionSeverity } from '../types';
import { toSlug } from './plan';

/** Max characters of solution body to include in prompt context */
const MAX_SOLUTION_BODY = 1500;
/** Max number of solutions to include in prompt */
const MAX_SOLUTIONS_IN_CONTEXT = 5;

// ── Classification helpers ───────────────────────────────────────

/**
 * Classify text into a solution category by keyword matching.
 * Returns the category with the most keyword hits, or 'general' as fallback.
 */
export function classifyCategory(text: string): SolutionCategory {
  const lower = text.toLowerCase();
  let best: SolutionCategory = 'general';
  let bestScore = 0;
  for (const [cat, keywords] of Object.entries(SOLUTION_CATEGORIES)) {
    if (cat === 'general') continue;
    const score = keywords.filter((k) => lower.includes(k)).length;
    if (score > bestScore) {
      bestScore = score;
      best = cat as SolutionCategory;
    }
  }
  return best;
}

/**
 * Classify text into a severity level by keyword matching.
 * Checks from critical → low, returns first match or 'medium'.
 */
export function classifySeverity(text: string): SolutionSeverity {
  const lower = text.toLowerCase();
  for (const sev of ['critical', 'high', 'medium', 'low'] as const) {
    if (SEVERITY_KEYWORDS[sev].some((k) => lower.includes(k))) return sev;
  }
  return 'medium';
}

// ── File collection ──────────────────────────────────────────────

/**
 * Collect all .md files from basePath (root) and 1-depth subdirectories.
 * Returns { file: filename, dir: subdirectory or '' for root }.
 */
function collectSolutionFiles(
  basePath: string,
): Array<{ file: string; dir: string }> {
  const results: Array<{ file: string; dir: string }> = [];
  if (!existsSync(basePath)) return results;
  for (const entry of readdirSync(basePath)) {
    const full = join(basePath, entry);
    try {
      const stat = statSync(full);
      if (stat.isFile() && entry.endsWith('.md')) {
        results.push({ file: entry, dir: '' });
      } else if (stat.isDirectory()) {
        for (const sub of readdirSync(full)) {
          if (sub.endsWith('.md')) {
            results.push({ file: sub, dir: entry });
          }
        }
      }
    } catch {
      /* skip unreadable */
    }
  }
  return results;
}

// ── Save ─────────────────────────────────────────────────────────

/**
 * Save a solution document as markdown with enriched frontmatter.
 * Files are stored in docs/solutions/<category>/ subdirectory.
 * Returns the saved file path on success, null on failure.
 */
export function saveSolution(
  cwd: string,
  description: string,
  content: string,
  workflowId: string,
  options?: {
    tags?: string[];
    category?: SolutionCategory;
    severity?: SolutionSeverity;
    symptoms?: string[];
    rootCause?: string;
    prevention?: string;
  },
): string | null {
  try {
    const dateStr = new Date().toISOString().slice(0, 10);
    const slug = toSlug(description);
    const combinedText = `${description} ${content}`;
    const category = options?.category ?? classifyCategory(combinedText);
    const severity = options?.severity ?? classifySeverity(combinedText);
    const tags = options?.tags ?? [];

    const dirPath = resolve(join(cwd, SOLUTIONS_DIR, category));
    if (!existsSync(dirPath)) mkdirSync(dirPath, { recursive: true });

    const filePath = join(dirPath, `${dateStr}-${slug}.md`);
    const safeTitle = description.replace(/"/g, '\\"');

    const frontmatter =
      '---\n' +
      `title: "${safeTitle}"\n` +
      `date: ${dateStr}\n` +
      `workflowId: ${workflowId}\n` +
      'type: solution\n' +
      `category: ${category}\n` +
      `severity: ${severity}\n` +
      (tags.length > 0 ? `tags: [${tags.join(', ')}]\n` : '') +
      (options?.symptoms?.length
        ? `symptoms:\n${options.symptoms.map((s) => `  - "${s.replace(/"/g, '\\"')}"`).join('\n')}\n`
        : '') +
      (options?.rootCause
        ? `rootCause: "${options.rootCause.replace(/"/g, '\\"')}"\n`
        : '') +
      (options?.prevention
        ? `prevention: "${options.prevention.replace(/"/g, '\\"')}"\n`
        : '') +
      '---\n\n';

    writeFileSync(filePath, frontmatter + content, 'utf-8');
    return filePath;
  } catch (e) {
    console.error('[workflow] saveSolution failed:', e);
    return null;
  }
}

// ── Search ───────────────────────────────────────────────────────

/**
 * Search solutions relevant to the given task description.
 * Uses keyword overlap + severity weighting to rank relevance.
 * Scans root + 1-depth subdirectories for backward compat.
 */
export function findRelevantSolutions(
  cwd: string,
  taskDescription: string,
  options?: {
    topK?: number;
    maxBodyChars?: number;
    minScore?: number;
  },
): string {
  try {
    const dirPath = resolve(join(cwd, SOLUTIONS_DIR));
    const allFiles = collectSolutionFiles(dirPath);
    if (allFiles.length === 0) return '';

    // Sort by filename descending (date prefix → most recent first)
    allFiles.sort((a, b) => b.file.localeCompare(a.file));

    const topK = Math.max(1, options?.topK ?? MAX_SOLUTIONS_IN_CONTEXT);
    const maxBodyChars = Math.max(
      100,
      options?.maxBodyChars ?? MAX_SOLUTION_BODY,
    );
    const minScore = Math.max(0, options?.minScore ?? 1);

    const fp = (s: { file: string; dir: string }) =>
      s.dir ? join(dirPath, s.dir, s.file) : join(dirPath, s.file);

    // Extract keywords (2+ chars for acronym matching: SRP, OCP, DIP)
    const keywords = taskDescription
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length >= 2);

    if (keywords.length === 0) {
      return allFiles
        .slice(0, topK)
        .map((s) => {
          const title = extractTitle(fp(s));
          return `- ${s.file.slice(0, 10)}: ${title}`;
        })
        .join('\n');
    }

    // Severity weight — only applied when keyword score > 0
    const sevWeight: Record<string, number> = {
      critical: 5,
      high: 3,
      medium: 0,
      low: 0,
    };

    // Score each solution (tag 3x > title 2x > body 1x + severity bonus)
    const scored = allFiles.map((s) => {
      const fullPath = fp(s);
      const content = safeRead(fullPath);
      const title = extractTitle(fullPath);
      const tags = extractTags(fullPath);
      const titleLower = title.toLowerCase();
      const bodyLower = content.toLowerCase();

      const keywordScore = keywords.reduce((acc, k) => {
        const tagHit = tags.some((t) => t.toLowerCase().includes(k)) ? 3 : 0;
        const titleHit = titleLower.includes(k) ? 2 : 0;
        const bodyHit = bodyLower.includes(k) ? 1 : 0;
        return acc + Math.max(tagHit, titleHit, bodyHit);
      }, 0);

      const sevScore =
        keywordScore > 0 ? (sevWeight[extractSeverity(content)] ?? 0) : 0;
      const score = keywordScore + sevScore;

      const body = extractBody(content);
      return { file: s.file, dir: s.dir, title, body, score };
    });

    scored.sort((a, b) => b.score - a.score);
    const relevant = scored.filter((s) => s.score >= minScore).slice(0, topK);

    if (relevant.length === 0) {
      return allFiles
        .slice(0, topK)
        .map((s) => {
          const title = extractTitle(fp(s));
          return `- ${s.file.slice(0, 10)}: ${title}`;
        })
        .join('\n');
    }

    return relevant
      .map((s) => {
        const truncated =
          s.body.length > maxBodyChars
            ? `${s.body.slice(0, maxBodyChars)}...`
            : s.body;
        return `#### ${s.file.slice(0, 10)}: ${s.title}\n${truncated}`;
      })
      .join('\n\n');
  } catch {
    return '';
  }
}

// ── Frontmatter extraction helpers ───────────────────────────────

/** Extract tags from frontmatter — handles inline array format */
function extractTags(fullPath: string): string[] {
  const content = safeRead(fullPath);
  const match = content.match(/^tags:\s*\[([^\]]*)\]/m);
  if (!match) return [];
  return match[1]
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

/** Extract title from frontmatter */
function extractTitle(fullPath: string): string {
  const content = safeRead(fullPath);
  const match = content.match(/^title:\s*"(.+)"/m);
  return match ? match[1] : fullPath.replace(/^.*\//, '').replace('.md', '');
}

/** Extract severity from frontmatter — handles quoted and unquoted */
function extractSeverity(content: string): string {
  const match = content.match(/^severity:\s*"?(\w+)"?/m);
  return match ? match[1] : 'medium';
}

/** Extract body (after frontmatter) */
function extractBody(content: string): string {
  const endOfFrontmatter = content.indexOf('---', 4);
  if (endOfFrontmatter < 0) return content;
  return content.slice(endOfFrontmatter + 3).trim();
}

/** Safe file read */
function safeRead(path: string): string {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return '';
  }
}

// ── Index ────────────────────────────────────────────────────────

/**
 * Return a brief index of available solutions (date + title + path).
 * Scans root + 1-depth subdirectories for backward compat.
 */
export function findSolutionIndex(cwd: string): string {
  try {
    const dirPath = resolve(join(cwd, SOLUTIONS_DIR));
    const allFiles = collectSolutionFiles(dirPath);
    if (allFiles.length === 0) return '';

    allFiles.sort((a, b) => b.file.localeCompare(a.file));

    return allFiles
      .map(({ file, dir }) => {
        const fullPath = dir ? join(dirPath, dir, file) : join(dirPath, file);
        const title = extractTitle(fullPath);
        const relPath = dir
          ? join(SOLUTIONS_DIR, dir, file)
          : join(SOLUTIONS_DIR, file);
        return `- ${file.slice(0, 10)}: ${title} (${relPath})`;
      })
      .join('\n');
  } catch {
    return '';
  }
}
