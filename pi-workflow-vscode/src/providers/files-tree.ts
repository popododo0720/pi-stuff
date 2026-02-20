// providers/files-tree.ts — Sidebar tree view showing changed files via git

import { execFile } from 'node:child_process';
import { join } from 'node:path';
import * as vscode from 'vscode';

const GIT_TIMEOUT_MS = 5000;
const DEBOUNCE_MS = 500;

interface ChangedFile {
  status: string; // M, A, D, R, C, ?
  path: string;
}

// Map git status codes to display info
const STATUS_MAP: Record<string, { icon: string; label: string }> = {
  M: { icon: 'diff-modified', label: 'Modified' },
  A: { icon: 'diff-added', label: 'Added' },
  D: { icon: 'diff-removed', label: 'Deleted' },
  R: { icon: 'diff-renamed', label: 'Renamed' },
  C: { icon: 'diff-added', label: 'Copied' },
  '?': { icon: 'diff-added', label: 'Untracked' },
};

export class ChangedFilesTreeProvider
  implements vscode.TreeDataProvider<vscode.TreeItem>
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private files: ChangedFile[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private loadVersion = 0;

  constructor(private readonly workspaceRoot: string) {}

  refresh(): void {
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.loadFiles();
    }, DEBOUNCE_MS);
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.TreeItem[] {
    return this.files.map((f) => {
      const display = STATUS_MAP[f.status] ?? STATUS_MAP.M;
      const item = new vscode.TreeItem(
        f.path,
        vscode.TreeItemCollapsibleState.None,
      );
      item.iconPath = new vscode.ThemeIcon(display.icon);
      item.tooltip = `${display.label}: ${f.path}`;
      item.description = f.status;

      // Open diff via VSCode built-in git extension (works for all statuses)
      item.command = {
        command: 'git.openChange',
        title: 'Open Change',
        arguments: [vscode.Uri.file(join(this.workspaceRoot, f.path))],
      };

      return item;
    });
  }

  private loadFiles(): void {
    const thisVersion = ++this.loadVersion;

    execFile(
      'git',
      ['status', '--porcelain'],
      { cwd: this.workspaceRoot, timeout: GIT_TIMEOUT_MS },
      (err, stdout) => {
        // Stale result guard
        if (thisVersion !== this.loadVersion) return;

        if (err) {
          // Non-git folder, empty repo, or command failure — silent fail
          this.files = [];
          this._onDidChangeTreeData.fire();
          return;
        }
        this.files = this.parseGitStatus(stdout);
        this._onDidChangeTreeData.fire();
      },
    );
  }

  /**
   * Parse `git status --porcelain` output.
   * Format: XY path (X=index status, Y=worktree status)
   * Position 0=X, 1=Y, 2=space, 3+=path
   *
   * Rename/copy entries have " -> " in the path regardless of which
   * column (X or Y) indicates the rename. We always extract the new path.
   */
  private parseGitStatus(output: string): ChangedFile[] {
    const files: ChangedFile[] = [];
    const lines = output.split('\n').filter((l) => l.length >= 4);

    for (const line of lines) {
      const x = line[0]; // Index status
      const y = line[1]; // Worktree status

      // Determine effective status (Y takes priority, fall back to X)
      let status: string;
      if (y !== ' ' && y !== '!') {
        status = y;
      } else if (x !== ' ' && x !== '!') {
        status = x;
      } else {
        continue;
      }

      // Extract path (starts at position 3)
      let filePath = line.slice(3);

      // Handle rename/copy: check X column for R/C (the source of " -> " format),
      // since Y may override the effective status to M while path still has " -> ".
      // Uses indexOf + slice (not split.pop) to handle paths containing " -> ".
      if ((x === 'R' || x === 'C') && filePath.includes(' -> ')) {
        const arrowIdx = filePath.indexOf(' -> ');
        filePath = filePath.slice(arrowIdx + 4); // " -> " = 4 chars
      }

      files.push({ status, path: filePath });
    }

    return files;
  }

  dispose(): void {
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
    }
    this._onDidChangeTreeData.dispose();
  }
}
