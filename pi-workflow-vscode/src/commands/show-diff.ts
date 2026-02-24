// commands/show-diff.ts — Open diff view for changed files

import { execFile } from 'node:child_process';
import { join } from 'node:path';
import * as vscode from 'vscode';

const GIT_TIMEOUT_MS = 5000;

export async function showDiff(workspaceRoot: string): Promise<void> {
  const files = await getChangedFiles(workspaceRoot);

  if (files.length === 0) {
    vscode.window.showInformationMessage(
      'No changes found, or not a git repository.',
    );
    return;
  }

  const selected = await vscode.window.showQuickPick(files, {
    placeHolder: 'Select a file to view diff',
  });

  if (selected) {
    const fileUri = vscode.Uri.file(join(workspaceRoot, selected));
    try {
      await vscode.commands.executeCommand('git.openChange', fileUri);
    } catch {
      // Git extension may be disabled or command unavailable
      vscode.window.showWarningMessage(
        'Could not open diff. Ensure the Git extension is enabled.',
      );
    }
  }
}

function getChangedFiles(cwd: string): Promise<string[]> {
  return new Promise((resolve) => {
    // Try HEAD-based diff first, fall back to status for empty repos
    execFile(
      'git',
      ['diff', '--name-only', 'HEAD'],
      { cwd, timeout: GIT_TIMEOUT_MS },
      (err, stdout) => {
        if (!err && stdout.trim()) {
          resolve(parseLines(stdout));
          return;
        }
        // Fallback: git status for initial commits / empty repos
        execFile(
          'git',
          ['status', '--porcelain'],
          { cwd, timeout: GIT_TIMEOUT_MS },
          (err2, stdout2) => {
            if (err2) {
              resolve([]);
              return;
            }
            // Parse porcelain: extract path from position 3+
            const files = stdout2
              .split(/\r?\n/)
              .filter((l) => l.length >= 4)
              .map((l) => l.slice(3).trim())
              .filter((f) => f.length > 0);
            resolve(files);
          },
        );
      },
    );
  });
}

function parseLines(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((f) => f.trim())
    .filter((f) => f.length > 0);
}
