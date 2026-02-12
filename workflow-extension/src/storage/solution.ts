// storage/solution.ts — Solution document save and list
// Saves compound learnings to docs/solutions/ for future reference.

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
 * List available solution summaries for injection into plan context.
 * Returns a compact list of titles and dates (max 20 most recent).
 */
export function listSolutions(cwd: string): string[] {
  try {
    const dirPath = resolve(join(cwd, SOLUTIONS_DIR));
    if (!existsSync(dirPath)) return [];
    const files = readdirSync(dirPath)
      .filter((f) => f.endsWith('.md'))
      .sort()
      .reverse()
      .slice(0, 20);

    return files.map((f) => {
      try {
        const content = readFileSync(join(dirPath, f), 'utf-8');
        const titleMatch = content.match(/^title:\s*"(.+)"/m);
        const title = titleMatch ? titleMatch[1] : f.replace('.md', '');
        return `- ${f.slice(0, 10)}: ${title}`;
      } catch {
        return `- ${f}`;
      }
    });
  } catch {
    return [];
  }
}
