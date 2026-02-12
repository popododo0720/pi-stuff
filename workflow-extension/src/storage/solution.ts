// storage/solution.ts — Solution document save and search
// Saves compound learnings to docs/solutions/ for future reference.
// Provides keyword-based search for relevant solutions during planning.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { SOLUTIONS_DIR } from '../constants';
import { toSlug } from './plan';

/** Max characters of solution body to include in prompt context */
const MAX_SOLUTION_BODY = 500;
/** Max number of solutions to include in prompt */
const MAX_SOLUTIONS_IN_CONTEXT = 5;

/**
 * Save a solution document as markdown with frontmatter.
 * Returns the saved file path on success, null on failure.
 */
export function saveSolution(
  cwd: string,
  description: string,
  content: string,
  workflowId: string,
): string | null {
  try {
    const dateStr = new Date().toISOString().slice(0, 10);
    const slug = toSlug(description);
    const dirPath = resolve(join(cwd, SOLUTIONS_DIR));
    if (!existsSync(dirPath)) mkdirSync(dirPath, { recursive: true });
    const filePath = join(dirPath, `${dateStr}-${slug}.md`);
    const frontmatter =
      '---\n' +
      `title: "${description}"\n` +
      `date: ${dateStr}\n` +
      `workflowId: ${workflowId}\n` +
      'type: solution\n' +
      '---\n\n';
    writeFileSync(filePath, frontmatter + content, 'utf-8');
    return filePath;
  } catch {
    return null;
  }
}

/**
 * Search solutions relevant to the given task description.
 * Uses keyword overlap to rank relevance.
 * Returns formatted context string with title + truncated body.
 */
export function findRelevantSolutions(
  cwd: string,
  taskDescription: string,
): string {
  try {
    const dirPath = resolve(join(cwd, SOLUTIONS_DIR));
    if (!existsSync(dirPath)) return '';
    const files = readdirSync(dirPath)
      .filter((f) => f.endsWith('.md'))
      .sort()
      .reverse();

    if (files.length === 0) return '';

    // Extract keywords from task description (3+ char words)
    const keywords = taskDescription
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length >= 3);

    if (keywords.length === 0) {
      // No keywords — just list titles
      const titles = files.slice(0, MAX_SOLUTIONS_IN_CONTEXT).map((f) => {
        const title = extractTitle(dirPath, f);
        return `- ${f.slice(0, 10)}: ${title}`;
      });
      return titles.join('\n');
    }

    // Score each solution by keyword overlap
    const scored = files.map((f) => {
      const fullPath = join(dirPath, f);
      const content = safeRead(fullPath);
      const lower = content.toLowerCase();
      const score = keywords.filter((k) => lower.includes(k)).length;
      const title = extractTitle(dirPath, f);
      const body = extractBody(content);
      return { file: f, title, body, score };
    });

    // Sort by score desc, take top N
    scored.sort((a, b) => b.score - a.score);
    const relevant = scored
      .filter((s) => s.score > 0)
      .slice(0, MAX_SOLUTIONS_IN_CONTEXT);

    if (relevant.length === 0) {
      // No matches — list recent titles only
      const titles = files.slice(0, MAX_SOLUTIONS_IN_CONTEXT).map((f) => {
        const title = extractTitle(dirPath, f);
        return `- ${f.slice(0, 10)}: ${title}`;
      });
      return titles.join('\n');
    }

    // Return title + truncated body for matched solutions
    return relevant
      .map((s) => {
        const truncated =
          s.body.length > MAX_SOLUTION_BODY
            ? `${s.body.slice(0, MAX_SOLUTION_BODY)}...`
            : s.body;
        return `#### ${s.file.slice(0, 10)}: ${s.title}\n${truncated}`;
      })
      .join('\n\n');
  } catch {
    return '';
  }
}

/** Extract title from frontmatter */
function extractTitle(dirPath: string, file: string): string {
  const content = safeRead(join(dirPath, file));
  const match = content.match(/^title:\s*"(.+)"/m);
  return match ? match[1] : file.replace('.md', '');
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
