---
title: "feat: Pi Workflow Automation Extension"
type: feat
date: 2026-02-12
brainstorm: docs/brainstorms/2026-02-12-pi-workflow-extension-brainstorm.md
---

# Pi Workflow Automation Extension

## Overview

Pi 코딩 에이전트용 워크플로우 자동화 Extension. `/workflow <설명>` 커맨드 하나로 **Plan → Verify Plan → Implement → Verify Implementation** 전체 개발 사이클을 상태 머신으로 자동 관리한다.

계획 단계에서만 사용자와 대화형으로 승인을 받고, 나머지 단계는 자동 진행. 검증 실패 시 이전 단계로 자동 복귀.

## Problem Statement / Motivation

- 코딩 에이전트 사용 시 계획 없이 바로 구현에 들어가면 방향이 틀어지기 쉬움
- 계획을 세워도 검증 없이 구현하면 빠진 부분이 생김
- 이 과정을 매번 수동으로 관리하는 것은 번거로움
- compound-engineering처럼 단계별 커맨드를 따로 치는 것도 불편

## Proposed Solution

하나의 TypeScript Extension 파일로 구현. 상태 머신이 4단계를 자동으로 전환하며, `/workflow` 커맨드로 시작.

```
┌──────────┐     ┌──────────────┐     ┌──────────┐     ┌──────────────┐     ┌──────┐
│  PLAN    │────▶│ VERIFY_PLAN  │────▶│IMPLEMENT │────▶│VERIFY_IMPL   │────▶│ DONE │
│(대화형)  │◀────│  (자동)      │     │ (자동)   │     │  (자동)      │     │      │
└──────────┘fail └──────────────┘     └──────────┘     └──────────────┘     └──────┘
```

## Technical Approach

### 파일 구조

```
workflow-extension/
├── index.ts              # Extension entry point
```

단일 파일로 시작. 복잡해지면 나중에 분리.

### 상태 머신

```typescript
type WorkflowState = "idle" | "plan" | "verify_plan" | "implement" | "verify_impl" | "done";

interface WorkflowSession {
  state: WorkflowState;
  description: string;        // 사용자가 입력한 작업 설명
  planPath: string;           // 생성된 계획 문서 경로
  planContent: string;        // 계획 내용
  verifyPlanResult: string;   // 계획 검증 결과
  verifyImplResult: string;   // 구현 검증 결과
  createdAt: string;          // 워크플로우 시작 시간
}
```

### Phase 1: 커맨드 등록 및 상태 관리

`/workflow` 커맨드를 등록하고 상태 머신 기본 구조를 구현한다.

```typescript
// index.ts
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
  let session: WorkflowSession | null = null;

  // 세션 이벤트에서 상태 복원
  const reconstruct = (ctx: ExtensionContext) => {
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;
      const msg = entry.message;
      if (msg.role !== "toolResult" || msg.toolName !== "workflow_state") continue;
      if (msg.details) session = msg.details as WorkflowSession;
    }
  };

  pi.on("session_start", async (_e, ctx) => reconstruct(ctx));
  pi.on("session_switch", async (_e, ctx) => reconstruct(ctx));
  pi.on("session_fork", async (_e, ctx) => reconstruct(ctx));
  pi.on("session_tree", async (_e, ctx) => reconstruct(ctx));

  pi.registerCommand("workflow", {
    description: "Start automated workflow: plan → verify → implement → verify",
    handler: async (args, ctx) => {
      const description = args.join(" ");
      if (!description) {
        ctx.ui.notify("Usage: /workflow <작업 설명>", "error");
        return;
      }
      session = {
        state: "plan",
        description,
        planPath: "",
        planContent: "",
        verifyPlanResult: "",
        verifyImplResult: "",
        createdAt: new Date().toISOString(),
      };
      // 시스템 메시지로 계획 수립 시작 지시
      pi.sendUserMessage(
        `[WORKFLOW: PLAN 단계]\n\n` +
        `다음 작업에 대한 구현 계획을 세워주세요:\n\n` +
        `"${description}"\n\n` +
        `계획을 마크다운으로 작성하고, 완료되면 workflow_transition 도구를 호출하세요.\n` +
        `계획에는 다음을 포함하세요:\n` +
        `- 구현할 내용 요약\n` +
        `- 단계별 구현 계획\n` +
        `- 예상되는 파일 변경 목록\n` +
        `- 검증 기준 (어떻게 완료를 확인할 것인가)`
      );
    },
  });
}
```

