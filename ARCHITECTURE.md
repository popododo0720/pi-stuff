# Architecture

## Code Execution Flow

```mermaid
flowchart TD
    subgraph Entry["index.ts — Entry Point"]
        INIT[Extension loads] --> REG_CMD[Register commands]
        INIT --> REG_TOOL[Register tools]
        INIT --> REG_EVT[Register event handlers]
    end

    subgraph Events["Event Handlers"]
        SE[session_start/switch/fork/tree] --> RECON[Reconstruct session from disk]
        TC[tool_call] --> GUARD{guard.ts<br/>Should block?}
        GUARD -->|blocked| BLOCK[Return block reason]
        GUARD -->|allowed| PASS[Allow tool execution]
        BAS[before_agent_start] --> COMPACT{Pending compact?}
        COMPACT -->|yes| RUN_COMPACT["await compact<br/>(onComplete)"]
        RUN_COMPACT --> RECOVER
        COMPACT -->|no| RECOVER{Done state?}
        RECOVER -->|yes| PLAN_RECOVER[Auto-recover → plan]
        RECOVER -->|no| INJECT["prompt.ts (async)<br/>Inject system prompt<br/>+ WORKFLOW_ACTIVE flag<br/>+ Repo Map"]
        AE[agent_end] --> TRACK[Track currentWork]
    end

    subgraph StateMachine["transition.ts — State Machine"]
        PLAN["📝 plan"] -->|approvePlan| VP["🔍 verifyPlan"]
        VP -->|auto-verify pass| IMPL["🔨 implement"]
        VP -->|auto-verify fail| VP
        IMPL -->|implDone| VI["✅ verifyImpl"]
        VI -->|auto-verify pass| COMPOUND["🧠 compound"]
        VI -->|auto-verify fail| VI
        COMPOUND -->|"compoundDone + more TODOs"| IMPL_NEXT["🔨 implement (next TODO)<br/>+ deferred compact"]
        COMPOUND -->|"compoundDone + no TODOs"| DONE["🎉 done<br/>+ deferred compact"]
        DONE -->|user message| PLAN
        IMPL -->|replan| PLAN
        PLAN -->|setTodos| PLAN
    end

    subgraph Verification["parallel.ts — Verification Engine"]
        TRIGGER[implDone / approvePlan] --> BUILD[Build prompt]
        BUILD --> PARALLEL["Promise.all()"]
        PARALLEL --> MOD_A["Model A<br/>(adversarial + strict)"]
        PARALLEL --> MOD_B["Model B<br/>(adversarial + strict)"]
        PARALLEL --> SELF["Model A<br/>(self-critique)"]
        MOD_A --> PARSE[Parse VERDICT + severity]
        MOD_B --> PARSE
        SELF --> PARSE
        PARSE --> SUMMARIZE["summarizeVerificationOutput()<br/>🔴/🟡 + context lines<br/>🔵 count<br/>VERDICT guaranteed at end"]
        SUMMARIZE --> RESULT{All pass?}
        RESULT -->|yes| NEXT[Advance state]
        RESULT -->|no| RETRY[Stay in verify state]
    end

    subgraph Storage["Storage Layer"]
        MEM[memory.ts<br/>Project Memory] --- MEMFILE[".pi/workflow-memory.json"]
        SET[settings.ts<br/>Settings] --- SETFILE[".pi/workflow-settings.json"]
        PLN[plan.ts<br/>Plans] --- PLNFILE["docs/plans/*.md"]
        SOL[solution.ts<br/>Solutions] --- SOLFILE["docs/solutions/*.md"]
        CHK[checks.ts<br/>Custom Checks] --- CHKFILE["docs/checks/*.md"]
        MOD[modules.ts<br/>Module Conventions] --- MODFILE[".pi/conventions/*.json"]
    end

    subgraph Context["Context Layer"]
        PROMPT[prompt.ts — async] --> FLAG["WORKFLOW_ACTIVE=true/false<br/>(all branches)"]
        PROMPT --> REPO_MAP["Repo Map<br/>(if enabled)"]
        PROMPT --> MEM_CTX[Memory context]
        PROMPT --> STAGE_GUIDE[Stage guide]
        PROMPT --> TODO_PROG[TODO progress]
        PROMPT --> SOL_CTX[Past solutions]
        STATUS[status.ts] --> WIDGET[Widget: stage progress + TODO counter]
        PATTERN[pattern.ts] --> FILE_MATCH[Match rules to recent files]
    end
```

## Startup Git/Branch Flow

