import { describe, expect, it } from 'vitest';
import { parseSession } from '../../src/storage/session';

/** Minimal valid session object */
function validSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wf-20260220-144239',
    state: 'plan',
    description: 'Test workflow',
    planContent: '',
    verifyPlanResult: '',
    retryCount: 0,
    completed: false,
    todos: [],
    activeTodoIndex: -1,
    ...overrides,
  };
}

describe('parseSession', () => {
  it('parses valid minimal session', () => {
    const result = parseSession(validSession());
    expect(result).not.toBeNull();
    expect(result?.id).toBe('wf-20260220-144239');
    expect(result?.state).toBe('plan');
    expect(result?.description).toBe('Test workflow');
  });

  it('returns null for null input', () => {
    expect(parseSession(null)).toBeNull();
  });

  it('returns null for non-object input', () => {
    expect(parseSession('string')).toBeNull();
    expect(parseSession(42)).toBeNull();
    expect(parseSession(undefined)).toBeNull();
  });

  it('returns null for missing id', () => {
    expect(parseSession(validSession({ id: undefined }))).toBeNull();
  });

  it('returns null for non-string id', () => {
    expect(parseSession(validSession({ id: 123 }))).toBeNull();
  });

  it('returns null for empty string id', () => {
    expect(parseSession(validSession({ id: '' }))).toBeNull();
  });

  it('returns null for whitespace-only id', () => {
    expect(parseSession(validSession({ id: '   ' }))).toBeNull();
  });

  it('returns null for missing state', () => {
    expect(parseSession(validSession({ state: undefined }))).toBeNull();
  });

  it('returns null for invalid state', () => {
    expect(parseSession(validSession({ state: 'invalid' }))).toBeNull();
  });

  it('accepts all valid states', () => {
    const states = [
      'plan',
      'verifyPlan',
      'implement',
      'verifyImpl',
      'compound',
      'done',
    ];
    for (const state of states) {
      const result = parseSession(validSession({ state }));
      expect(result).not.toBeNull();
      expect(result?.state).toBe(state);
    }
  });

  it('returns null for missing description', () => {
    expect(parseSession(validSession({ description: undefined }))).toBeNull();
  });

  it('defaults planContent to empty string if missing', () => {
    const result = parseSession(validSession({ planContent: undefined }));
    expect(result).not.toBeNull();
    expect(result?.planContent).toBe('');
  });

  it('defaults retryCount to 0 if missing', () => {
    const result = parseSession(validSession({ retryCount: undefined }));
    expect(result).not.toBeNull();
    expect(result?.retryCount).toBe(0);
  });

  it('defaults completed to false for non-done state', () => {
    const result = parseSession(
      validSession({ completed: undefined, state: 'plan' }),
    );
    expect(result).not.toBeNull();
    expect(result?.completed).toBe(false);
  });

  it('defaults completed to true for done state', () => {
    const result = parseSession(
      validSession({ completed: undefined, state: 'done' }),
    );
    expect(result).not.toBeNull();
    expect(result?.completed).toBe(true);
  });

  // ── Todos ──

  it('parses valid todos', () => {
    const todos = [
      {
        title: 'Task 1',
        status: 'done',
        startCommit: 'abc1234',
        endCommit: 'def5678',
      },
      { title: 'Task 2', status: 'active' },
      { title: 'Task 3', status: 'pending' },
    ];
    const result = parseSession(validSession({ todos }));
    expect(result).not.toBeNull();
    expect(result?.todos).toHaveLength(3);
    expect(result?.todos[0].title).toBe('Task 1');
    expect(result?.todos[0].status).toBe('done');
  });

  it('filters out invalid todos', () => {
    const todos = [
      { title: 'Valid', status: 'active' },
      { title: 'Invalid', status: 'unknown' },
      { title: 123, status: 'pending' },
      'not an object',
    ];
    const result = parseSession(validSession({ todos }));
    expect(result).not.toBeNull();
    expect(result?.todos).toHaveLength(1);
    expect(result?.todos[0].title).toBe('Valid');
  });

  it('defaults todos to empty array when not an array', () => {
    const result = parseSession(validSession({ todos: 'invalid' }));
    expect(result).not.toBeNull();
    expect(result?.todos).toEqual([]);
  });

  // ── activeTodoIndex ──

  it('clamps activeTodoIndex to valid range', () => {
    const todos = [{ title: 'A', status: 'active' }];
    const result = parseSession(validSession({ todos, activeTodoIndex: 10 }));
    expect(result).not.toBeNull();
    expect(result?.activeTodoIndex).toBe(0); // clamped to max valid index
  });

  it('sets activeTodoIndex to -1 when no todos', () => {
    const result = parseSession(
      validSession({ todos: [], activeTodoIndex: 5 }),
    );
    expect(result).not.toBeNull();
    expect(result?.activeTodoIndex).toBe(-1);
  });

  it('preserves valid activeTodoIndex', () => {
    const todos = [
      { title: 'A', status: 'done' },
      { title: 'B', status: 'active' },
    ];
    const result = parseSession(validSession({ todos, activeTodoIndex: 1 }));
    expect(result).not.toBeNull();
    expect(result?.activeTodoIndex).toBe(1);
  });

  it('defaults activeTodoIndex to -1 when not a number', () => {
    const result = parseSession(validSession({ activeTodoIndex: 'invalid' }));
    expect(result).not.toBeNull();
    expect(result?.activeTodoIndex).toBe(-1);
  });

  // ── Optional fields ──

  it('preserves name when present', () => {
    const result = parseSession(validSession({ name: 'My Workflow' }));
    expect(result).not.toBeNull();
    expect(result?.name).toBe('My Workflow');
  });

  it('defaults name to undefined when not a string', () => {
    const result = parseSession(validSession({ name: 42 }));
    expect(result).not.toBeNull();
    expect(result?.name).toBeUndefined();
  });

  it('preserves gitBranch when present', () => {
    const result = parseSession(validSession({ gitBranch: 'feature/test' }));
    expect(result).not.toBeNull();
    expect(result?.gitBranch).toBe('feature/test');
  });

  it('defaults gitBranch to undefined when missing', () => {
    const result = parseSession(validSession());
    expect(result).not.toBeNull();
    expect(result?.gitBranch).toBeUndefined();
  });
});
