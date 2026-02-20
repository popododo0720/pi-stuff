// providers/todo-tree.ts — Sidebar tree view showing TODO progress

import * as vscode from 'vscode';
import type { WorkflowSession } from '../types/workflow';

const STATUS_ICONS: Record<string, { icon: string; color: string }> = {
  done: { icon: 'check', color: 'charts.green' },
  active: { icon: 'play', color: 'charts.yellow' },
  pending: { icon: 'circle-outline', color: 'foreground' },
};

export class TodoTreeProvider
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
    if (!this.session || this.session.todos.length === 0) return [];

    const todos = this.session.todos;
    const doneCount = todos.filter((t) => t.status === 'done').length;
    const items: vscode.TreeItem[] = [];

    // Progress header
    const header = new vscode.TreeItem(
      `Progress: ${doneCount}/${todos.length}`,
      vscode.TreeItemCollapsibleState.None,
    );
    header.iconPath = new vscode.ThemeIcon('tasklist');
    items.push(header);

    // Each TODO
    for (let i = 0; i < todos.length; i++) {
      const todo = todos[i];
      const label = `${i + 1}. ${todo.title}`;
      const item = new vscode.TreeItem(
        label,
        vscode.TreeItemCollapsibleState.None,
      );

      const style = STATUS_ICONS[todo.status] ?? STATUS_ICONS.pending;
      item.iconPath = new vscode.ThemeIcon(
        style.icon,
        new vscode.ThemeColor(style.color),
      );

      if (todo.status === 'active') {
        item.description = '(current)';
      }

      items.push(item);
    }

    return items;
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}