```mermaid
flowchart TD
    WF["/workflow command"] --> CHECK["git/worktree check"]
    CHECK -->|check failed| PREP["Inject mandatory TODO #1 (prep)"]
    CHECK -->|dirty + requireCleanStart| PREP
    CHECK -->|clean or dirty-allowed| PREP_OK["startup prep not required"]

    PREP_OK --> BRANCH["ensure workflow branch on current cwd"]
    BRANCH --> WT{"useWorkflowWorktree?"}
    WT -->|yes| AUX["create/reuse auxiliary worktree\n(git worktree list --porcelain)"]
    WT -->|no| PLAN["plan stage"]
    AUX --> PLAN
    PREP --> PLAN
```

## Git Automation Flow

```mermaid
flowchart TD
    COMP["compoundDone"] --> MORE{"more TODOs?"}
    MORE -->|yes| TODOGIT["auto commit (per TODO)"]
    TODOGIT --> TODOPUSH{"pushPerTodo?"}
    TODOPUSH -->|no| NEXT["next TODO implement"]
    TODOPUSH -->|yes| TODOTARGET{"branch target exists?"}
    TODOTARGET -->|no| TODOWARN["skip push + warning"]
    TODOTARGET -->|yes| TODOPUSH["push origin/<branch>"]
    TODOWARN --> NEXT
    TODOPUSH --> NEXT

    MORE -->|no| FINALCOMMIT["final auto commit"]
    FINALCOMMIT --> FINALPUSH{"pushOnComplete?"}
    FINALPUSH -->|no| DONE["done"]
    FINALPUSH -->|yes| FINALTARGET{"branch target exists?"}
    FINALTARGET -->|no| FINALSKIP["safe skip + warning"]
    FINALTARGET -->|yes| FINALRUN["push origin/<branch>"]
    FINALRUN --> PUSHOK{"push ok?"}
    PUSHOK -->|yes| DONE
    PUSHOK -->|no| BLOCK
    FINALSKIP --> DONE
```

## Reset Marker Compaction Hook

```mermaid
sequenceDiagram
    participant T as transition.ts
    participant I as index.ts
    participant P as Pi compaction

    T->>I: set PENDING_COMPACT with [WF_RESET] marker
    I->>P: before_agent_start -> ctx.compact(...)
    P->>I: session_before_compact event
    I->>P: if reset marker, return extension compaction result
    Note over I,P: session_before_compact + reset marker path
```

## Context Injection Policy

- Always-on memory is minimal (core conventions + matched rules).
- solutions/patterns/gotchas/decisions are injected by **top-k** relevance search.
- reset marker compaction reduces stale history carry-over.

## Verification Decision Engine (Severity-first)

- `runSingleModel()` computes PASS/FAIL from parsed severity first.
- Structured parsing reads CRITICAL/WARNING/INFO sections + inline findings.
- Negation handling (`no critical`, `0 warning`, `none`) prevents false positives.
- Dedupe/non-overlap prevents double counting between section and inline parsing.
- Fallback keyword scan runs when structured extraction finds zero findings.
- VERDICT is auxiliary; conflicts with severity resolve to FAIL.

## Verification Prompt Structure

```mermaid
flowchart LR
    subgraph PlanVerify["Plan Verification"]
        PP1["Approach correctness"]
        PP2["Missing critical steps"]
        PP3["🔴 CRITICAL → FAIL<br/>🟡 WARNING → PASS (noted)<br/>🔵 INFO → PASS"]
    end

    subgraph ImplVerify["Implementation Verification"]
        P1["Phase 1: Strict Verification<br/>Plan compliance, SOLID,<br/>security, architecture"]
        P2["Phase 2: Adversarial Testing<br/>Try to break the code<br/>with concrete scenarios"]
        P3["🔴 CRITICAL → FAIL<br/>🟡 WARNING → FAIL<br/>🔵 INFO → PASS"]
    end

    subgraph SelfCritique["Self-Critique Prompt"]
        SC1["Plan compliance check"]
        SC2["Boundary values<br/>null, undefined, empty"]
        SC3["Import/export chain"]
        SC4["Type correctness"]
        SC5["Error handling"]
        SC6["Integration side effects"]
    end

    PlanVerify --> MODEL_P["Model A + B"]
    ImplVerify --> MODEL_A["Model A"]
    ImplVerify --> MODEL_B["Model B"]
    SelfCritique --> MODEL_SC["Model A<br/>(self-critique)"]
    MODEL_A --> COMBINE["Combine results<br/>All must pass"]
    MODEL_B --> COMBINE
    MODEL_SC --> COMBINE
    MODEL_P --> COMBINE_P["Plan: All must pass<br/>(WARNING = PASS)"]
```

## Repo Map Pipeline

