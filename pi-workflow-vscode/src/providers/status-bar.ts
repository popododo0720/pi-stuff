// providers/status-bar.ts — Status bar item showing workflow stage

import * as vscode from 'vscode';
import type { WorkflowSession } from '../types/workflow';
import { STATE_EMOJI, STATE_LABELS } from '../types/workflow';

const HIDE_DELAY_MS = 5000;

export class WorkflowStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private hideTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100,
    );
    this.item.command = 'pi.openPlan';
    this.item.tooltip = 'Pi Workflow — click to view plan';
  }

  update(session: WorkflowSession | null): void {
    // Clear any pending hide timer
    if (this.hideTimer !== undefined) {
      clearTimeout(this.hideTimer);
      this.hideTimer = undefined;
    }

    if (!session) {
      this.item.hide();
      return;
    }

    const emoji = STATE_EMOJI[session.state];
    const label = STATE_LABELS[session.state];

    if (session.completed || session.state === 'done') {
      this.item.text = `${emoji} Pi: ${label}`;
      this.item.backgroundColor = undefined;
      this.item.show();
      // Auto-hide after delay
      this.hideTimer = setTimeout(() => {
        this.item.hide();
        this.hideTimer = undefined;
      }, HIDE_DELAY_MS);
      return;
    }

    // Build text with optional TODO progress
    if (session.todos.length > 0 && session.activeTodoIndex >= 0) {
      const todoNum = session.activeTodoIndex + 1;
      const total = session.todos.length;
      this.item.text = `${emoji} Pi: ${label} TODO #${todoNum}/${total}`;
    } else {
      this.item.text = `${emoji} Pi: ${label}`;
    }

    // Warning background for implement stage
    if (session.state === 'implement') {
      this.item.backgroundColor = new vscode.ThemeColor(
        'statusBarItem.warningBackground',
      );
    } else {
      this.item.backgroundColor = undefined;
    }

    this.item.show();
  }

  dispose(): void {
    if (this.hideTimer !== undefined) {
      clearTimeout(this.hideTimer);
    }
    this.item.dispose();
  }
}
