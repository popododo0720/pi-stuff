// providers/workflow-tree.ts — Sidebar tree view showing workflow status

import * as vscode from 'vscode';
import type { WorkflowSession } from '../types/workflow';
import { STATE_EMOJI, STATE_LABELS } from '../types/workflow';

export class WorkflowTreeProvider
  implements vscode.TreeDataProvider<vscode.TreeItem>
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private session: WorkflowSession | null = null;

  update(session: WorkflowSession | null): void {
    this.session = session;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.TreeItem[] {
    if (!this.session) return [];

    const s = this.session;
    const items: vscode.TreeItem[] = [];

    // Status
    const statusItem = new vscode.TreeItem(
      `Status: ${STATE_EMOJI[s.state]} ${STATE_LABELS[s.state]}`,
      vscode.TreeItemCollapsibleState.None,
    );
    statusItem.iconPath = new vscode.ThemeIcon('symbol-event');
    items.push(statusItem);

    // Description
    const descItem = new vscode.TreeItem(
      `Task: ${s.description}`,
      vscode.TreeItemCollapsibleState.None,
    );
    descItem.iconPath = new vscode.ThemeIcon('note');
    descItem.tooltip = s.description;
    items.push(descItem);

    // Branch (if available)
    if (s.gitBranch) {
      const branchItem = new vscode.TreeItem(
        `Branch: ${s.gitBranch}`,
        vscode.TreeItemCollapsibleState.None,
      );
      branchItem.iconPath = new vscode.ThemeIcon('git-branch');
      items.push(branchItem);
    }

    // Plan (clickable)
    const planItem = new vscode.TreeItem(
      'Plan',
      vscode.TreeItemCollapsibleState.None,
    );
    planItem.iconPath = new vscode.ThemeIcon('file-text');
    planItem.command = {
      command: 'pi.openPlan',
      title: 'Open Plan',
    };
    planItem.description = s.planContent ? '(available)' : '(empty)';
    items.push(planItem);

    // Verification (clickable)
    const verifyItem = new vscode.TreeItem(
      'Verification',
      vscode.TreeItemCollapsibleState.None,
    );
    verifyItem.iconPath = new vscode.ThemeIcon('checklist');
    verifyItem.command = {
      command: 'pi.openVerification',
      title: 'Open Verification Results',
    };
    verifyItem.description = s.verifyPlanResult ? '(available)' : '(empty)';
    items.push(verifyItem);

    return items;
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}
