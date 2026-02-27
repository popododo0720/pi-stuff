// views/plan-panel.ts — Webview panel for displaying and editing the workflow plan
// Dual-mode: read-only view (default) + edit mode (verifyPlan state only).
// Edit mode uses raw JSON pattern (like rollbackTodo) to preserve all session fields.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { WorkflowSession, WorkflowState } from '../types/workflow';
import { escapeHtml, getCspMeta, getNonce, markdownToHtml } from './html-utils';

/** Only session IDs matching this pattern may be used in file paths. */
const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;

export class PlanPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private currentSessionId: string | null = null;

  constructor(private readonly workspaceRoot: string) {}

  show(session: WorkflowSession): void {
    this.currentSessionId = session.id;

    if (this.panel) {
      this.panel.reveal();
      this.panel.webview.html = this.getHtml(
        session.planContent,
        session.activeTodoIndex,
        session.todos,
        session.state,
        session.retryCount,
      );
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'piPlan',
      'Pi: Plan',
      vscode.ViewColumn.Beside,
      { enableScripts: true },
    );

    this.panel.webview.html = this.getHtml(
      session.planContent,
      session.activeTodoIndex,
      session.todos,
      session.state,
      session.retryCount,
    );

    this.panel.webview.onDidReceiveMessage((msg: { type: string; content?: string }) => {
      if (msg.type === 'saveDraft' && typeof msg.content === 'string') {
        this.saveDraft(msg.content);
      }
    });

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });
  }

  update(session: WorkflowSession | null): void {
    if (!this.panel) return;
    this.currentSessionId = session?.id ?? null;
    if (!session) {
      this.panel.webview.html = this.getHtml(
        'No active workflow.',
        -1,
        [],
        'plan' as WorkflowState,
        0,
      );
      return;
    }
    this.panel.webview.html = this.getHtml(
      session.planContent,
      session.activeTodoIndex,
      session.todos,
      session.state,
      session.retryCount,
    );
  }

  /** Whether the plan panel is currently open. */
  isVisible(): boolean {
    return this.panel !== undefined;
  }

  /**
   * Save edited plan content to the session file.
   * Uses raw JSON read+modify pattern (same as rollbackTodo in extension.ts)
   * to preserve workflow-extension-only fields that parseSession would drop.
   * Also checks state at write time to prevent TOCTOU race.
   */
  private saveDraft(content: string): void {
    if (!this.currentSessionId || !SAFE_ID_RE.test(this.currentSessionId)) {
      return;
    }

    const filePath = join(
      this.workspaceRoot,
      '.pi',
      'workflows',
      `${this.currentSessionId}.json`,
    );

    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf-8'));

      // TOCTOU guard: only allow save when session is still in verifyPlan state
      if (raw.state !== 'verifyPlan') {
        vscode.window.showWarningMessage(
          'Plan can only be edited during verification stage.',
        );
        return;
      }

      // Modify planContent only — preserve all other fields untouched
      raw.planContent = content;
      writeFileSync(filePath, JSON.stringify(raw, null, '\t'), 'utf-8');
      vscode.window.showInformationMessage('Plan draft saved.');
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to save plan draft: ${err}`);
    }
  }

  private getHtml(
    planContent: string,
    activeTodoIndex: number,
    todos: WorkflowSession['todos'],
    state: WorkflowState,
    retryCount: number,
  ): string {
    const nonce = getNonce();
    const csp = getCspMeta(nonce, { scripts: true });
    const isEditable = state === 'verifyPlan';

    // TODO progress badge
    const doneCount = todos.filter((t) => t.status === 'done').length;
    const totalCount = todos.length;
    const progressBadge =
      totalCount > 0
        ? `<div class="progress-badge">TODO Progress: ✅ ${doneCount} / ${totalCount}</div>`
        : '';

    // Convert markdown to HTML for preview
    let previewHtml = markdownToHtml(planContent || 'No plan content available.');

    // Highlight active TODO section (word boundary to avoid #1 matching #10)
    if (activeTodoIndex >= 0) {
      const todoNum = activeTodoIndex + 1;
      const marker = escapeForRegex(`TODO #${todoNum}`);
      previewHtml = previewHtml.replace(
        new RegExp(`(<h[12]>)(.*?${marker}(?!\\d).*?)(</h[12]>)`),
        '$1<span class="active-marker">▶</span> $2$3<div class="active-section-start"></div>',
      );
    }

    // Edit mode toolbar + content
    const editToolbar = isEditable
      ? `<div class="editor-toolbar">
          <button class="tab-btn active" data-tab="preview">Preview</button>
          <button class="tab-btn" data-tab="edit">Edit</button>
        </div>`
      : '';

    const editPanel = isEditable
      ? `<div class="tab-content hidden" id="tab-edit">
          <textarea id="plan-editor" class="plan-textarea">${escapeHtml(planContent || '')}</textarea>
        </div>`
      : '';

    const saveBar = isEditable
      ? `<div class="save-bar">
          <button class="save-btn" id="save-btn">Save Draft</button>
        </div>`
      : '';

    const previewClass = isEditable ? 'tab-content' : '';
    const previewId = isEditable ? ' id="tab-preview"' : '';

    const script = isEditable
      ? `<script nonce="${nonce}">
      const vscode = acquireVsCodeApi();

      // Tab switching
      document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
          document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
          btn.classList.add('active');
          const tabId = 'tab-' + btn.getAttribute('data-tab');
          const tabEl = document.getElementById(tabId);
          if (tabEl) tabEl.classList.remove('hidden');
        });
      });

      // Save Draft
      const saveBtn = document.getElementById('save-btn');
      if (saveBtn) {
        saveBtn.addEventListener('click', () => {
          const editor = document.getElementById('plan-editor');
          if (editor) {
            vscode.postMessage({ type: 'saveDraft', content: editor.value });
          }
        });
      }
    </script>`
      : '';

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
    /* Editor mode styles */
    .editor-toolbar {
      display: flex;
      gap: 0;
      border-bottom: 1px solid var(--vscode-panel-border, transparent);
      margin-bottom: 16px;
    }
    .tab-btn {
      background: none;
      border: none;
      border-bottom: 2px solid transparent;
      color: var(--vscode-descriptionForeground);
      padding: 8px 16px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
    }
    .tab-btn:hover { color: var(--vscode-editor-foreground); }
    .tab-btn.active {
      color: var(--vscode-editor-foreground);
      border-bottom-color: var(--vscode-focusBorder, #007fd4);
    }
    .tab-content.hidden { display: none; }
    .plan-textarea {
      width: 100%;
      min-height: 400px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 6px;
      padding: 12px;
      font-family: var(--vscode-editor-font-family);
      font-size: 13px;
      line-height: 1.5;
      resize: vertical;
      outline: none;
      box-sizing: border-box;
    }
    .plan-textarea:focus {
      border-color: var(--vscode-focusBorder, #007fd4);
    }
    .save-bar {
      position: sticky;
      bottom: 0;
      padding: 12px 0;
      background: var(--vscode-editor-background);
      border-top: 1px solid var(--vscode-panel-border, transparent);
      margin-top: 16px;
    }
    .save-btn {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 4px;
      padding: 8px 24px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
    }
    .save-btn:hover { opacity: 0.9; }
  </style>
</head>
<body>
  ${progressBadge}
  ${editToolbar}
  <div class="${previewClass}"${previewId}>
    ${previewHtml}
  </div>
  ${editPanel}
  ${saveBar}
  ${script}
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
