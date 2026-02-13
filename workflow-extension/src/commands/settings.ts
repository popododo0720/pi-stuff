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
        const menuItems = [
          `📝 Plan (model: ${s.plan?.model || '(current)'}, thinking: ${s.plan?.thinking || '(current)'})`,
          `🔍 Verify (models: ${s.verify?.models?.join(', ') || 'none'}, thinking: ${s.verify?.thinking || '(current)'})`,
          `🔨 Implement (model: ${s.implement?.model || '(current)'}, thinking: ${s.implement?.thinking || '(current)'})`,
          `🧠 Compound (model: ${s.compound?.model || '(current)'}, thinking: ${s.compound?.thinking || '(current)'})`,
          `⏱️ Verify timeout (${settings.verifyTimeout / 1000}s)`,
          `🗺️ Repo Map (${rm?.enabled === false ? 'off' : 'on'}, budget: ${rm?.tokenBudget ?? 2048})`,
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
          ]);
          if (sub?.startsWith('Models')) {
            const models = await pickModels(ctx, s.verify?.models ?? []);
            if (models !== undefined) {
              if (models.length === 0) {
                delete s.verify;
              } else {
                s.verify = { ...s.verify, models };
              }
            }
          } else if (sub?.startsWith('Thinking')) {
            if (!s.verify?.models?.length) {
              ctx.ui.notify(
                'Set verify models first before configuring thinking level.',
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
