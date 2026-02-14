// tools/handlers/set-todos.ts — setTodos action handler
// Parses TODO list, preserves startup prep if locked, sets active index.

import type { HandlerContext, HandlerResult } from './types';

export async function handleSetTodos(
  hctx: HandlerContext,
): Promise<HandlerResult> {
  const { session } = hctx;

  try {
    const raw: unknown[] = JSON.parse(hctx.params.content || '[]');
    if (!Array.isArray(raw) || raw.length === 0) {
      return { text: 'Invalid TODO list. Provide a JSON array of strings.' };
    }

    const titles = raw.map((t) => String(t).trim()).filter(Boolean);
    if (titles.length === 0) {
      return {
        text: 'All TODO items are empty. Provide non-empty strings.',
      };
    }

    const prepTodo =
      session.startupPrepLocked && session.todos.length > 0
        ? session.todos[0]
        : null;

    if (prepTodo) {
      session.todos = [
        { title: prepTodo.title, status: prepTodo.status },
        ...titles.map((title, i) => ({
          title,
          status:
            prepTodo.status === 'done' && i === 0
              ? ('active' as const)
              : ('pending' as const),
        })),
      ];

      let activeIndex = session.todos.findIndex((t) => t.status === 'active');
      if (activeIndex < 0) {
        if (prepTodo.status === 'done' && session.todos.length > 1) {
          session.todos[1].status = 'active';
          activeIndex = 1;
        } else {
          session.todos[0].status = 'active';
          activeIndex = 0;
        }
      }
      session.activeTodoIndex = activeIndex;
    } else {
      session.todos = titles.map((title, i) => ({
        title,
        status: i === 0 ? ('active' as const) : ('pending' as const),
      }));
      session.activeTodoIndex = 0;
    }

    const todoList = session.todos
      .map((t, i) => {
        const icon =
          t.status === 'done' ? '✅' : t.status === 'active' ? '🔨' : '⬜';
        return `${icon} ${i + 1}. ${t.title}`;
      })
      .join('\n');
    const count = session.todos.length;

    return {
      text:
        `📋 TODO list set (${count} items):\n${todoList}\n\n` +
        (prepTodo
          ? '⚠️ Preserved mandatory TODO #1 for git/worktree preparation.\n\n'
          : '') +
        `Now create ONE unified plan covering ALL ${count} TODO items.\n` +
        `Structure the plan with clear sections (## TODO #1, ## TODO #2, etc.).\n` +
        `All TODOs will be planned together, then implemented sequentially.`,
    };
  } catch {
    return {
      text: 'Failed to parse TODO list. Use JSON array format: ["item1", "item2"]',
    };
  }
}
