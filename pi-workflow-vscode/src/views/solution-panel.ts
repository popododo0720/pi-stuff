// views/solution-panel.ts — WebviewPanel for browsing docs/solutions/ learnings
// Intentionally duplicates file-walking logic from workflow-extension/src/storage/solution.ts
// because the VSCode extension cannot import from workflow-extension (different runtime).

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as vscode from 'vscode';
import { escapeHtml, getNonce } from './html-utils';

const SOLUTIONS_DIR = 'docs/solutions';

// ── Types ────────────────────────────────────────────────────────

interface SolutionItem {
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

// ── Frontmatter parsing (pure function, exported for testing) ────

/**
 * Parse a solution markdown file into a SolutionItem.
 * Uses line-by-line frontmatter boundary detection to avoid
 * confusion with `---` in YAML values or body content.
 * @internal — exported for testing
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

// ── Category / Severity display ──────────────────────────────────

const CATEGORY_COLORS: Record<string, string> = {
  'build-errors': '#f85149',
  'performance-issues': '#d29922',
  'runtime-errors': '#f85149',
  'logic-errors': '#e3b341',
  'security-issues': '#a371f7',
  'workflow-issues': '#58a6ff',
  general: '#8b949e',
};

const SEVERITY_ICONS: Record<string, string> = {
  critical: '🔴',
  high: '🟠',
  medium: '🟡',
  low: '🟢',
};

// ── Panel class ──────────────────────────────────────────────────

export class SolutionPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;

  constructor(private readonly workspaceRoot: string) {}

  show(): void {
    const solutions = this.loadSolutions();

    if (this.panel) {
      this.panel.reveal();
      this.panel.webview.html = this.getHtml(solutions);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'piSolutions',
      'Pi: Solution Browser',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: false },
    );

    this.panel.webview.html = this.getHtml(solutions);

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });
  }

  /**
   * Walk docs/solutions/ recursively (root + 1-depth subdirs).
   * Same traversal pattern as workflow-extension collectSolutionFiles().
   */
  private loadSolutions(): SolutionItem[] {
    const basePath = join(this.workspaceRoot, SOLUTIONS_DIR);
    if (!existsSync(basePath)) return [];

    const items: SolutionItem[] = [];

    try {
      for (const entry of readdirSync(basePath)) {
        const full = join(basePath, entry);
        try {
          const stat = statSync(full);
          if (stat.isFile() && entry.endsWith('.md')) {
            const content = readFileSync(full, 'utf-8');
            const relPath = relative(this.workspaceRoot, full);
            const item = parseSolutionFile(content, relPath);
            if (item) items.push(item);
          } else if (stat.isDirectory()) {
            // 1-depth subdirectory
            for (const sub of readdirSync(full)) {
              if (!sub.endsWith('.md')) continue;
              const subFull = join(full, sub);
              try {
                const content = readFileSync(subFull, 'utf-8');
                const relPath = relative(this.workspaceRoot, subFull);
                const item = parseSolutionFile(content, relPath);
                if (item) {
                  // Infer category from directory name if not in frontmatter
                  if (!item.category || item.category === 'general') {
                    item.category = entry;
                  }
                  items.push(item);
                }
              } catch { /* skip unreadable */ }
            }
          }
        } catch { /* skip unreadable */ }
      }
    } catch { /* empty */ }

    // Sort by date descending
    items.sort((a, b) => b.date.localeCompare(a.date));
    return items;
  }

