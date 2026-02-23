// providers/workflow-tree.ts — Sidebar tree view showing workflow status
// Multi-workflow: shows list of workflows when >1, details when single or active.

import * as vscode from 'vscode';
import type { WorkflowListItem, WorkflowSession, WorkflowState } from '../types/workflow';
import { STATE_EMOJI, STATE_LABELS } from '../types/workflow';

type WorkflowNode =
  | { kind: 'workflow'; item: WorkflowListItem }
  | {
      kind: 'detail';
      label: string;
      icon: string;
      command?: vscode.Command;
      description?: string;
      tooltip?: string;
    };

export class WorkflowTreeProvider
  implements vscode.TreeDataProvider<WorkflowNode>
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private session: WorkflowSession | null = null;
  private list: WorkflowListItem[] = [];

  /** Update active session (called from syncUI via onDidChange). */
  update(session: WorkflowSession | null): void {
    this.session = session;
    this._onDidChangeTreeData.fire();
  }

  /** Update workflow list (called from onDidChangeList). */
  updateList(list: WorkflowListItem[]): void {
    this.list = list;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: WorkflowNode): vscode.TreeItem {
    if (element.kind === 'workflow') {
      const w = element.item;
      const emoji = STATE_EMOJI[w.state as WorkflowState] ?? '❓';
      const item = new vscode.TreeItem(
        `${emoji} ${w.name || w.description}`,
        w.active
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.description = w.active ? '(active)' : w.state;
      item.contextValue = w.active ? 'activeWorkflow' : 'inactiveWorkflow';
      item.id = w.id;
      // Click inactive workflow → switch to it
      if (!w.active) {
        item.command = {
          command: 'pi.selectWorkflow',
          title: 'Switch Workflow',
          arguments: [w.id],
        };
      }
      return item;
    }

    // Detail node
    const item = new vscode.TreeItem(
      element.label,
      vscode.TreeItemCollapsibleState.None,
    );
    item.iconPath = new vscode.ThemeIcon(element.icon);
    if (element.command) item.command = element.command;
    if (element.description) item.description = element.description;
    if (element.tooltip) item.tooltip = element.tooltip;
    return item;
  }

  getChildren(element?: WorkflowNode): WorkflowNode[] {
    if (!element) {
      // Root level
      if (this.list.length === 0 && this.session) {
        // No list yet but session exists → synthesize a workflow node
        return [{
          kind: 'workflow' as const,
          item: {
            id: this.session.id,
            name: this.session.description,
            description: this.session.description,
            state: this.session.state,
            active: true,
          },
        }];
      }
      if (this.list.length === 0) return [];
      // Workflow list (1 or more)
      return this.list.map((item) => ({
        kind: 'workflow' as const,
        item,
      }));
    }

    // Children of a workflow node
    if (element.kind === 'workflow') {
      if (element.item.active && this.session) {
        return this.getDetailNodes(this.session);
      }
      // Inactive: basic info from list item
      const state = element.item.state as WorkflowState;
      return [
        {
          kind: 'detail' as const,
          label: `${STATE_EMOJI[state] ?? '❓'} ${STATE_LABELS[state] ?? state}`,
          icon: 'symbol-event',
        },
        {
          kind: 'detail' as const,
          label: `📋 ${element.item.description}`,
          icon: 'note',
        },
      ];
    }
    return [];
  }

  private getDetailNodes(s: WorkflowSession): WorkflowNode[] {
    const items: WorkflowNode[] = [];

    // Status
    items.push({
      kind: 'detail',
      label: `${STATE_EMOJI[s.state]} ${STATE_LABELS[s.state]}`,
      icon: 'symbol-event',
    });

    // Description
    items.push({
      kind: 'detail',
      label: `📋 ${s.description}`,
      icon: 'note',
      tooltip: s.description,
    });

    // Branch (if available)
    if (s.gitBranch) {
      items.push({
        kind: 'detail',
        label: `Branch: ${s.gitBranch}`,
        icon: 'git-branch',
      });
    }

    // Plan (clickable)
    items.push({
      kind: 'detail',
      label: 'Plan',
      icon: 'file-text',
      command: { command: 'pi.openPlan', title: 'Open Plan' },
      description: s.planContent ? '(available)' : '(empty)',
    });

    // Verification (clickable)
    items.push({
      kind: 'detail',
      label: 'Verification',
      icon: 'checklist',
      command: {
        command: 'pi.openVerification',
        title: 'Open Verification Results',
      },
      description: s.verifyPlanResult ? '(available)' : '(empty)',
    });

    return items;
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}
