# Changelog

## 0.1.3 — Settings Model Dropdown

- **Model datalist combobox** — Settings UI model fields now show available models as dropdown suggestions
- **RPC integration** — model list fetched from connected pi agent; updates dynamically on connect/disconnect
- **Graceful fallback** — when RPC is not connected, fields remain as free-text inputs

## 0.1.2 — Cross-Platform Fixes

- **CRLF newline support** — fixed `split('\n')` → `split(/\r?\n/)` across diff parsing, verification output, HTML rendering, and file tree providers
- **Affected areas** — show-diff, files-tree, html-utils, verify-panel

## 0.1.1 — README Update

- Updated README to reflect current features (RPC chat, multi-workflow, parallel search, settings UI, TODO rollback)
- Removed outdated Phase 1/Phase 2 architecture description

## 0.1.0 — Initial Release

- **Workflow Status Sidebar** — Activity bar panel showing current workflow state and stage
- **TODO Progress Tracking** — Tree view with per-item status (pending/in-progress/done)
- **Plan Viewer** — Webview panel displaying the current workflow plan with markdown rendering
- **Chat Integration** — Built-in chat panel for interacting with pi coding agent
- **Changed Files View** — Git-based file change tracking with inline diff support
- **Status Bar Indicator** — Real-time workflow state displayed at the bottom of the editor
- **Multi-Workflow Support** — Switch between multiple active workflows
- **Rollback Support** — Undo completed TODOs from context menu
