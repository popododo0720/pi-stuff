// views/solution-parser.ts — Pure function for parsing solution markdown files.
// Separated from solution-panel.ts to enable testing without vscode module.

import { escapeHtml } from './html-utils';

// ── Types ────────────────────────────────────────────────────────

export interface SolutionItem {
  title: string;
  date: string;
  category: string;
  severity: string;
  tags: string[];
  symptoms: string[];
  rootCause: string;
  prevention: string;
  body: string;
  filePath: string; // relative to workspace
}

// ── Frontmatter parsing (pure function) ──────────────────────────

/**
 * Parse a solution markdown file into a SolutionItem.
 * Uses line-by-line frontmatter boundary detection to avoid
 * confusion with `---` in YAML values or body content.
 */
export function parseSolutionFile(content: string, filePath: string): SolutionItem | null {
  if (!content || !content.startsWith('---')) return null;

  const lines = content.split(/\r?\n/);
  let fmStart = -1;
  let fmEnd = -1;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      if (fmStart < 0) {
        fmStart = i;
      } else {
        fmEnd = i;
        break;
      }
    }
  }

  if (fmStart < 0 || fmEnd < 0) return null;

  const fmLines = lines.slice(fmStart + 1, fmEnd);
  const fm = parseFrontmatterLines(fmLines);

  const body = lines.slice(fmEnd + 1).join('\n').trim();

  return {
    title: fm.title || 'Untitled',
    date: fm.date || '',
    category: fm.category || 'general',
    severity: fm.severity || 'medium',
    tags: fm.tags,
    symptoms: fm.symptoms,
    rootCause: fm.rootCause || '',
    prevention: fm.prevention || '',
    body,
    filePath,
  };
}

// ── Display constants ────────────────────────────────────────────

export const CATEGORY_COLORS: Record<string, string> = {
  'build-errors': '#f85149',
  'performance-issues': '#d29922',
  'runtime-errors': '#f85149',
  'logic-errors': '#e3b341',
  'security-issues': '#a371f7',
  'workflow-issues': '#58a6ff',
  general: '#8b949e',
};

export const SEVERITY_ICONS: Record<string, string> = {
  critical: '🔴',
  high: '🟠',
  medium: '🟡',
  low: '🟢',
};

/**
 * Build the HTML card for a single solution item.
 */
export function buildSolutionCard(s: SolutionItem, index: number): string {
  const catColor = CATEGORY_COLORS[s.category] ?? CATEGORY_COLORS.general;
  const sevIcon = SEVERITY_ICONS[s.severity] ?? '🟡';
  const tagsHtml = s.tags.map(t =>
    `<span class="tag">${escapeHtml(t)}</span>`
  ).join('');

  const metaHtml = [
    s.rootCause ? `<div class="meta-item"><strong>Root Cause:</strong> ${escapeHtml(s.rootCause)}</div>` : '',
    s.prevention ? `<div class="meta-item"><strong>Prevention:</strong> ${escapeHtml(s.prevention)}</div>` : '',
    s.symptoms.length > 0 ? `<div class="meta-item"><strong>Symptoms:</strong> ${s.symptoms.map(sym => escapeHtml(sym)).join(', ')}</div>` : '',
  ].filter(Boolean).join('\n');

  return `
  <details class="solution-card" data-category="${escapeHtml(s.category)}" data-severity="${escapeHtml(s.severity)}" data-search="${escapeHtml((s.title + ' ' + s.tags.join(' ') + ' ' + s.rootCause + ' ' + s.symptoms.join(' ')).toLowerCase())}">
    <summary>
      <span class="sev-icon">${sevIcon}</span>
      <span class="card-title">${escapeHtml(s.title)}</span>
      <span class="card-date">${escapeHtml(s.date)}</span>
      <span class="cat-badge" style="background: ${catColor}30; color: ${catColor};">${escapeHtml(s.category)}</span>
    </summary>
    <div class="card-body">
      ${tagsHtml ? `<div class="tags-row">${tagsHtml}</div>` : ''}
      ${metaHtml}
      ${s.body ? `<pre class="body-content">${escapeHtml(s.body)}</pre>` : ''}
      <div class="file-path">${escapeHtml(s.filePath)}</div>
    </div>
  </details>`;
}

// ── Internal helpers ─────────────────────────────────────────────

interface FrontmatterData {
  title: string;
  date: string;
  category: string;
  severity: string;
  tags: string[];
  symptoms: string[];
  rootCause: string;
  prevention: string;
}

function parseFrontmatterLines(lines: string[]): FrontmatterData {
  const result: FrontmatterData = {
    title: '',
    date: '',
    category: '',
    severity: '',
    tags: [],
    symptoms: [],
    rootCause: '',
    prevention: '',
  };

  let currentListKey: 'symptoms' | null = null;

  for (const line of lines) {
    // Continue list items
    if (currentListKey && /^\s+-\s/.test(line)) {
      const val = line.replace(/^\s+-\s*"?/, '').replace(/"?\s*$/, '');
      if (val) result[currentListKey].push(val);
      continue;
    }
    currentListKey = null;

    // Key-value pairs
    const kvMatch = line.match(/^(\w+):\s*(.*)/);
    if (!kvMatch) continue;

    const key = kvMatch[1];
    let value = kvMatch[2].trim();

    // Remove surrounding quotes
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }

    switch (key) {
      case 'title':
        result.title = value;
        break;
      case 'date':
        result.date = value;
        break;
      case 'category':
        result.category = value;
        break;
      case 'severity':
        result.severity = value;
        break;
      case 'tags': {
        // Inline array: [tag1, tag2, ...]
        const tagMatch = value.match(/^\[([^\]]*)\]/);
        if (tagMatch) {
          result.tags = tagMatch[1].split(',').map(t => t.trim()).filter(Boolean);
        }
        break;
      }
      case 'symptoms':
        // YAML list follows on next lines
        currentListKey = 'symptoms';
        break;
      case 'rootCause':
        result.rootCause = value;
        break;
      case 'prevention':
        result.prevention = value;
        break;
    }
  }

  return result;
}
