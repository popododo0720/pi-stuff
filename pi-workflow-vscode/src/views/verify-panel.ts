// views/verify-panel.ts — Webview panel for displaying verification results

import * as vscode from 'vscode';
import type { WorkflowSession } from '../types/workflow';
import { escapeHtml, getCspMeta, getNonce } from './html-utils';

type Severity = 'critical' | 'warning' | 'info';

interface Section {
  severity: Severity;
  lines: string[];
}

export class VerifyPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;

  show(session: WorkflowSession): void {
    if (this.panel) {
      this.panel.reveal();
      this.panel.webview.html = this.getHtml(session.verifyPlanResult);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'piVerify',
      'Pi: Verification',
      vscode.ViewColumn.Beside,
      { enableScripts: false },
    );

    this.panel.webview.html = this.getHtml(session.verifyPlanResult);

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });
  }

  showText(title: string, text: string): void {
    if (this.panel) {
      this.panel.reveal();
      this.panel.title = title;
      this.panel.webview.html = this.getHtml(text);
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      'piVerify',
      title,
      vscode.ViewColumn.Beside,
      { enableScripts: false },
    );
    this.panel.webview.html = this.getHtml(text);
    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });
  }

  update(session: WorkflowSession | null): void {
    if (!this.panel) return;
    if (!session) {
      this.panel.webview.html = this.getHtml('');
      return;
    }
    this.panel.webview.html = this.getHtml(session.verifyPlanResult);
  }

  private getHtml(verifyResult: string): string {
    const nonce = getNonce();
    const csp = getCspMeta(nonce);

    if (!verifyResult.trim()) {
      return this.wrapHtml(nonce, csp, '<p class="empty">No verification results available.</p>');
    }

    const { sections, verdict, otherLines } = this.parseResult(verifyResult);

    // Fallback: if parsing found no structure, show raw text
    if (sections.length === 0 && verdict === null) {
      return this.wrapHtml(nonce, csp, `<pre>${escapeHtml(verifyResult)}</pre>`);
    }

    // Verdict badge
    let verdictHtml = '';
    if (verdict) {
      const cls = verdict === 'PASS' ? 'verdict-pass' : 'verdict-fail';
      verdictHtml = `<div class="verdict ${cls}">VERDICT: ${escapeHtml(verdict)}</div>`;
    }

    // Sections
    let sectionsHtml = '';
    for (const section of sections) {
      const items = section.lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('\n');
      sectionsHtml += `<div class="section section-${section.severity}">
        <h3>${section.severity.toUpperCase()} (${section.lines.length})</h3>
        <ul>${items}</ul>
      </div>`;
    }

    // Other lines (non-section text)
    const otherHtml = otherLines.length > 0
      ? `<pre class="other">${otherLines.map((l) => escapeHtml(l)).join('\n')}</pre>`
      : '';

    return this.wrapHtml(nonce, csp, `${verdictHtml}${sectionsHtml}${otherHtml}`);
  }

  /**
   * Parse verification result text into sections.
   * Format: ## CRITICAL / ## WARNING / ## INFO headers, VERDICT: PASS|FAIL
   */
  private parseResult(text: string): {
    sections: Section[];
    verdict: string | null;
    otherLines: string[];
  } {
    const lines = text.split('\n');
    const sections: Section[] = [];
    const otherLines: string[] = [];
    let currentSection: Section | null = null;
    let verdict: string | null = null;

    for (const line of lines) {
      const trimmed = line.trim();

      // Verdict detection
      if (trimmed.startsWith('VERDICT:')) {
        const v = trimmed.slice('VERDICT:'.length).trim();
        if (v === 'PASS' || v === 'FAIL') {
          verdict = v;
          continue;
        }
        // Non-standard verdict → treat as regular line
        otherLines.push(line);
        continue;
      }

      // Section headers
      if (trimmed === '## CRITICAL') {
        currentSection = { severity: 'critical', lines: [] };
        sections.push(currentSection);
        continue;
      }
      if (trimmed === '## WARNING') {
        currentSection = { severity: 'warning', lines: [] };
        sections.push(currentSection);
        continue;
      }
      if (trimmed === '## INFO') {
        currentSection = { severity: 'info', lines: [] };
        sections.push(currentSection);
        continue;
      }

      // New non-severity heading ends current section
      if (trimmed.startsWith('## ') || trimmed.startsWith('# ')) {
        currentSection = null;
        otherLines.push(line);
        continue;
      }

      // Content lines
      if (currentSection) {
        const content = trimmed.replace(/^[-*]\s*/, ''); // Strip bullet
        if (content && content !== 'None') {
          currentSection.lines.push(content);
        }
      } else if (trimmed) {
        otherLines.push(line);
      }
    }

    return { sections, verdict, otherLines };
  }

  private wrapHtml(nonce: string, csp: string, body: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${csp}
  <style nonce="${nonce}">
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      padding: 16px;
      line-height: 1.6;
    }
    .verdict {
      display: inline-block;
      padding: 8px 20px;
      border-radius: 6px;
      font-size: 16px;
      font-weight: bold;
      margin-bottom: 16px;
    }
    .verdict-pass { background: #2ea04370; color: #3fb950; }
    .verdict-fail { background: #da363470; color: #f85149; }
    .section {
      margin: 12px 0;
      padding: 12px;
      border-radius: 6px;
      border-left: 4px solid;
    }
    .section-critical { border-color: #f85149; background: #f8514910; }
    .section-warning { border-color: #d29922; background: #d2992210; }
    .section-info { border-color: #58a6ff; background: #58a6ff10; }
    .section h3 { margin: 0 0 8px 0; font-size: 14px; }
    .section-critical h3 { color: #f85149; }
    .section-warning h3 { color: #d29922; }
    .section-info h3 { color: #58a6ff; }
    .section ul { margin: 0; padding-left: 20px; }
    .section li { margin: 4px 0; font-size: 13px; }
    .empty { color: var(--vscode-descriptionForeground); font-style: italic; }
    .other { font-size: 12px; opacity: 0.7; margin-top: 16px; }
    pre { background: var(--vscode-textCodeBlock-background); padding: 12px; border-radius: 6px; overflow-x: auto; }
  </style>
</head>
<body>
  ${body}
</body>
</html>`;
  }

  dispose(): void {
    this.panel?.dispose();
  }
}
