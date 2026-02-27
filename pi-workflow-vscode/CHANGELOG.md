# Changelog

## 0.1.5 — Settings Model Select & Chip UI

- **Native select dropdown** — datalist 자동완성을 표준 `<select>` 드롭다운으로 교체
- **Multi-model chip UI** — verify/domain 복수 모델 선택을 chip/tag 패턴으로 전환
- **커스텀 모델 보존** — available 목록에 없는 저장값도 커스텀 option으로 유지

## 0.1.4 — Solution Browser, Plan Editor & Tests

- **Solution Browser Panel** — `docs/solutions/` 학습 이력을 VSCode webview에서 탐색 (카테고리/심각도/검색 필터)
- **Interactive Plan Editor** — PlanPanel을 편집 가능한 인터랙티브 모드로 전환
- **Unit test infrastructure** — vitest 도입, html-utils · solution-parser 테스트 82개 작성
- **Cleanup** — self-referencing symlink 제거

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