```mermaid
flowchart LR
    subgraph Collection["File Collection"]
        WALK["Walk project tree"] --> FILTER["Skip: node_modules, .git,<br/>dist, build, symlinks"]
        FILTER --> CAP["Cap: 500 files max"]
    end

    subgraph Parsing["AST Parsing (web-tree-sitter)"]
        CAP --> EXT["Extension → Language ID<br/>.ts → typescript<br/>.py → python"]
        EXT --> WASM["Load language .wasm<br/>(cached per language)"]
        WASM --> PARSE_AST["Parse → Extract:<br/>• Symbols (fn, class, type)<br/>• Import specifiers"]
    end

    subgraph Ranking["Graph + PageRank"]
        PARSE_AST --> RESOLVE["Resolve imports<br/>(JS/TS: relative paths)"]
        RESOLVE --> GRAPH["Build file graph<br/>(all files = nodes)"]
        GRAPH --> RANK["PageRank<br/>(damping=0.85, iter=20)<br/>+ dangling node handling"]
    end

    subgraph Output["Token-Budgeted Output"]
        RANK --> SORT["Sort by rank descending"]
        SORT --> RENDER["Render: path + symbols<br/>within token budget"]
        RENDER --> CACHE["Cache 30s<br/>key: cwd:budget"]
    end
```

## TODO System Flow (Unified Plan)

```mermaid
flowchart TD
    START["/workflow Big feature"] --> SET["setTodos: define items"]
    SET --> PLAN["📝 Unified Plan<br/>(covers ALL TODOs)"]
    PLAN -->|approvePlan| VERIFY_P["🔍 Verify Plan (once)"]
    VERIFY_P -->|pass| TODO1

    subgraph TODO1["TODO #1"]
        IMPL1["🔨 Implement"] --> VI1["✅ Verify Impl"]
        VI1 --> COMP1["🧠 Compound"]
    end

    COMP1 -->|"compoundDone<br/>+ deferred compact"| TODO2

    subgraph TODO2["TODO #2"]
        IMPL2["🔨 Implement"] --> VI2["✅ Verify Impl"]
        VI2 --> COMP2["🧠 Compound"]
    end

    COMP2 -->|"compoundDone<br/>+ deferred compact"| TODO3

    subgraph TODO3["TODO #3"]
        IMPL3["🔨 Implement"] --> VI3["✅ Verify Impl"]
        VI3 --> COMP3["🧠 Compound"]
    end

    COMP3 -->|"compoundDone<br/>no more TODOs"| DONE["🎉 Done"]

    style PLAN fill:#e3f2fd
    style VERIFY_P fill:#fff3e0
```

## Deferred Compaction Flow

```mermaid
sequenceDiagram
    participant Tool as transition.ts
    participant Flag as _pendingCompact
    participant Event as before_agent_start
    participant Pi as Pi Core

    Tool->>Flag: Set compact instructions
    Tool-->>Pi: Return textResult (no race)
    Note over Pi: Turn completes safely
    Pi->>Event: Next turn starts
    Event->>Flag: Check pending compact
    Flag-->>Event: Instructions found
    Event->>Pi: await ctx.compact({onComplete})
    Note over Pi: Compaction runs + completes
    Pi-->>Event: Compact done
    Event->>Pi: Inject system prompt
    Note over Pi: Agent starts with clean context
```

## Tool Call Guard

```mermaid
flowchart TD
    CALL["Tool call event"] --> CHECK{"Which stage?"}
    CHECK -->|plan, verifyPlan,<br/>verifyImpl, compound| WRITE{"write/edit?"}
    WRITE -->|yes| BLOCK["❌ Block"]
    WRITE -->|no| BASH{"bash command?"}
    BASH -->|yes| DETECT{"File-modifying<br/>pattern detected?"}
    DETECT -->|rm, mv, sed -i,<br/>git push, >, etc.| BLOCK
    DETECT -->|grep, find, ls,<br/>cat, curl| ALLOW["✅ Allow"]
    BASH -->|no| ALLOW
    CHECK -->|implement| ALLOW
    CHECK -->|done| ALLOW
```

## Memory Structure

```mermaid
graph LR
    subgraph ProjectMemory[".pi/workflow-memory.json"]
        CONV["conventions[]<br/>Global coding standards"]
        RULES["rules[]<br/>Pattern-based rules"]
        WORK["workflows[]<br/>Key workflows"]
        CUR["currentWork[]<br/>Active tasks"]
        NOTES["notes[]<br/>General notes"]
        PAT["patterns[]<br/>Recurring code patterns"]
        GOT["gotchas[]<br/>Mistakes & fixes"]
        DEC["decisions[]<br/>Architecture choices"]
    end

    subgraph Injection["System Prompt"]
        CONV --> PROMPT["Always injected"]
        RULES --> MATCH["Injected if pattern<br/>matches recent files"]
        PAT --> TOPK["On-demand top-k<br/>relevance injection"]
        GOT --> TOPK
        DEC --> TOPK
        TOPK --> PROMPT
    end

    subgraph Solutions["docs/solutions/*.md"]
        SOL["Past solutions"] --> PLAN_INJ["Injected during plan stage<br/>with top-k filtering"]
    end
```
