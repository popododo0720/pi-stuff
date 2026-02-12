# Pi Workflow Extension Brainstorm

**Date:** 2026-02-12
**Status:** Brainstorm

## What We're Building

Pi 코딩 에이전트용 워크플로우 자동화 Extension.
`/workflow` 커맨드 하나로 **Plan → Verify Plan → Implement → Verify Implementation** 전체 사이클을 자동 관리한다.

### 핵심 흐름

```
[시작] → [계획 수립] ←→ [사용자 승인] → [계획 검증] → [구현] → [구현 검증] → [완료]
                                              ↓ (실패)
                                         [계획 수립으로 복귀]
```

1. **계획 수립 (Plan)**: 사용자와 대화하며 계획 작성. 단계별로 사용자 승인 필요.
2. **계획 검증 (Verify Plan)**: 승인된 계획의 일관성, 누락 사항, 실현 가능성 자동 검증. 실패 시 계획 단계로 복귀.
3. **구현 (Implement)**: 검증 통과된 계획을 기반으로 자동 구현.
4. **구현 검증 (Verify Implementation)**: 구현 결과물이 계획과 일치하는지 자동 검증.

### 사용자 개입 지점

- 계획 단계: 승인 필요 (대화형)
- 나머지 단계: 자동 진행, 문제 발생 시에만 개입

## Why This Approach

- **단일 커맨드**: `/workflow` 하나만 기억하면 됨
- **상태 머신 + 이벤트 기반**: 자동 전환하되 계획에서만 사용자 협업
- **루프 구조**: 검증 실패 시 자동 복귀로 품질 보장

## Key Decisions

1. **진행 방식**: 계획 단계만 사용자 승인, 나머지 자동
2. **문서 저장**: 프로젝트 내 `docs/` 디렉토리에 마크다운으로 저장
3. **상태 관리**: Pi 세션 상태로 중단/재개 지원
4. **구현 기술**: TypeScript Extension, `ExtensionAPI` 활용
5. **커맨드**: `/workflow <설명>` 으로 시작

## Technical Notes

- Pi Extension은 `ExtensionAPI`를 받는 default export 함수
- `pi.registerCommand()`로 커맨드 등록
- `pi.registerTool()`로 커스텀 툴 등록
- `pi.session.state`로 상태 영속화
- `pi.subscribe()`로 이벤트 구독
- `pi.dialog()`, `pi.confirm()`으로 사용자 상호작용

## Open Questions

- 계획 검증 시 구체적으로 어떤 항목을 검증할 것인가?
- 구현 검증은 테스트 실행 기반? 코드 리뷰 기반?
- 워크플로우 히스토리를 별도로 관리할 필요가 있는가?
