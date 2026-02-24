# Pi Workflow — VSCode Extension

Integrated UI for [pi](https://www.npmjs.com/package/@mariozechner/pi-coding-agent) coding agent workflows. Chat with the agent, track plans, review verifications, and manage multiple workflows — all inside VSCode.

## Features

### 💬 Chat Panel
- Built-in chat interface with pi coding agent (RPC-based bidirectional communication)
- Markdown rendering with syntax highlighting
- Tool call visualization with ANSI color support and collapsible cards
- Streaming response display with thinking indicators
- Input queueing during agent processing

### 📋 Workflow Sidebar
- **Workflow Status** — Real-time state tracking across all stages (Planning → Verification → Implementation → Compound)
- **TODO Progress** — Tree view with per-item status (pending / in-progress / done)
- **Changed Files** — Git diff tree with per-TODO and per-branch change tracking

### 📝 Plan & Verification Panels
- Plan viewer with markdown rendering and active TODO highlighting
- Verification results with severity-based color coding (🔴 CRITICAL / 🟡 WARNING / 🔵 INFO)
- Multi-domain parallel verification progress display

### ⚙️ Workflow Management
- **Multi-workflow support** — Create, switch, and delete workflows
- **TODO rollback** — Undo completed TODOs via context menu (git reset)
- **Resume context** — Implementation notes preserved per TODO for session continuity
- **Settings UI** — Tabbed settings panel for models, stages, search, and verification config
- **Model selection** — Provider/model dropdown with per-stage configuration

### 🔍 Parallel Search
- Multi-query parallel codebase search with configurable scopes
- Scopes: codebase, docs, solutions, web, tests, types, config

## Requirements

- VSCode 1.85+
- [pi coding agent](https://www.npmjs.com/package/@mariozechner/pi-coding-agent) installed and available in PATH
- Git (for changed files and diff features)

## How It Works

The extension spawns a pi process via RPC (`pi --mode rpc`) and communicates over JSON lines. Workflow state is stored in `.pi/workflows/` and synced between CLI and VSCode sessions in real-time.

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
| `Pi: Start Chat` | Start pi agent and open chat panel |
| `Pi: Stop Chat` | Stop the running pi agent |
| `Pi: New Workflow` | Create a new workflow |
| `Pi: Open Plan` | Open the plan viewer webview |
| `Pi: Verification Results` | Open verification results panel |
| `Pi: Show Changes` | Show changed files with diff |
| `Pi: Settings` | Open workflow settings panel |
| `Pi: Refresh` | Force refresh all views |
| `Activate Workflow` | Switch to a different workflow (context menu) |
| `Rollback TODO` | Undo a completed TODO (context menu) |

## License

MIT
