// tools/transition.ts — workflow_transition tool
// Manages state machine: plan → verify → implement → verify → compound → done.

import { StringEnum } from '@mariozechner/pi-ai';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import { STATE_EMOJI, TOOL_NAME, VALID_TRANSITIONS } from '../constants';
import { updateStatusBar } from '../context/status';
import { savePlanDocument } from '../storage/plan';
import { loadSettings } from '../storage/settings';
import { saveSolution } from '../storage/solution';
import type { StageConfig, WorkflowSession } from '../types';
import {
  formatVerificationSummary,
  runParallelVerification,
  saveVerificationResult,
} from '../verification';

// ── Deferred compaction ──────────────────────────────────────────
// Tool execution 중 ctx.compact() 직접 호출 시 race condition 발생.
// 대신 플래그만 세팅하고, before_agent_start에서 실행.
let PENDING_COMPACT: string | null = null;

export function getPendingCompact(): string | null {
  return PENDING_COMPACT;
}

export function clearPendingCompact(): void {
  PENDING_COMPACT = null;
}

/**
 * Apply stage-specific model and thinking level.
 * Skips if config is undefined or fields are not set.
 */
export async function applyStageConfig(
  pi: ExtensionAPI,
  ctx: {
    modelRegistry?: { getAvailable(): Array<{ provider: string; id: string }> };
  },
  config?: StageConfig,
): Promise<void> {
  if (!config) return;
  if (config.model) {
    const [provider, ...idParts] = config.model.split('/');
    const modelId = idParts.join('/');
    const available = ctx.modelRegistry?.getAvailable() ?? [];
    const found = available.find(
      (m) => m.provider === provider && m.id === modelId,
    );
    if (found) {
      await pi.setModel(found);
    }
  }
  if (config.thinking) {
    pi.setThinkingLevel(config.thinking);
  }
}

// Helper to build a text content response
function textResult(text: string, session?: WorkflowSession) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(session ? { details: session } : {}),
  };
}

async function runGit(
  pi: ExtensionAPI,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string; code: number }> {
  try {
    const result = await pi.exec('git', args);
    return {
      ok: result.code === 0,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
      code: result.code,
    };
  } catch (e) {
    return {
      ok: false,
      stdout: '',
      stderr: e instanceof Error ? e.message : 'git command failed',
      code: -1,
    };
  }
}

async function hasUncommittedChanges(pi: ExtensionAPI): Promise<boolean> {
  const status = await runGit(pi, ['status', '--porcelain']);
  if (!status.ok) return false;
  return status.stdout.length > 0;
}

async function autoCommitTodo(
  pi: ExtensionAPI,
  session: WorkflowSession,
  todoIndex: number,
): Promise<{ ok: boolean; message: string }> {
  const add = await runGit(pi, ['add', '-A']);
  if (!add.ok) {
    return {
      ok: false,
      message: `git add failed: ${add.stderr || `exit ${add.code}`}`,
    };
  }

  const hasChanges = await hasUncommittedChanges(pi);
  if (!hasChanges) {
    return { ok: true, message: 'No changes to commit for this TODO.' };
  }

  const todo = session.todos[todoIndex];
  const title = todo?.title ?? 'unknown';
  const msg = `chore(workflow): TODO #${todoIndex + 1} - ${title}`;
  const commit = await runGit(pi, ['commit', '-m', msg]);
  if (!commit.ok) {
    return {
      ok: false,
      message: `git commit failed: ${commit.stderr || `exit ${commit.code}`}`,
    };
  }

  const hash = await runGit(pi, ['rev-parse', '--short', 'HEAD']);
  return {
    ok: true,
    message: `Committed TODO #${todoIndex + 1}${hash.ok && hash.stdout ? ` (${hash.stdout})` : ''}`,
  };
}

async function autoPush(
  pi: ExtensionAPI,
  branch?: string,
): Promise<{ ok: boolean; message: string }> {
  const push = branch
    ? await runGit(pi, ['push', 'origin', branch])
    : await runGit(pi, ['push']);
  if (!push.ok) {
    return {
      ok: false,
      message: `git push failed: ${push.stderr || `exit ${push.code}`}`,
    };
  }
  return {
    ok: true,
    message: branch ? `Pushed origin/${branch}` : 'Pushed current branch',
  };
}

