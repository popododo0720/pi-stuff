// storage/plan.ts — Plan document auto-save
// Saves approved plans as markdown files in docs/plans/.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Convert text to a URL-friendly slug.
 * Supports alphanumeric, Korean, hyphens.
 */
export function toSlug(text: string): string {
  return (
    text
      .slice(0, 50)
      .trim()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-')
      .toLowerCase() || 'plan'
  );
}

/**
 * Save a plan document as markdown with frontmatter.
 * Returns the saved file path on success, null on failure.
 */
export function savePlanDocument(
  cwd: string,
  description: string,
  content: string,
): string | null {
  try {
    const dateStr = new Date().toISOString().slice(0, 10);
    const slug = toSlug(description);
    const dirPath = resolve(join(cwd, 'docs', 'plans'));
    if (!existsSync(dirPath)) mkdirSync(dirPath, { recursive: true });
    const filePath = join(dirPath, `${dateStr}-${slug}.md`);
    const frontmatter =
      `---\ntitle: "${description}"\ndate: ${dateStr}\n` +
      `workflow: true\n---\n\n`;
    writeFileSync(filePath, frontmatter + content, 'utf-8');
    return filePath;
  } catch (e) {
    console.error('[workflow] savePlan failed:', e);
    return null;
  }
}