### Phase 2: 전환 도구 (workflow_transition)

LLM이 각 단계 완료 시 호출하는 도구. 상태 전환과 다음 단계 자동 시작을 담당.

```typescript
pi.registerTool({
  name: "workflow_transition",
  label: "Workflow Transition",
  description: "현재 워크플로우 단계를 완료하고 다음 단계로 전환합니다.",
  parameters: Type.Object({
    action: StringEnum(["approve_plan", "plan_verified", "plan_failed",
                         "impl_done", "impl_verified", "impl_failed"] as const),
    content: Type.Optional(Type.String({ description: "단계 결과물 (계획 내용, 검증 결과 등)" })),
    reason: Type.Optional(Type.String({ description: "실패 사유" })),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    if (!session) {
      return { content: [{ type: "text", text: "활성 워크플로우가 없습니다." }] };
    }

    switch (params.action) {
      case "approve_plan":
        // 사용자가 계획을 승인 → 검증 단계로
        session.planContent = params.content || "";
        session.state = "verify_plan";
        // 계획 문서 저장 경로 설정
        const dateStr = new Date().toISOString().slice(0, 10);
        const slug = session.description.slice(0, 40).replace(/\s+/g, "-").toLowerCase();
        session.planPath = `docs/plans/${dateStr}-${slug}.md`;
        break;

      case "plan_verified":
        session.state = "implement";
        session.verifyPlanResult = params.content || "검증 통과";
        break;

      case "plan_failed":
        session.state = "plan";  // 계획으로 복귀
        session.verifyPlanResult = params.reason || "검증 실패";
        break;

      case "impl_done":
        session.state = "verify_impl";
        break;

      case "impl_verified":
        session.state = "done";
        session.verifyImplResult = params.content || "구현 검증 통과";
        break;

      case "impl_failed":
        session.state = "implement";  // 구현 재시도
        session.verifyImplResult = params.reason || "구현 검증 실패";
        break;
    }

    // 다음 단계 자동 시작 메시지 전송
    const nextPrompt = getNextStagePrompt(session);
    if (nextPrompt) {
      pi.sendUserMessage(nextPrompt);
    }

    return {
      content: [{ type: "text", text: `워크플로우 상태: ${session.state}` }],
      details: session,  // 상태 영속화
    };
  },
});
```

### Phase 3: 단계별 프롬프트 생성

각 단계 전환 시 LLM에 보낼 지시 메시지를 생성하는 함수.

