# Pi Workflow — VSCode Extension

Visual companion for [pi](https://github.com/nicholasgasior/pi-coding-agent) coding agent workflows.

## Features

- **Activity Bar Sidebar** — Dedicated panel showing workflow status, TODO progress, and changed files
- **Status Bar** — Real-time workflow state indicator at the bottom of your editor
- **Plan Viewer** — Webview panel displaying the current workflow plan with markdown rendering and active TODO highlighting
- **Verification Results** — Parsed display of verification findings with severity-based color coding (CRITICAL / WARNING / INFO)
- **Changed Files** — Git status tree with diff support
- **Welcome View** — Guided onboarding when no workflow is active

## Requirements

- VSCode 1.85+
- [pi coding agent](https://www.npmjs.com/package/@mariozechner/pi-coding-agent) running in the workspace
- Git (for changed files and diff features)

## How It Works

This extension is **read-only**. It watches `.pi/workflow-session.json` (written by pi) and displays the current workflow state. It never modifies the session file.

### Workflow States

| State | Description |
|-------|-------------|
| 📝 Planning | Writing the implementation plan |
| 🔍 Verifying Plan | Plan is being verified |
| 🔨 Implementing | Code is being written |
| ✅ Verifying | Implementation is being verified |
| 📦 Compound | Multi-step compound task in progress |
| ⏸️ Idle | No active workflow |

## Commands

| Command | Description |
|---------|-------------|
| `Pi: Open Plan` | Open the plan viewer webview |
| `Pi: Verification Results` | Open verification results panel |
| `Pi: Show Changes` | Show changed files with diff |
| `Pi: Refresh` | Force refresh all views |

## Installation

1. Clone this repository
2. `cd pi-workflow-vscode && npm install`
3. `npm run compile`
4. Press F5 in VSCode to launch the Extension Development Host

## Architecture

**Phase 1 (current):** File watcher-based dashboard. The extension watches `.pi/workflow-session.json` and provides a read-only UI.

**Phase 2 (planned):** RPC-based bidirectional communication via `pi --mode rpc` for a Cursor-like integrated experience.

## License

MIT
