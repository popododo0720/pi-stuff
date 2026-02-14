# Workflow Extension for Pi

A workflow automation extension for Pi coding agent (`@mariozechner/pi-coding-agent`) that enforces a structured development cycle: **Plan → Verify → Implement → Verify → Compound → Done**.

## Features

- **Enforced workflow stages** — AI cannot skip steps; write/edit tools blocked during non-implementation stages
- **`WORKFLOW_ACTIVE` header flag** — Explicit true/false injected in every prompt turn for reliable state detection
- **Parallel multi-model verification** — Plan and implementation verified by multiple LLMs simultaneously
- **Adversarial verification** — Models try to break code with concrete scenarios, not just review
- **Severity classification** — Plan: 🔴 CRITICAL → FAIL (🟡 WARNING noted for implementer) / Impl: 🔴+🟡 → FAIL, 🔵 INFO → PASS
- **Verification error summarization** — Marker-based extraction (🔴/🟡/🔵) replaces naive truncation; VERDICT guaranteed at end
- **Repo map** — AST-based file symbol extraction (web-tree-sitter) + PageRank ranking within token budget
- **TODO system** — Unified plan for all TODOs, then sequential implementation with per-TODO verify/compound cycles
- **Startup git/worktree gate** — Dirty trees force mandatory prep TODO #1; clean trees proceed directly
- **Git automation** — Auto commit/push at TODO boundaries and final completion (with completion blocking on final push failure)
- **Deferred compaction** — Context compaction between TODO cycles runs safely via `before_agent_start` (no tool-execution race)
- **Reset marker compaction** — `[WF_RESET]` marker enables aggressive reset-style compaction checkpoints
- **Compound learning** — Captures patterns, gotchas, decisions after each cycle; solutions saved for future reference
- **Project memory** — Conventions, rules, patterns, gotchas, decisions persist across sessions
- **Minimal always-on context** — Only core rules are always injected; history-like data is retrieval-based
- **Custom checks** — Drop `.md` files in `docs/checks/` for project-specific verification
- **Bash guard** — Detects file-modifying bash commands (rm, mv, sed -i, git push, etc.) and blocks them during read-only stages

## Installation

### Prerequisites

- Pi coding agent (`@mariozechner/pi-coding-agent`) installed
- Node.js 18+

### Setup

```bash
# Clone the repository
git clone https://github.com/popododo0720/pi-stuff.git
cd pi-stuff/workflow-extension

# Install dependencies
npm install

# Create symlink for pi to load the extension
ln -s "$(pwd)" ~/.pi/agent/extensions/workflow-extension
```

### Verify Installation

```bash
# Start pi, then run:
/workflow My first task
```

## Usage

### Commands

| Command | Description |
|---------|-------------|
| `/workflow <description>` | Start a new workflow |
| `/workflow-settings` | Configure per-stage model/thinking, verify models, timeout, repo map, git automation |
| `/workflow-cancel` | Cancel the active workflow |

### Workflow Stages

```
📝 Plan → 🔍 Verify Plan → 🔨 Implement → ✅ Verify Impl → 🧠 Compound → 🎉 Done
```

1. **Plan** — Discuss and create implementation plan. Large tasks can be split into TODOs.
2. **Verify Plan** — Automatic parallel verification by configured models.
3. **Implement** — Execute the plan. README/diagram updates included.
4. **Verify Impl** — Adversarial verification + self-critique (3 parallel verifiers).
5. **Compound** — Capture learnings (patterns, gotchas, decisions), save solution.
6. **Done** — Workflow complete. Send a message to start a new plan cycle.

### TODO System

For large tasks, the AI breaks them into TODO items during planning. **One unified plan covers all TODOs**, verified once. Then TODOs are implemented sequentially — each with its own Implement → Verify → Compound cycle, skipping re-planning:

```
setTodos → Unified Plan → Verify Plan → 
  TODO #1: Implement → Verify → Compound →
  TODO #2: Implement → Verify → Compound →
  TODO #3: Implement → Verify → Compound →
  Done
```

Context is automatically compacted between TODO cycles (deferred to `before_agent_start` to avoid race conditions).

### Startup Git/Worktree Check Policy

`/workflow` now checks git/worktree state first:

- **Dirty tree**: user cleanup strategy is requested, and mandatory TODO #1 (git/worktree preparation) is injected/locked.
- **Clean tree**: cleanup prompt is skipped; workflow proceeds directly.
- **Git check failure** (non-git/permission/etc): non-fatal fallback with mandatory prep TODO #1.

### Git Automation (TODO boundary + completion)

Git automation is configurable in `/workflow-settings` (`🧬 Git Automation`):

- `enabled`
- `commitPerTodo` / `pushPerTodo`
- `pushOnComplete`
- `requireCleanStart`
- `useWorkflowBranch`
- `useWorkflowWorktree`

Behavior:
- Workflow execution/edit/verification stays on current `cwd`.
- Workflow branch is prepared on current `cwd`; worktree is created/reused as **auxiliary workspace metadata**.
- On TODO boundary (`compoundDone` → next TODO), auto-commit and optional push can run.
- On final completion (all TODOs done), final commit/push is executed.
- If final commit/push fails, workflow completion is blocked and state remains `compound`.
- If push target branch is unavailable (strategy disabled or startup-prep path left branch unset), final push is skipped safely with a warning (no bare `git push`).

