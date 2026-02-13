# Workflow Extension for Pi

A workflow automation extension for the [Pi coding agent](https://github.com/mariozechner/pi-coding-agent) that enforces a structured development cycle: **Plan → Verify → Implement → Verify → Compound → Done**.

Inspired by [Compound Engineering](https://every.to/), [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff), and [oh-my-opencode](https://github.com/nicepkg/oh-my-opencode).

## Features

- **Enforced workflow stages** — AI cannot skip steps; write/edit tools blocked during non-implementation stages
- **Parallel multi-model verification** — Plan and implementation verified by multiple LLMs simultaneously
- **Adversarial verification** — Models try to break code with concrete scenarios, not just review
- **Self-critique** — 3rd parallel verifier performs meticulous self-review
- **Severity classification** — 🔴 CRITICAL / 🟡 WARNING → FAIL, 🔵 INFO → PASS
- **TODO system** — Break large tasks into items, each with its own full workflow cycle
- **Compound learning** — Captures patterns, gotchas, decisions after each cycle; solutions saved for future reference
- **Project memory** — Conventions, rules, patterns, gotchas, decisions persist across sessions
- **Custom checks** — Drop `.md` files in `docs/checks/` for project-specific verification
- **Bash guard** — Detects file-modifying bash commands (rm, mv, sed -i, git push, etc.) and blocks them during read-only stages

## Installation

### Prerequisites

- [Pi coding agent](https://github.com/mariozechner/pi-coding-agent) installed
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
| `/workflow-settings` | Configure verification models, timeout, thinking level |
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

For large tasks, the AI breaks them into TODO items during planning:

```
workflow_transition(action: "setTodos", content: '["Setup types", "Add API", "Write tests"]')
```

Each TODO gets its own Plan → Verify → Implement → Verify → Compound cycle. Auto-advances to the next item after each compound. Context is automatically compacted between cycles to keep the context window clean.

### Verification Configuration

```bash
/workflow-settings
# Select verify models (e.g., openai-codex/gpt-5.3-codex, anthropic/claude-opus-4-6)
# Set timeout (default: 120s)
# Set thinking level (default: high)
```

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
│   │   ├── prompt.ts            # System prompt injection
│   │   ├── pattern.ts           # File pattern matching
│   │   └── status.ts            # Widget/status bar
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
│   │   ├── transition.ts        # State machine + verification
│   │   ├── project-memory.ts    # project_memory tool
│   │   └── module-conventions.ts # module_conventions tool
│   └── verification/
│       ├── index.ts             # Re-exports
│       └── parallel.ts          # Parallel multi-model verification
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

## License

ISC
