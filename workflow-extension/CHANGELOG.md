# Changelog

## 0.1.3 — Performance & Windows Fixes

- **Hot-path I/O optimization** — settings 전파 + listModules 중복 호출 제거 in before_agent_start
- **Windows WASM path fix** — `replace('/package.json')` → `dirname()` for cross-platform tree-sitter loading
- **Type safety** — `buildSystemPromptInjection` return type narrowed to `Promise<string>`
