// views/plan-panel.ts — Webview panel for displaying the workflow plan

import * as vscode from 'vscode';
import type { WorkflowSession } from '../types/workflow';
import { getCspMeta, getNonce, markdownToHtml } from './html-utils';

export class PlanPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;

  show(session: WorkflowSession): void {
    if (this.panel) {
      this.panel.reveal();
      this.panel.webview.html = this.getHtml(
        session.planContent,
        session.activeTodoIndex,
        session.todos,
      );
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'piPlan',
      'Pi: Plan',
      vscode.ViewColumn.Beside,
      { enableScripts: false },
    );

    this.panel.webview.html = this.getHtml(
      session.planContent,
      session.activeTodoIndex,
      session.todos,
    );

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });
  }

  update(session: WorkflowSession | null): void {
    if (!this.panel) return;
    if (!session) {
      this.panel.webview.html = this.getHtml('No active workflow.', -1, []);
      return;
    }
    this.panel.webview.html = this.getHtml(
      session.planContent,
      session.activeTodoIndex,
      session.todos,
    );
  }

  private getHtml(
    planContent: string,
    activeTodoIndex: number,
    todos: WorkflowSession['todos'],
  ): string {
    const nonce = getNonce();
    const csp = getCspMeta(nonce);

    // TODO progress badge
    const doneCount = todos.filter((t) => t.status === 'done').length;
    const totalCount = todos.length;
    const progressBadge =
      totalCount > 0
        ? `<div class="progress-badge">TODO Progress: ✅ ${doneCount} / ${totalCount}</div>`
        : '';

    // Convert markdown to HTML
    let html = markdownToHtml(planContent || 'No plan content available.');

    // Highlight active TODO section (word boundary to avoid #1 matching #10)
    if (activeTodoIndex >= 0) {
      const todoNum = activeTodoIndex + 1;
      const marker = escapeForRegex(`TODO #${todoNum}`);
      html = html.replace(
        new RegExp(`(<h[12]>)(.*?${marker}(?!\\d).*?)(</h[12]>)`),
        '$1<span class="active-marker">▶</span> $2$3<div class="active-section-start"></div>',
      );
    }

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
    .progress-badge {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 12px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      font-size: 13px;
      margin-bottom: 16px;
    }
    h1 { font-size: 1.6em; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 8px; }
    h2 { font-size: 1.3em; margin-top: 24px; }
    h3 { font-size: 1.1em; margin-top: 16px; }
    pre {
      background: var(--vscode-textCodeBlock-background);
      padding: 12px;
      border-radius: 6px;
      overflow-x: auto;
      font-size: 13px;
    }
    code {
      font-family: var(--vscode-editor-font-family);
      font-size: 0.9em;
    }
    p code, li code {
      background: var(--vscode-textCodeBlock-background);
      padding: 2px 5px;
      border-radius: 3px;
    }
    li { margin: 4px 0; list-style: disc; margin-left: 20px; }
    .active-marker { color: var(--vscode-focusBorder); font-weight: bold; }
    .active-section-start {
      border-left: 3px solid var(--vscode-focusBorder);
      margin-left: -19px;
      padding-left: 16px;
    }
  </style>
</head>
<body>
  ${progressBadge}
  ${html}
</body>
</html>`;
  }

  dispose(): void {
    this.panel?.dispose();
  }
}

function escapeForRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
