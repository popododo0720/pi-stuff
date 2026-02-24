// providers/todo-tree.ts — Sidebar tree view showing TODO progress

import * as vscode from 'vscode';
import type { WorkflowSession } from '../types/workflow';

/** TreeItem subclass that carries the TODO index for context menu commands. */
export class TodoTreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly todoIndex: number,
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
  }
}

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

    // Progress header — click to show all changes
    const header = new vscode.TreeItem(
      `Progress: ${doneCount}/${todos.length}`,
      vscode.TreeItemCollapsibleState.None,
    );
    header.iconPath = new vscode.ThemeIcon('tasklist');
    header.command = {
      command: 'pi.selectTodo',
      title: 'Show All Changes',
      arguments: [-1],
    };
    items.push(header);

    // Each TODO — click to show per-TODO diff + verification
    for (let i = 0; i < todos.length; i++) {
      const todo = todos[i];
      const label = `${i + 1}. ${todo.title}`;
      const item = new TodoTreeItem(label, i);

      const style = STATUS_ICONS[todo.status] ?? STATUS_ICONS.pending;
      item.iconPath = new vscode.ThemeIcon(
        style.icon,
        new vscode.ThemeColor(style.color),
      );

      item.contextValue = `todoItem.${todo.status}`;

      if (todo.status === 'active') {
        item.description = '(current)';
      }

      item.command = {
        command: 'pi.selectTodo',
        title: 'Show TODO Changes',
        arguments: [i],
      };

      items.push(item);
    }

    return items;
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}
