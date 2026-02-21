// views/verify-panel.ts — Webview panel for displaying verification results

import * as vscode from 'vscode';
import type { WorkflowSession } from '../types/workflow';
import { escapeHtml, getCspMeta, getNonce } from './html-utils';

type Severity = 'critical' | 'warning' | 'info';

interface Section {
  severity: Severity;
  lines: string[];
}

interface DomainResult {
  label: string; // e.g. "anthropic/claude-opus-4-6/Security" or "anthropic/claude-opus-4-6 (Core)"
  status: string; // "PASS", "FAIL", "HALTED", "SKIPPED"
  statusIcon: string;
  sections: Section[];
  verdict: string | null;
  otherLines: string[];
  raw: string;
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
      { enableScripts: true },
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
      { enableScripts: true },
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

    // Try domain-based parsing first (formatted by formatting.ts)
    const domainResults = this.parseDomainResults(verifyResult);

    if (domainResults.length > 0) {
      return this.wrapHtml(nonce, csp, this.renderDomainResults(domainResults));
    }

    // Fallback: legacy single-result parsing
    const { sections, verdict, otherLines } = this.parseResult(verifyResult);

    if (sections.length === 0 && verdict === null) {
      return this.wrapHtml(nonce, csp, `<pre>${escapeHtml(verifyResult)}</pre>`);
    }

    let verdictHtml = '';
    if (verdict) {
      const cls = verdict === 'PASS' ? 'verdict-pass' : 'verdict-fail';
      verdictHtml = `<div class="verdict ${cls}">VERDICT: ${escapeHtml(verdict)}</div>`;
    }

    let sectionsHtml = '';
    for (const section of sections) {
      const items = section.lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('\n');
      sectionsHtml += `<div class="section section-${section.severity}">
        <h3>${section.severity.toUpperCase()} (${section.lines.length})</h3>
        <ul>${items}</ul>
      </div>`;
    }

    const otherHtml = otherLines.length > 0
      ? `<pre class="other">${otherLines.map((l) => escapeHtml(l)).join('\n')}</pre>`
      : '';

