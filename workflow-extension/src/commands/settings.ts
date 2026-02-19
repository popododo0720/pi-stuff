// commands/settings.ts — /workflow-settings command
// Interactive UI for configuring per-stage model, thinking level, and timeout.

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from '@mariozechner/pi-coding-agent';
import { loadSettings, saveSettings } from '../storage/settings';
import type { ThinkingLevel } from '../types';

const THINKING_LEVELS: ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
];

/**
 * Helper: pick a single model from available models.
 */
async function pickModel(
  ctx: ExtensionCommandContext,
  current?: string,
): Promise<string | undefined> {
  const available = ctx.modelRegistry.getAvailable();
  const options = [
    ...(current ? ['(clear)'] : []),
    ...available.map((m) => `${m.provider}/${m.id}`),
  ];
  if (options.length === 0) {
    ctx.ui.notify('No models available. Configure API keys.', 'error');
    return undefined;
  }
  const pick = await ctx.ui.select(
    `Select model${current ? ` (current: ${current})` : ''}`,
    options,
  );
  if (pick === '(clear)') return '';
  return pick;
}

/**
 * Helper: pick multiple models (multi-pick loop).
 */
async function pickModels(
  ctx: ExtensionCommandContext,
  current: string[],
): Promise<string[] | undefined> {
  const available = ctx.modelRegistry
    .getAvailable()
    .map((m) => `${m.provider}/${m.id}`);
  const canClear = current.length > 0;
  if (available.length === 0) {
    if (!canClear) {
      ctx.ui.notify('No models available. Configure API keys.', 'error');
      return undefined;
    }
    const pick = await ctx.ui.select(
      'No models available. Clear current verify models?',
      ['(clear)'],
    );
    if (pick === '(clear)') return [];
    return undefined;
  }

  const selected: string[] = [];
  let picking = true;

  while (picking) {
    const remaining = available.filter((m) => !selected.includes(m));
    const doneLabel = `✅ Done (selected: ${selected.join(', ')})`;
    const options = [
      ...(canClear ? ['(clear)'] : []),
      ...(selected.length > 0 ? [doneLabel] : []),
      ...remaining,
    ];

    const pick = await ctx.ui.select(
      `Select verify models (${selected.length} selected)`,
      options,
    );

    if (pick === undefined) {
      picking = false;
    } else if (pick === '(clear)') {
      return [];
    } else if (pick === doneLabel) {
      picking = false;
    } else {
      selected.push(pick);
      ctx.ui.notify(`+ ${pick}`, 'info');
    }
  }

  return selected.length > 0 ? selected : undefined;
}

/**
 * Helper: pick a thinking level.
 */
async function pickThinking(
  ctx: ExtensionCommandContext,
  current?: ThinkingLevel,
): Promise<ThinkingLevel | '' | undefined> {
  const options = [...(current ? ['(clear)'] : []), ...THINKING_LEVELS];
  const pick = await ctx.ui.select(
    `Thinking level${current ? ` (current: ${current})` : ''}`,
    options,
  );
  if (pick === '(clear)') return '';
  return pick as ThinkingLevel | undefined;
}

/**
 * Register the /workflow-settings command.
 * Provides per-stage configuration for model and thinking level.
 */