### Context Injection Policy

- **Always-on minimal set**: default conventions, user conventions, matched rules/module rules.
- **On-demand retrieval**: solutions + patterns/gotchas/decisions use keyword-overlap top-k selection.
- **Aggressive reset marker**: deferred compaction uses `[WF_RESET]` marker for reset-oriented checkpointing.

### Verification Decision Policy (Severity-first)

- PASS/FAIL uses structured severity parsing first (not emoji-count based).
- Plan verify: 🔴 any => FAIL, 🟡-only => PASS, VERDICT missing => FAIL.
- Impl verify: 🔴 or 🟡 any => FAIL, VERDICT missing => FAIL.
- VERDICT is auxiliary; conflict with severity resolves to FAIL.
- Parser applies negation handling (`no critical`, `0 warning`, `none`) + dedupe + fallback keyword scan.

### Per-Stage Model & Thinking Configuration

```bash
/workflow-settings
# Loop-based menu — configure multiple settings in one session:
#   📝 Plan — model + thinking level for planning stage
#   🔍 Verify — multiple models for parallel verification + thinking level
#   🔨 Implement — model + thinking level for implementation stage
#   🧠 Compound — model + thinking level for compound/reflection stage
#   ⏱️ Timeout — verify subprocess timeout (default: 120s)
#   🗺️ Repo Map — enable/disable + token budget (default: 2048)
#   ✅ Done — save and exit
#
# Models auto-switch when entering each workflow stage.
# "(current)" means the stage uses whatever model is active (no override).
```

### Repo Map

AST-based code structure mapping powered by `web-tree-sitter`:

- **Extracts symbols** (functions, classes, interfaces, types, variables) from project files
- **Builds import graph** (JS/TS import resolution) and ranks files by **PageRank** importance
- **Token-budgeted output** — fits within configurable limit (default: 2048 tokens)
- **Graceful degradation** — if tree-sitter fails, repo map is silently skipped
- Injected into system prompt as `### Repo Map` section

Supported languages: TypeScript, JavaScript, Python, Go, Rust, Java, C/C++, C#, Ruby, Swift, Kotlin, Dart, Lua, Zig, Elixir, Scala, PHP, Bash.

### Custom Checks

Create markdown files in `docs/checks/` to add project-specific verification criteria:

```markdown
# docs/checks/security.md
Look for: SQL injection, unvalidated input, hardcoded secrets

# docs/checks/performance.md  
Look for: nested loops (O(n²)), repeated includes in loop, sorting in loop
```

### Project Memory

Persists across sessions in `.pi/workflow-memory.json`:

| Category | Description |
|----------|-------------|
| `conventions` | Global coding standards |
| `rules` | Pattern-based rules (`src/api/**\|error handling required`) |
| `patterns` | Recurring code patterns discovered |
| `gotchas` | Mistakes found and fixed |
| `decisions` | Architecture choices with rationale |
| `notes` | General notes |

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for detailed code flow diagrams.

## Project Structure

```
workflow-extension/
├── src/
│   ├── index.ts                 # Entry point: event wiring, session state
│   ├── types.ts                 # All TypeScript interfaces
│   ├── constants.ts             # Config, stage guides, defaults
│   ├── commands/
│   │   ├── workflow.ts          # /workflow command
│   │   ├── settings.ts          # /workflow-settings command  
│   │   └── cancel.ts            # /workflow-cancel command
│   ├── context/
│   │   ├── guard.ts             # Tool call blocking per stage
│   │   ├── prompt.ts            # System prompt injection (async)
│   │   ├── pattern.ts           # File pattern matching
│   │   └── status.ts            # Widget/status bar
│   ├── repomap/
│   │   ├── parser.ts            # AST symbol extraction (web-tree-sitter)
│   │   ├── graph.ts             # Import graph + PageRank
│   │   └── index.ts             # generateRepoMap entry point
│   ├── storage/
│   │   ├── index.ts             # Re-exports
│   │   ├── memory.ts            # Project memory CRUD
│   │   ├── modules.ts           # Module conventions
│   │   ├── plan.ts              # Plan document saving
│   │   ├── session.ts           # Session disk persistence
│   │   ├── settings.ts          # Settings load/save
│   │   ├── solution.ts          # Solution saving/search
│   │   └── checks.ts            # Custom checks loader
│   ├── tools/
│   │   ├── transition.ts        # State machine + deferred compaction
│   │   ├── project-memory.ts    # project_memory tool
│   │   └── module-conventions.ts # module_conventions tool
│   └── verification/
│       ├── index.ts             # Re-exports
│       └── parallel.ts          # Parallel verification + error summarization
├── biome.json
├── package.json
├── README.md
└── ARCHITECTURE.md
```

## Development

```bash
# Lint (zero tolerance)
npm run lint

# Auto-fix
npm run lint:fix

# Format
npm run format
```