    return this.wrapHtml(nonce, csp, `${verdictHtml}${sectionsHtml}${otherHtml}`);
  }

  /**
   * Parse multi-domain verification output.
   * Format from formatting.ts: `## [model/domain] STATUS\n\n<output>`
   * separated by `\n\n---\n\n`
   */
  private parseDomainResults(text: string): DomainResult[] {
    // Split by --- separator
    const blocks = text.split(/\n---\n/).map(b => b.trim()).filter(Boolean);
    if (blocks.length === 0) return [];

    const results: DomainResult[] = [];

    for (const block of blocks) {
      // Match header: ## [label] STATUS (optional suffix)
      const headerMatch = block.match(/^##\s*\[([^\]]+)\]\s*(✅\s*PASS|❌\s*FAIL|⛔\s*(?:HALTED|SKIPPED)\s*(?:\([^)]*\))?)(.*?)$/m);
      if (!headerMatch) continue;

      const label = headerMatch[1];
      const statusRaw = headerMatch[2].trim();
      const suffix = headerMatch[3]?.trim() ?? '';

      let status: string;
      let statusIcon: string;
      if (statusRaw.includes('PASS')) {
        status = 'PASS';
        statusIcon = '✅';
      } else if (statusRaw.includes('FAIL')) {
        status = 'FAIL';
        statusIcon = '❌';
      } else if (statusRaw.includes('HALTED')) {
        status = 'HALTED';
        statusIcon = '⛔';
      } else {
        status = 'SKIPPED';
        statusIcon = '⛔';
      }

      // Body is everything after the header line
      const headerEnd = block.indexOf('\n');
      const body = headerEnd >= 0 ? block.slice(headerEnd + 1).trim() : '';

      const { sections, verdict, otherLines } = this.parseResult(body);

      results.push({
        label: label + (suffix ? ` ${suffix}` : ''),
        status,
        statusIcon,
        sections,
        verdict,
        otherLines,
        raw: body,
      });
    }

    return results;
  }

  /**
   * Render domain-based results as collapsible sections.
   */
  private renderDomainResults(results: DomainResult[]): string {
    // Overall summary
    const passCount = results.filter(r => r.status === 'PASS').length;
    const failCount = results.filter(r => r.status === 'FAIL').length;
    const errorCount = results.filter(r => r.status === 'HALTED' || r.status === 'SKIPPED').length;
    const allPass = failCount === 0 && errorCount === 0;

    let summaryHtml = `<div class="verdict ${allPass ? 'verdict-pass' : 'verdict-fail'}">`;
    summaryHtml += allPass ? 'ALL PASSED' : `${failCount} FAILED`;
    summaryHtml += ` (${passCount}✅ ${failCount}❌ ${errorCount}⛔)`;
    summaryHtml += '</div>';

    let bodyHtml = summaryHtml;

    // Render each result as a collapsible details element
    for (const r of results) {
      const statusCls = r.status === 'PASS' ? 'domain-pass' : r.status === 'FAIL' ? 'domain-fail' : 'domain-error';
      const isCore = !r.label.includes('/') || r.label.split('/').length <= 2;
      const typeTag = isCore ? '<span class="tag tag-core">Core</span>' : '<span class="tag tag-domain">Domain</span>';

      // Auto-open failed/errored results
      const openAttr = r.status !== 'PASS' ? ' open' : '';

      let innerHtml = '';

      // Verdict
      if (r.verdict) {
        const cls = r.verdict === 'PASS' ? 'verdict-pass' : 'verdict-fail';
        innerHtml += `<div class="verdict verdict-small ${cls}">VERDICT: ${escapeHtml(r.verdict)}</div>`;
      }

      // Sections
      for (const section of r.sections) {
        const items = section.lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('\n');
        innerHtml += `<div class="section section-${section.severity}">
          <h4>${section.severity.toUpperCase()} (${section.lines.length})</h4>
          <ul>${items}</ul>
        </div>`;
      }

      // Other lines
      if (r.otherLines.length > 0) {
        innerHtml += `<pre class="other">${r.otherLines.map((l) => escapeHtml(l)).join('\n')}</pre>`;
      }

      // If no structured content, show raw
      if (!innerHtml.trim() && r.raw) {
        innerHtml = `<pre class="other">${escapeHtml(r.raw)}</pre>`;
      }

      bodyHtml += `
      <details class="domain-block ${statusCls}"${openAttr}>
        <summary>${r.statusIcon} ${typeTag} <strong>${escapeHtml(r.label)}</strong></summary>
        <div class="domain-body">${innerHtml}</div>
      </details>`;
    }

    return bodyHtml;
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
        const content = trimmed.replace(/^[-*]\s*/, '');
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
    .verdict-small {
      font-size: 13px;
      padding: 4px 12px;
      margin-bottom: 8px;
    }
    .verdict-pass { background: #2ea04370; color: #3fb950; }
    .verdict-fail { background: #da363470; color: #f85149; }
    .section {
      margin: 8px 0;
      padding: 10px;
      border-radius: 6px;
      border-left: 4px solid;
    }
    .section-critical { border-color: #f85149; background: #f8514910; }
    .section-warning { border-color: #d29922; background: #d2992210; }
    .section-info { border-color: #58a6ff; background: #58a6ff10; }
    .section h3, .section h4 { margin: 0 0 6px 0; font-size: 13px; }
    .section-critical h3, .section-critical h4 { color: #f85149; }
    .section-warning h3, .section-warning h4 { color: #d29922; }
    .section-info h3, .section-info h4 { color: #58a6ff; }
    .section ul { margin: 0; padding-left: 20px; }
    .section li { margin: 3px 0; font-size: 13px; }
    .empty { color: var(--vscode-descriptionForeground); font-style: italic; }
    .other { font-size: 12px; opacity: 0.7; margin-top: 12px; }
    pre { background: var(--vscode-textCodeBlock-background); padding: 10px; border-radius: 6px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; }

    /* Domain result blocks */
    .domain-block {
      margin: 8px 0;
      border: 1px solid var(--vscode-panel-border, #333);
      border-radius: 6px;
      overflow: hidden;
    }
    .domain-block summary {
      padding: 10px 14px;
      cursor: pointer;
      font-size: 13px;
      user-select: none;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .domain-block summary:hover {
      background: var(--vscode-list-hoverBackground, #2a2d2e);
    }
    .domain-pass { border-left: 4px solid #3fb950; }
    .domain-fail { border-left: 4px solid #f85149; }
    .domain-error { border-left: 4px solid #8b949e; }
    .domain-body {
      padding: 8px 14px 14px;
      border-top: 1px solid var(--vscode-panel-border, #333);
    }
    .tag {
      font-size: 11px;
      padding: 1px 6px;
      border-radius: 3px;
      font-weight: 600;
      text-transform: uppercase;
    }
    .tag-core { background: #58a6ff30; color: #58a6ff; }
    .tag-domain { background: #d2992230; color: #d29922; }
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