```typescript
function getNextStagePrompt(s: WorkflowSession): string | null {
  switch (s.state) {
    case "verify_plan":
      return (
        `[WORKFLOW: VERIFY_PLAN 단계]\n\n` +
        `아래 계획을 검증하세요:\n\n${s.planContent}\n\n` +
        `검증 항목:\n` +
        `1. 계획이 명확하고 구체적인가?\n` +
        `2. 빠진 단계가 없는가?\n` +
        `3. 파일 변경 목록이 현실적인가?\n` +
        `4. 검증 기준이 측정 가능한가?\n\n` +
        `통과하면 workflow_transition(action: "plan_verified")를 호출하세요.\n` +
        `문제가 있으면 workflow_transition(action: "plan_failed", reason: "...")를 호출하세요.`
      );

    case "implement":
      return (
        `[WORKFLOW: IMPLEMENT 단계]\n\n` +
        `아래 계획에 따라 구현하세요:\n\n${s.planContent}\n\n` +
        `계획의 각 단계를 순서대로 진행하세요.\n` +
        `구현이 완료되면 workflow_transition(action: "impl_done")를 호출하세요.`
      );

    case "verify_impl":
      return (
        `[WORKFLOW: VERIFY_IMPL 단계]\n\n` +
        `구현이 계획과 일치하는지 검증하세요:\n\n` +
        `원래 계획:\n${s.planContent}\n\n` +
        `검증 항목:\n` +
        `1. 계획의 모든 항목이 구현되었는가?\n` +
        `2. 코드가 정상 동작하는가? (테스트/실행 확인)\n` +
        `3. 누락된 부분이 없는가?\n\n` +
        `통과하면 workflow_transition(action: "impl_verified")를 호출하세요.\n` +
        `문제가 있으면 workflow_transition(action: "impl_failed", reason: "...")를 호출하세요.`
      );

    case "plan":
      if (s.verifyPlanResult) {
        return (
          `[WORKFLOW: PLAN 재수립]\n\n` +
          `이전 계획 검증에서 문제가 발견되었습니다:\n${s.verifyPlanResult}\n\n` +
          `이전 계획:\n${s.planContent}\n\n` +
          `문제를 해결하여 계획을 수정하세요.\n` +
          `수정 완료 후 사용자에게 승인을 받고 workflow_transition(action: "approve_plan")을 호출하세요.`
        );
      }
      return null;

    case "done":
      return null;

    default:
      return null;
  }
}
```

### Phase 4: 시스템 프롬프트 주입

워크플로우 활성화 시 시스템 프롬프트에 워크플로우 컨텍스트를 추가.

```typescript
pi.on("before_agent_start", async (event) => {
  if (!session || session.state === "idle" || session.state === "done") {
    return undefined;
  }

  const workflowContext = `
## Active Workflow

현재 워크플로우 자동화가 진행 중입니다.
- 상태: ${session.state}
- 작업: ${session.description}
- workflow_transition 도구를 사용하여 단계를 전환하세요.
- 계획 단계에서는 반드시 사용자의 승인을 받은 후 전환하세요.
`;

  return {
    systemPrompt: event.systemPrompt + workflowContext,
  };
});
```

## Acceptance Criteria

### Functional Requirements

- [x] `/workflow <설명>` 커맨드로 워크플로우 시작
- [x] Plan 단계: LLM이 계획을 작성하고 사용자 승인 후 다음 단계로 진행
- [x] Verify Plan 단계: 계획을 자동 검증, 실패 시 Plan으로 자동 복귀
- [x] Implement 단계: 승인된 계획 기반으로 자동 구현
- [x] Verify Implementation 단계: 구현 결과 자동 검증
- [x] 계획 문서가 `docs/plans/`에 마크다운으로 저장됨
- [x] 세션 상태 영속화 (중단/재개 가능)

### Non-Functional Requirements

- [x] 단일 파일 (`index.ts`)로 구현
- [x] 외부 의존성 없음 (Pi 내장 패키지만 사용)
- [x] Pi 자동 탐지 디렉토리에 배치 가능

## Dependencies & Risks

- **의존성**: Pi 코딩 에이전트 (`@mariozechner/pi-coding-agent`) 설치 필요
- **리스크**: `sendUserMessage` API가 실제로 자동 턴을 트리거하는지 확인 필요
- **리스크**: LLM이 `workflow_transition` 도구를 적시에 호출하지 않을 수 있음 → 시스템 프롬프트로 보강

## References & Research

### Internal References

- Brainstorm: `docs/brainstorms/2026-02-12-pi-workflow-extension-brainstorm.md`

### External References

- Pi Extension API: https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md
- Pi Extension 예제: https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/examples/extensions
- Pi Packages: https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/packages.md
