// views/solution-panel.ts — WebviewPanel for browsing docs/solutions/ learnings
// Intentionally duplicates file-walking logic from workflow-extension/src/storage/solution.ts
// because the VSCode extension cannot import from workflow-extension (different runtime).

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as vscode from 'vscode';
import { escapeHtml, getNonce } from './html-utils';
import {
  type SolutionItem,
  CATEGORY_COLORS,
  SEVERITY_ICONS,
  buildSolutionCard,
  parseSolutionFile,
} from './solution-parser';

const SOLUTIONS_DIR = 'docs/solutions';

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
      { enableScripts: true },
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
    const cardsHtml = solutions.map((s, i) => buildSolutionCard(s, i)).join('\n');

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
    .body-content {
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