/**
 * Register the workflow_transition tool.
 * Handles all state transitions with automatic parallel verification.
 */
export function registerTransitionTool(
  pi: ExtensionAPI,
  getSession: () => WorkflowSession | null,
  setSession: (s: WorkflowSession) => void,
) {
  pi.registerTool({
    name: TOOL_NAME,
    label: 'Workflow Transition',
    description:
      'Transition the current workflow stage. ' +
      'Supports: approvePlan, implDone, replan, compoundDone, setTodos.',
    parameters: Type.Object({
      action: StringEnum([
        'approvePlan',
        'implDone',
        'replan',
        'compoundDone',
        'setTodos',
      ] as const),
      content: Type.Optional(
        Type.String({
          description:
            'Step deliverable (plan content, verification result, compound summary)',
        }),
      ),
      reason: Type.Optional(Type.String({ description: 'Failure reason' })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const session = getSession();
      if (!session) {
        return textResult('No active workflow. Start with /workflow.');
      }

      const settings = loadSettings(ctx.cwd);

      // Validate transition is allowed from current state
      const allowed = VALID_TRANSITIONS[params.action];
      if (!allowed || !allowed.includes(session.state)) {
        return textResult(
          `Invalid transition: cannot ${params.action} in ${session.state} state.`,
        );
      }

      switch (params.action) {
        // ── Plan approved → auto-verify ──────────────────────────
        case 'approvePlan': {
          if (!params.content?.trim()) {
            return textResult('Plan content is empty.');
          }
          session.planContent = params.content;

          const savedPath = savePlanDocument(
            ctx.cwd,
            session.description,
            params.content,
          );

          session.state = 'verifyPlan';
          setSession(session);
          updateStatusBar(ctx, session);

          onUpdate?.({
            content: [
              {
                type: 'text' as const,
                text:
                  `🔍 Verifying plan... (${(settings.stages.verify?.models ?? []).join(' + ') || 'no models'})` +
                  (savedPath ? `\n📄 Plan saved: ${savedPath}` : ''),
              },
            ],
          });

          try {
            const result = await runParallelVerification(
              'plan',
              session.planContent,
              session.description,
              settings,
              pi,
              ctx.cwd,
              signal,
            );

            if (result.passed) {
              session.state = 'implement';
              session.retryCount = 0;
              const summary = formatVerificationSummary(result);
              const hasWarnings = summary.includes('🟡');
              const hasInfo = summary.includes('🔵');
              session.verifyPlanResult =
                hasWarnings || hasInfo
                  ? `Plan passed with notes:\n${summary}`
                  : 'Auto-verification passed';
              setSession(session);
              updateStatusBar(ctx, session);
              await applyStageConfig(pi, ctx, settings.stages.implement);
              return textResult(
                '✅ Plan verified! Moving to implementation.' +
                  (savedPath ? `\n📄 Plan saved: ${savedPath}` : '') +
                  (hasWarnings
                    ? '\n\n⚠️ **Address these warnings during implementation:**'
                    : '') +
                  `\n\n${summary}`,
                session,
              );
            }

            session.retryCount++;
            session.state = 'verifyPlan';
            session.verifyPlanResult = formatVerificationSummary(result);
            const resultPath = saveVerificationResult(
              ctx.cwd,
              'plan',
              result,
              session.id,
            );
            setSession(session);
            updateStatusBar(ctx, session);
            return textResult(
              `❌ Plan verification failed (attempt ${session.retryCount}). Please revise.\n\n` +
                formatVerificationSummary(result) +
                (resultPath ? `\n\n📋 Full results: ${resultPath}` : ''),
              session,
            );
          } catch (e) {
            const isNoModels =
              e instanceof Error &&
              e.message.includes('No verification models');
            setSession(session);
            updateStatusBar(ctx, session);
            return textResult(
              isNoModels
                ? '⚠️ No verification models. Falling back to manual verification. Use /workflow-settings to configure.' +
                    (savedPath ? `\n📄 Plan saved: ${savedPath}` : '')
                : '⚠️ Auto-verification error. Falling back to manual verification.' +
                    (savedPath ? `\n📄 Plan saved: ${savedPath}` : ''),
              session,
            );
          }
        }

        // ── Implementation done → auto-verify ────────────────────
        case 'implDone': {
          session.state = 'verifyImpl';
          setSession(session);
          updateStatusBar(ctx, session);

          onUpdate?.({
            content: [
              {
                type: 'text' as const,
                text: `🔍 Verifying implementation... (${(settings.stages.verify?.models ?? []).join(' + ') || 'no models'})`,
              },
            ],
          });

          try {
            const result = await runParallelVerification(
              'impl',
              session.planContent,
              session.description,
              settings,
              pi,
              ctx.cwd,
              signal,
              params.content,
            );

            if (result.passed) {
              // Verified → move to compound
              session.state = 'compound';
              session.retryCount = 0;
              setSession(session);
              updateStatusBar(ctx, session);
              await applyStageConfig(pi, ctx, settings.stages.compound);
              return textResult(
                '✅ Implementation verified! Moving to compound stage.\n\n' +
                  'Analyze what you learned and call workflow_transition(action: "compoundDone", content: "<summary>").\n\n' +
                  formatVerificationSummary(result),
                session,
              );
            }

            session.retryCount++;
            session.state = 'verifyImpl';
            const implResultPath = saveVerificationResult(
              ctx.cwd,
              'impl',
              result,
              session.id,
            );
            setSession(session);
            updateStatusBar(ctx, session);
            return textResult(
              `❌ Implementation verification failed (attempt ${session.retryCount}). Please fix.\n\n` +
                formatVerificationSummary(result) +
                (implResultPath
                  ? `\n\n📋 Full results: ${implResultPath}`
                  : ''),
              session,
            );
          } catch (e) {
            const isNoModels =
              e instanceof Error &&
              e.message.includes('No verification models');
            setSession(session);
            updateStatusBar(ctx, session);
            return textResult(
              isNoModels
                ? '⚠️ No verification models. Falling back to manual verification. Use /workflow-settings to configure.'
                : '⚠️ Auto-verification error. Falling back to manual verification.',
              session,
            );
          }
        }

        // ── Compound done → advance TODO or finish ────────────────
        case 'compoundDone': {
          const summary = params.content?.trim() || '';
          let solutionPath: string | null = null;
          if (summary) {
            solutionPath = saveSolution(
              ctx.cwd,
              session.description,
              summary,
              session.id,
            );
          }

          // Check if there are more TODOs to process
          if (
            session.activeTodoIndex >= 0 &&
            session.activeTodoIndex < session.todos.length
          ) {
            const completedIndex = session.activeTodoIndex;

            // Mark current TODO as done
            session.todos[completedIndex].status = 'done';
            const nextIndex = completedIndex + 1;

            if (nextIndex < session.todos.length) {
              const gitNotes: string[] = [];
              if (
                settings.git?.enabled !== false &&
                settings.git?.commitPerTodo !== false
              ) {
                const commit = await autoCommitTodo(
                  pi,
                  session,
                  completedIndex,
                );
                gitNotes.push(
                  commit.ok ? `📦 ${commit.message}` : `⚠️ ${commit.message}`,
                );

                if (commit.ok && settings.git?.pushPerTodo) {
                  const push = await autoPush(pi, session.gitBranch);
                  gitNotes.push(
                    push.ok ? `🚀 ${push.message}` : `⚠️ ${push.message}`,
                  );
                }
              }

              // Advance to next TODO — skip plan stage, go straight to implement
              session.todos[nextIndex].status = 'active';
              session.activeTodoIndex = nextIndex;
              session.state = 'implement';
              // Keep planContent and verifyPlanResult — already verified unified plan
              session.retryCount = 0;
              setSession(session);
              updateStatusBar(ctx, session);
              await applyStageConfig(pi, ctx, settings.stages.implement);

              const doneCount = session.todos.filter(
                (t) => t.status === 'done',
              ).length;
              const todoList = session.todos
                .map((t, i) => {
                  const icon =
                    t.status === 'done'
                      ? '✅'
                      : t.status === 'active'
                        ? '🔨'
                        : '⬜';
                  return `${icon} ${i + 1}. ${t.title}`;
                })
                .join('\n');

              // Defer compaction — will run in next before_agent_start
              PENDING_COMPACT =
                `Workflow "${session.description}" — TODO #${nextIndex} completed. ` +
                `Preserve: unified plan, TODO list progress, key decisions. ` +
                `Discard: previous TODO implementation details, verification output, code diffs.`;

              return textResult(
                `📋 TODO [${doneCount}/${session.todos.length}] — Moving to next item\n\n` +
                  `${todoList}\n\n` +
                  (solutionPath
                    ? `**Solution saved:** ${solutionPath}\n\n`
                    : '') +
                  (gitNotes.length > 0
                    ? `**Git automation:**\n${gitNotes.join('\n')}\n\n`
                    : '') +
                  `Now implement TODO #${nextIndex + 1}: "${session.todos[nextIndex].title}"\n` +
                  `Refer to the TODO #${nextIndex + 1} section in the approved plan above.`,
                session,
              );
            }
          }

          // All TODOs done (or no TODOs) — workflow complete
          session.state = 'done';
          session.completed = true;
          setSession(session);
          updateStatusBar(ctx, session);

          // Defer compaction — will run in next before_agent_start
          PENDING_COMPACT =
            `Workflow "${session.description}" completed. ` +
            `Preserve: task description, final outcome, key decisions. ` +
            `Discard: implementation details, verification output, code diffs.`;

          const todoSummary =
            session.todos.length > 0
              ? `**TODOs completed:** ${session.todos.length}/${session.todos.length}\n`
              : '';

          return textResult(
            '🎉 Workflow Complete!\n\n' +
              `**Task:** ${session.description}\n` +
              `**ID:** ${session.id}\n` +
              todoSummary +
              (solutionPath ? `**Solution saved:** ${solutionPath}\n` : '') +
              '\nLearnings from this workflow have been captured for future reference.',
            session,
          );
        }

        // ── Set TODOs for multi-item workflows ──────────────────
        case 'setTodos': {
          try {
            const raw: unknown[] = JSON.parse(params.content || '[]');
            if (!Array.isArray(raw) || raw.length === 0) {
              return textResult(
                'Invalid TODO list. Provide a JSON array of strings.',
              );
            }
            const titles = raw.map((t) => String(t).trim()).filter(Boolean);
            if (titles.length === 0) {
              return textResult(
                'All TODO items are empty. Provide non-empty strings.',
              );
            }
            const prepTodo =
              session.startupPrepLocked && session.todos.length > 0
                ? session.todos[0]
                : null;

            if (prepTodo) {
              // Preserve mandatory startup prep as TODO #1.
              // Rebuild remaining list from user titles, replacing any auto placeholder.
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

              let activeIndex = session.todos.findIndex(
                (t) => t.status === 'active',
              );
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

            setSession(session);

            const todoList = session.todos
              .map((t, i) => {
                const icon =
                  t.status === 'done'
                    ? '✅'
                    : t.status === 'active'
                      ? '🔨'
                      : '⬜';
                return `${icon} ${i + 1}. ${t.title}`;
              })
              .join('\n');
            const effectiveCount = session.todos.length;
            return textResult(
              `📋 TODO list set (${effectiveCount} items):\n${todoList}\n\n` +
                (prepTodo
                  ? '⚠️ Preserved mandatory TODO #1 for git/worktree preparation.\n\n'
                  : '') +
                `Now create ONE unified plan covering ALL ${effectiveCount} TODO items.\n` +
                `Structure the plan with clear sections (## TODO #1, ## TODO #2, etc.).\n` +
                `All TODOs will be planned together, then implemented sequentially.`,
              session,
            );
          } catch {
            return textResult(
              'Failed to parse TODO list. Use JSON array format: ["item1", "item2"]',
            );
          }
        }

        // ── Replan ───────────────────────────────────────────────
        case 'replan':
          session.state = 'plan';
          session.verifyPlanResult = '';
          await applyStageConfig(pi, ctx, settings.stages.plan);
          break;
      }

      // Common exit
      setSession(session);
      updateStatusBar(ctx, session);

      const statusText =
        session.state === 'done'
          ? `${STATE_EMOJI.done} Workflow complete! Task: "${session.description}"`
          : `${STATE_EMOJI[session.state]} Transitioned to: ${session.state} | Task: "${session.description}"`;

      return textResult(statusText, session);
    },
  });
}