export function registerSettingsCommand(pi: ExtensionAPI) {
  pi.registerCommand('workflow-settings', {
    description: 'Configure workflow settings (per-stage model/thinking)',
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const settings = loadSettings(ctx.cwd);
      const s = settings.stages;

      let configuring = true;
      while (configuring) {
        const rm = settings.repoMap;
        const g = settings.git;
        const menuItems = [
          `📝 Plan (model: ${s.plan?.model || '(current)'}, thinking: ${s.plan?.thinking || '(current)'})`,
          `🔍 Verify (models: ${s.verify?.models?.join(', ') || 'none'}, thinking: ${s.verify?.thinking || '(current)'})`,
          `🔨 Implement (model: ${s.implement?.model || '(current)'}, thinking: ${s.implement?.thinking || '(current)'})`,
          `🧠 Compound (model: ${s.compound?.model || '(current)'}, thinking: ${s.compound?.thinking || '(current)'})`,
          `⏱️ Verify timeout (${settings.verifyTimeout / 1000}s)`,
          `🗺️ Repo Map (${rm?.enabled === false ? 'off' : 'on'}, budget: ${rm?.tokenBudget ?? 2048})`,
          `🧬 Git Automation (${g?.enabled === false ? 'off' : 'on'}, commit/todo: ${g?.commitPerTodo === false ? 'off' : 'on'}, push/todo: ${g?.pushPerTodo === true ? 'on' : 'off'})`,
          `🔄 Max Retries (${settings.maxRetries ?? 5})`,
          `🛡️ Pre-flight (${settings.preflight?.enabled === false ? 'off' : 'on'})`,
          '✅ Done',
        ];

        const choice = await ctx.ui.select('Workflow Settings', menuItems);
        if (choice === undefined || choice === '✅ Done') {
          configuring = false;
          break;
        }

        if (choice.startsWith('📝')) {
          // ── Plan stage config ────────────────────────────────────
          const sub = await ctx.ui.select('Plan settings', [
            `Model (${s.plan?.model || 'default'})`,
            `Thinking (${s.plan?.thinking || 'default'})`,
          ]);
          if (sub?.startsWith('Model')) {
            const model = await pickModel(ctx, s.plan?.model);
            if (model !== undefined) {
              s.plan = { ...s.plan, model: model || undefined };
              if (!s.plan.model && !s.plan.thinking) delete s.plan;
            }
          } else if (sub?.startsWith('Thinking')) {
            const thinking = await pickThinking(ctx, s.plan?.thinking);
            if (thinking === '') {
              if (s.plan) {
                delete s.plan.thinking;
                if (!s.plan.model) delete s.plan;
              }
            } else if (thinking) {
              s.plan = { ...s.plan, thinking };
            }
          }
        } else if (choice.startsWith('🔍')) {
          // ── Verify stage config ──────────────────────────────────
          const sub = await ctx.ui.select('Verify settings', [
            `Models (${s.verify?.models?.join(', ') || 'none'})`,
            `Thinking (${s.verify?.thinking || 'default'})`,
            'Domains',
          ]);
          if (sub?.startsWith('Models')) {
            const models = await pickModels(ctx, s.verify?.models ?? []);
            if (models !== undefined) {
              if (models.length === 0) {
                // Preserve thinking + domains when clearing models
                const existing = s.verify;
                if (existing?.domains || existing?.thinking) {
                  s.verify = {
                    models: [],
                    ...(existing.thinking
                      ? { thinking: existing.thinking }
                      : {}),
                    ...(existing.domains ? { domains: existing.domains } : {}),
                  };
                } else {
                  delete s.verify;
                }
              } else {
                s.verify = { ...s.verify, models };
              }
            }
          } else if (sub?.startsWith('Thinking')) {
            if (!s.verify) {
              ctx.ui.notify(
                'Set verify models or domain models first.',
                'warn',
              );
            } else {
              const thinking = await pickThinking(ctx, s.verify?.thinking);
              if (thinking === '') {
                delete s.verify.thinking;
              } else if (thinking) {
                s.verify.thinking = thinking;
              }
            }
          } else if (sub === 'Domains') {
            const { ALL_DOMAINS } = await import('../verification/domains');
            const domainConfig = s.verify?.domains ?? {};
            const items = ALL_DOMAINS.map((d) => {
              const dc = domainConfig[d.id];
              const status = dc?.enabled === false ? '❌' : '✅';
              const models = dc?.models?.join(', ') || 'inherit';
              return `${status} ${d.name} (${models})`;
            });
            const pick = await ctx.ui.select('Domain settings', [
              ...items,
              '← Back',
            ]);
            if (pick && pick !== '← Back') {
              const idx = items.indexOf(pick);
              if (idx >= 0) {
                const domain = ALL_DOMAINS[idx];
                const dc = { ...(domainConfig[domain.id] ?? {}) };
                const action = await ctx.ui.select(`${domain.name} settings`, [
                  `Enabled (${dc.enabled !== false ? 'yes' : 'no'})`,
                  `Models (${dc.models?.join(', ') || 'inherit from verify'})`,
                  `Thinking (${dc.thinking || 'inherit'})`,
                ]);
                if (action?.startsWith('Enabled')) {
                  dc.enabled = dc.enabled === false ? undefined : false;
                } else if (action?.startsWith('Models')) {
                  const models = await pickModels(ctx, dc.models ?? []);
                  if (models !== undefined)
                    dc.models = models.length ? models : undefined;
                } else if (action?.startsWith('Thinking')) {
                  const t = await pickThinking(ctx, dc.thinking);
                  if (t === '') dc.thinking = undefined;
                  else if (t) dc.thinking = t;
                }
                if (!s.verify) s.verify = { models: [] };
                if (!s.verify.domains) s.verify.domains = {};
                // Clean empty config
                if (
                  !dc.models?.length &&
                  !dc.thinking &&
                  dc.enabled !== false
                ) {
                  delete s.verify.domains[domain.id];
                } else {
                  s.verify.domains[domain.id] = dc;
                }
                if (Object.keys(s.verify.domains).length === 0)
                  delete s.verify.domains;
              }
            }
          }
        } else if (choice.startsWith('🔨')) {
          // ── Implement stage config ───────────────────────────────
          const sub = await ctx.ui.select('Implement settings', [
            `Model (${s.implement?.model || 'default'})`,
            `Thinking (${s.implement?.thinking || 'default'})`,
          ]);
          if (sub?.startsWith('Model')) {
            const model = await pickModel(ctx, s.implement?.model);
            if (model !== undefined) {
              s.implement = { ...s.implement, model: model || undefined };
              if (!s.implement.model && !s.implement.thinking)
                delete s.implement;
            }
          } else if (sub?.startsWith('Thinking')) {
            const thinking = await pickThinking(ctx, s.implement?.thinking);
            if (thinking === '') {
              if (s.implement) {
                delete s.implement.thinking;
                if (!s.implement.model) delete s.implement;
              }
            } else if (thinking) {
              s.implement = { ...s.implement, thinking };
            }
          }
        } else if (choice.startsWith('🧠')) {
          // ── Compound stage config ────────────────────────────────
          const sub = await ctx.ui.select('Compound settings', [
            `Model (${s.compound?.model || 'default'})`,
            `Thinking (${s.compound?.thinking || 'default'})`,
          ]);
          if (sub?.startsWith('Model')) {
            const model = await pickModel(ctx, s.compound?.model);
            if (model !== undefined) {
              s.compound = { ...s.compound, model: model || undefined };
              if (!s.compound.model && !s.compound.thinking) delete s.compound;
            }
          } else if (sub?.startsWith('Thinking')) {
            const thinking = await pickThinking(ctx, s.compound?.thinking);
            if (thinking === '') {
              if (s.compound) {
                delete s.compound.thinking;
                if (!s.compound.model) delete s.compound;
              }
            } else if (thinking) {
              s.compound = { ...s.compound, thinking };
            }
          }
        } else if (choice.startsWith('⏱️')) {
          // ── Timeout ──────────────────────────────────────────────
          const input = await ctx.ui.input(
            'Verify timeout (seconds):',
            String(settings.verifyTimeout / 1000),
          );
          if (input) {
            const seconds = Number.parseInt(input, 10);
            if (!Number.isNaN(seconds) && seconds > 0 && seconds <= 600) {
              settings.verifyTimeout = seconds * 1000;
            } else {
              ctx.ui.notify('Enter a number between 1 and 600.', 'error');
            }
          }
        } else if (choice.startsWith('🗺️')) {
          // ── Repo Map config ──────────────────────────────────────
          const sub = await ctx.ui.select('Repo Map settings', [
            `Enabled (${settings.repoMap?.enabled === false ? 'off' : 'on'})`,
            `Token Budget (${settings.repoMap?.tokenBudget ?? 2048})`,
          ]);
          if (sub?.startsWith('Enabled')) {
            const pick = await ctx.ui.select('Repo Map enabled', ['on', 'off']);
            if (pick) {
              settings.repoMap = {
                ...settings.repoMap,
                enabled: pick === 'on',
              };
            }
          } else if (sub?.startsWith('Token')) {
            const input = await ctx.ui.input(
              'Token budget (256–8192):',
              String(settings.repoMap?.tokenBudget ?? 2048),
            );
            if (input) {
              const val = Number.parseInt(input, 10);
              if (!Number.isNaN(val) && val >= 256 && val <= 8192) {
                settings.repoMap = { ...settings.repoMap, tokenBudget: val };
              } else {
                ctx.ui.notify('Enter a number between 256 and 8192.', 'error');
              }
            }
          }
        } else if (choice.startsWith('🧬')) {
          // ── Git automation config ────────────────────────────────
          const git = settings.git ?? {};
          const sub = await ctx.ui.select('Git Automation settings', [
            `Enabled (${git.enabled === false ? 'off' : 'on'})`,
            `Commit per TODO (${git.commitPerTodo === false ? 'off' : 'on'})`,
            `Push per TODO (${git.pushPerTodo === true ? 'on' : 'off'})`,
            `Push on Complete (${git.pushOnComplete === false ? 'off' : 'on'})`,
            `Require Clean Start (${git.requireCleanStart === false ? 'off' : 'on'})`,
            `Use Workflow Branch (${git.useWorkflowBranch === false ? 'off' : 'on'})`,
            `Use Workflow Worktree (${git.useWorkflowWorktree === false ? 'off' : 'on'})`,
          ]);

          const pickBoolean = async (title: string) =>
            await ctx.ui.select(title, ['on', 'off']);

          if (sub?.startsWith('Enabled')) {
            const pick = await pickBoolean('Git automation enabled');
            if (pick) settings.git = { ...git, enabled: pick === 'on' };
          } else if (sub?.startsWith('Commit per TODO')) {
            const pick = await pickBoolean('Auto commit per TODO');
            if (pick) settings.git = { ...git, commitPerTodo: pick === 'on' };
          } else if (sub?.startsWith('Push per TODO')) {
            const pick = await pickBoolean('Auto push per TODO');
            if (pick) settings.git = { ...git, pushPerTodo: pick === 'on' };
          } else if (sub?.startsWith('Push on Complete')) {
            const pick = await pickBoolean('Auto push on complete');
            if (pick) settings.git = { ...git, pushOnComplete: pick === 'on' };
          } else if (sub?.startsWith('Require Clean Start')) {
            const pick = await pickBoolean('Require clean git tree at start');
            if (pick)
              settings.git = { ...git, requireCleanStart: pick === 'on' };
          } else if (sub?.startsWith('Use Workflow Branch')) {
            const pick = await pickBoolean('Use workflow branch strategy');
            if (pick)
              settings.git = { ...git, useWorkflowBranch: pick === 'on' };
          } else if (sub?.startsWith('Use Workflow Worktree')) {
            const pick = await pickBoolean('Use workflow worktree strategy');
            if (pick)
              settings.git = { ...git, useWorkflowWorktree: pick === 'on' };
          }
        } else if (choice.startsWith('🔄')) {
          // ── Max Retries ──────────────────────────────────────────
          const input = await ctx.ui.input(
            'Max verification retries (1–20):',
            String(settings.maxRetries ?? 5),
          );
          if (input) {
            const val = Number.parseInt(input, 10);
            if (!Number.isNaN(val) && val >= 1 && val <= 20) {
              settings.maxRetries = val;
            } else {
              ctx.ui.notify('Enter a number between 1 and 20.', 'error');
            }
          }
        } else if (choice.startsWith('🛡️')) {
          // ── Pre-flight toggle ────────────────────────────────────
          const pick = await ctx.ui.select('Pre-flight checks', ['on', 'off']);
          if (pick) {
            settings.preflight = {
              ...settings.preflight,
              enabled: pick === 'on',
            };
          }
        }
      }

      // Save after all changes
      settings.stages = s;
      const err = saveSettings(ctx.cwd, settings);
      if (err) ctx.ui.notify(`Save failed: ${err}`, 'error');
      else ctx.ui.notify('Settings saved.', 'info');
    },
  });
}
