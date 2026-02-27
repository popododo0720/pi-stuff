# Changelog

## 0.1.4 — Unit Test Infrastructure

- **vitest 도입** — unit test 환경 구축
- **session 테스트** — parseSession 빈/공백 ID 거부 강화, 208 lines
- **solution 테스트** — classifyCategory · classifySeverity · extractTags 등 138 lines

## 0.1.3 — Performance & Windows Fixes

- **Hot-path I/O optimization** — settings 전파 + listModules 중복 호출 제거 in before_agent_start
- **Windows WASM path fix** — `replace('/package.json')` → `dirname()` for cross-platform tree-sitter loading
- **Type safety** — `buildSystemPromptInjection` return type narrowed to `Promise<string>`
