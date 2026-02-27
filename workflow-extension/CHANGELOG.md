# Changelog

## 0.1.5 — Draft Plan Action & Code Quality

- **draftPlan action** — New `draftPlan` workflow transition saves plan content for preview without state change
- **approvePlan fallback** — `approvePlan` without content parameter uses existing session planContent
- **Code quality** — Fixed 25 Biome lint diagnostics, unified all source code to English

## 0.1.4 — Unit Test Infrastructure

- **vitest setup** — Added vitest unit test infrastructure
- **session tests** — Stricter empty/blank ID rejection in parseSession, 208 lines
- **solution tests** — classifyCategory, classifySeverity, extractTags and more, 138 lines

## 0.1.3 — Performance & Windows Fixes

- **Hot-path I/O optimization** — Eliminated redundant settings propagation and duplicate listModules calls in before_agent_start
- **Windows WASM path fix** — `replace('/package.json')` → `dirname()` for cross-platform tree-sitter loading
- **Type safety** — `buildSystemPromptInjection` return type narrowed to `Promise<string>`
