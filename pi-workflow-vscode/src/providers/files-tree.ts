// providers/files-tree.ts — Sidebar tree view showing changed files via git

import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 5000;
const DEBOUNCE_MS = 500;

interface ChangedFile {
  status: string; // M, A, D, R, C, ?
  path: string;
  oldPath?: string; // For rename/copy: the original file path
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
  private baseBranch: string | null = null;
  private commitRange: { start: string; end: string } | null = null;

  constructor(private readonly workspaceRoot: string) {}

  /** Set the base branch for overall diff. Does NOT auto-refresh. */
  setBaseBranch(branch: string | null): void {
    this.baseBranch = branch;
  }

  /** Set commit range for per-TODO diff. Does NOT auto-refresh. */
  setCommitRange(start: string | null, end: string | null): void {
    this.commitRange = start && end ? { start, end } : null;
  }

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
      item.resourceUri = vscode.Uri.file(join(this.workspaceRoot, f.path));

      if (this.commitRange) {
        // Commit range mode: open diff via pi.openCommitDiff command
        // For rename/copy, pass oldPath so the left side can be resolved
        item.command = {
          command: 'pi.openCommitDiff',
          title: 'Open Diff',
          arguments: [f.path, f.status, this.commitRange.start, this.commitRange.end, f.oldPath],
        };
      } else {
        // Working tree mode: use built-in git extension
        item.command = {
          command: 'git.openChange',
          title: 'Open Change',
          arguments: [vscode.Uri.file(join(this.workspaceRoot, f.path))],
        };
      }

      return item;
    });
  }

  private loadFiles(): void {
    const thisVersion = ++this.loadVersion;
    if (this.commitRange) {
      this.loadCommitRangeDiff(thisVersion);
    } else if (this.baseBranch) {
      this.loadBranchDiff(thisVersion);
    } else {
      this.loadGitStatus(thisVersion);
    }
  }

  private loadGitStatus(version: number): void {
    execFile(
      'git',
      ['status', '--porcelain'],
      { cwd: this.workspaceRoot, timeout: GIT_TIMEOUT_MS },
      (err, stdout) => {
        if (version !== this.loadVersion) return;
        if (err) {
          this.files = [];
          this._onDidChangeTreeData.fire();
          return;
        }
        this.files = this.parseGitStatus(stdout);
        this._onDidChangeTreeData.fire();
      },
    );
  }

  private loadCommitRangeDiff(version: number): void {
    const range = this.commitRange!;
    execFile(
      'git',
      ['diff', '--name-status', range.start + '..' + range.end],
      { cwd: this.workspaceRoot, timeout: GIT_TIMEOUT_MS },
      (err, diffOut) => {
        if (version !== this.loadVersion) return;
        if (err) {
          this.files = [];
          this._onDidChangeTreeData.fire();
          return;
        }
        this.files = this.parseDiffNameStatus(diffOut);
        this._onDidChangeTreeData.fire();
      },
    );
  }

  private loadBranchDiff(version: number): void {
    execFile(
      'git',
      ['merge-base', this.baseBranch!, 'HEAD'],
      { cwd: this.workspaceRoot, timeout: GIT_TIMEOUT_MS },
      (err, mergeBase) => {
        if (version !== this.loadVersion) return;
        if (err) {
          this.loadGitStatus(version);
          return;
        }
        const base = mergeBase.trim();
        if (!base) {
          this.loadGitStatus(version);
          return;
        }
        execFile(
          'git',
          ['diff', '--name-status', base + '..HEAD'],
          { cwd: this.workspaceRoot, timeout: GIT_TIMEOUT_MS },
          (err2, diffOut) => {
            if (version !== this.loadVersion) return;
            if (err2) {
              this.loadGitStatus(version);
              return;
            }
            execFile(
              'git',
              ['status', '--porcelain'],
              { cwd: this.workspaceRoot, timeout: GIT_TIMEOUT_MS },
              (err3, statusOut) => {
                if (version !== this.loadVersion) return;
                const committed = this.parseDiffNameStatus(diffOut);
                const uncommitted = err3
                  ? []
                  : this.parseGitStatus(statusOut);
                const merged = new Map<string, ChangedFile>();
                for (const f of committed) merged.set(f.path, f);
                for (const f of uncommitted) merged.set(f.path, f);
                this.files = Array.from(merged.values());
                this._onDidChangeTreeData.fire();
              },
            );
          },
        );
      },
    );
  }

  private parseDiffNameStatus(output: string): ChangedFile[] {
    return output
      .split('\n')
      .filter((l) => l.trim())
      .map((line) => {
        const parts = line.split('\t');
        const status = parts[0]?.[0] ?? 'M';
        // Rename/Copy: parts = [status, oldPath, newPath]
        if ((status === 'R' || status === 'C') && parts.length > 2) {
          return { status, path: parts[2]!, oldPath: parts[1] };
        }
        return { status, path: parts[1] ?? '' };
      })
      .filter((f) => f.path);
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