  private getHtml(solutions: SolutionItem[]): string {
    const nonce = getNonce();

    // Collect unique categories
    const categories = [...new Set(solutions.map(s => s.category))].sort();

    // Build solution cards
    const cardsHtml = solutions.map((s, i) => {
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
      <details class="solution-card" data-index="${i}" data-category="${escapeHtml(s.category)}" data-severity="${escapeHtml(s.severity)}" data-search="${escapeHtml((s.title + ' ' + s.tags.join(' ') + ' ' + s.rootCause + ' ' + s.symptoms.join(' ')).toLowerCase())}">
        <summary>
          <span class="sev-icon">${sevIcon}</span>
          <span class="card-title">${escapeHtml(s.title)}</span>
          <span class="card-date">${escapeHtml(s.date)}</span>
          <span class="cat-badge" style="background: ${catColor}30; color: ${catColor};">${escapeHtml(s.category)}</span>
        </summary>
        <div class="card-body">
          ${tagsHtml ? `<div class="tags-row">${tagsHtml}</div>` : ''}
          ${metaHtml}
          ${s.body ? `<pre class="body-preview">${escapeHtml(s.body)}</pre>` : ''}
          <div class="file-path">${escapeHtml(s.filePath)}</div>
        </div>
      </details>`;
    }).join('\n');

    const categoryOptions = categories.map(c =>
      `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`
    ).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      padding: 16px 24px;
      line-height: 1.6;
    }
    h1 { font-size: 1.4em; margin-bottom: 16px; border-bottom: 1px solid var(--vscode-panel-border, transparent); padding-bottom: 8px; }
    .filter-bar {
      display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; align-items: center;
    }
    .filter-bar input[type="text"] {
      flex: 1; min-width: 200px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 4px; padding: 6px 10px; font-size: 13px; outline: none;
    }
    .filter-bar input:focus, .filter-bar select:focus {
      border-color: var(--vscode-focusBorder, #007fd4);
    }
    .filter-bar select {
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border: 1px solid var(--vscode-dropdown-border, transparent);
      border-radius: 4px; padding: 6px 8px; font-size: 13px; outline: none;
    }
    .count-badge {
      font-size: 12px; color: var(--vscode-descriptionForeground);
      padding: 4px 8px;
    }
    .solution-card {
      margin: 6px 0;
      border: 1px solid var(--vscode-panel-border, #333);
      border-radius: 6px;
      overflow: hidden;
    }
    .solution-card.hidden { display: none; }
    .solution-card summary {
      padding: 10px 14px;
      cursor: pointer;
      font-size: 13px;
      user-select: none;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .solution-card summary:hover {
      background: var(--vscode-list-hoverBackground, #2a2d2e);
    }
    .sev-icon { font-size: 14px; flex-shrink: 0; }
    .card-title { font-weight: 600; flex: 1; }
    .card-date { font-size: 12px; color: var(--vscode-descriptionForeground); flex-shrink: 0; }
    .cat-badge {
      font-size: 11px; padding: 1px 8px; border-radius: 3px;
      font-weight: 600; text-transform: lowercase; flex-shrink: 0;
    }
    .card-body {
      padding: 10px 14px 14px;
      border-top: 1px solid var(--vscode-panel-border, #333);
    }
    .tags-row { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 8px; }
    .tag {
      font-size: 11px; padding: 2px 8px; border-radius: 10px;
      background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
    }
    .meta-item { font-size: 13px; margin: 4px 0; }
    .meta-item strong { color: var(--vscode-descriptionForeground); }
    .body-preview {
      font-size: 12px; margin-top: 8px;
      background: var(--vscode-textCodeBlock-background);
      padding: 8px; border-radius: 4px;
      white-space: pre-wrap; word-break: break-word;
      max-height: 200px; overflow-y: auto;
    }
    .file-path {
      font-size: 11px; color: var(--vscode-descriptionForeground);
      margin-top: 6px; font-style: italic;
    }
    .empty-state {
      text-align: center; padding: 40px 20px;
      color: var(--vscode-descriptionForeground); font-style: italic;
    }
  </style>
</head>
<body>
  <h1>📚 Solution Browser</h1>

  <div class="filter-bar">
    <input type="text" id="search" placeholder="Search solutions..." />
    <select id="category-filter">
      <option value="">All Categories</option>
      ${categoryOptions}
    </select>
    <select id="severity-filter">
      <option value="">All Severities</option>
      <option value="critical">🔴 Critical</option>
      <option value="high">🟠 High</option>
      <option value="medium">🟡 Medium</option>
      <option value="low">🟢 Low</option>
    </select>
    <span class="count-badge" id="count-badge">${solutions.length} solutions</span>
  </div>

  <div id="cards">
    ${solutions.length > 0 ? cardsHtml : '<div class="empty-state">No solutions found in docs/solutions/</div>'}
  </div>

  <script nonce="${nonce}">
    const searchInput = document.getElementById('search');
    const categorySelect = document.getElementById('category-filter');
    const severitySelect = document.getElementById('severity-filter');
    const countBadge = document.getElementById('count-badge');
    const cards = document.querySelectorAll('.solution-card');

    function filterSolutions() {
      const query = (searchInput.value || '').toLowerCase();
      const cat = categorySelect.value;
      const sev = severitySelect.value;
      let visible = 0;

      cards.forEach(card => {
        const matchSearch = !query || card.dataset.search.includes(query);
        const matchCat = !cat || card.dataset.category === cat;
        const matchSev = !sev || card.dataset.severity === sev;

        if (matchSearch && matchCat && matchSev) {
          card.classList.remove('hidden');
          visible++;
        } else {
          card.classList.add('hidden');
        }
      });

      countBadge.textContent = visible + ' of ${solutions.length} solutions';
    }

    searchInput.addEventListener('input', filterSolutions);
    categorySelect.addEventListener('change', filterSolutions);
    severitySelect.addEventListener('change', filterSolutions);
  </script>
</body>
</html>`;
  }

  dispose(): void {
    this.panel?.dispose();
  }
}
