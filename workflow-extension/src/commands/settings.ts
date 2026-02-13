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
  if (available.length === 0) {
    ctx.ui.notify('No models available. Configure API keys.', 'error');
    return undefined;
  }

  const selected: string[] = [];
  let picking = true;

  while (picking) {
    const remaining = available.filter((m) => !selected.includes(m));
    const options = [
      ...(selected.length > 0
        ? [`✅ Done (selected: ${selected.join(', ')})`]
        : []),
      ...(current.length > 0 && selected.length === 0
        ? ['🗑️ Clear all']
        : []),
      ...remaining,
    ];

    const pick = await ctx.ui.select(
      `Select verify models (${selected.length} selected)`,
      options,
    );

    if (pick === undefined) {
      picking = false;
    } else if (pick.startsWith('✅ Done') && selected.length > 0) {
      picking = false;
    } else if (pick === '🗑️ Clear all') {
      return [];
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

      const menuItems = [
        `📝 Plan (model: ${s.plan?.model || 'default'}, thinking: ${s.plan?.thinking || 'default'})`,
        `🔍 Verify (models: ${s.verify?.models?.join(', ') || 'none'}, thinking: ${s.verify?.thinking || 'default'})`,
        `🔨 Implement (model: ${s.implement?.model || 'default'}, thinking: ${s.implement?.thinking || 'default'})`,
        `🧠 Compound (model: ${s.compound?.model || 'default'}, thinking: ${s.compound?.thinking || 'default'})`,
        `⏱️ Verify timeout (${settings.verifyTimeout / 1000}s)`,
        '📋 View all settings',
      ];

      const choice = await ctx.ui.select('Workflow Settings', menuItems);
      if (choice === undefined) return;

      switch (choice) {
        // ── Plan stage config ────────────────────────────────────
        case menuItems[0]: {
          const sub = await ctx.ui.select('Plan settings', [
            `Model (${s.plan?.model || 'default'})`,
            `Thinking (${s.plan?.thinking || 'default'})`,
          ]);
          if (!sub) break;
          if (sub.startsWith('Model')) {
            const model = await pickModel(ctx, s.plan?.model);
            if (model !== undefined) {
              s.plan = { ...s.plan, model: model || undefined };
              if (!s.plan.model && !s.plan.thinking) delete s.plan;
            }
          } else {
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
          break;
        }

        // ── Verify stage config ──────────────────────────────────
        case menuItems[1]: {
          const sub = await ctx.ui.select('Verify settings', [
            `Models (${s.verify?.models?.join(', ') || 'none'})`,
            `Thinking (${s.verify?.thinking || 'default'})`,
          ]);
          if (!sub) break;
          if (sub.startsWith('Models')) {
            const models = await pickModels(ctx, s.verify?.models ?? []);
            if (models) {
              s.verify = { ...s.verify, models };
            }
          } else {
            const thinking = await pickThinking(ctx, s.verify?.thinking);
            if (thinking === '') {
              if (s.verify) {
                delete s.verify.thinking;
                if (!s.verify.models?.length) delete s.verify;
              }
            } else if (thinking) {
              s.verify = { ...s.verify, models: s.verify?.models ?? [] };
              s.verify.thinking = thinking;
            }
          }
          break;
        }

        // ── Implement stage config ───────────────────────────────
        case menuItems[2]: {
          const sub = await ctx.ui.select('Implement settings', [
            `Model (${s.implement?.model || 'default'})`,
            `Thinking (${s.implement?.thinking || 'default'})`,
          ]);
          if (!sub) break;
          if (sub.startsWith('Model')) {
            const model = await pickModel(ctx, s.implement?.model);
            if (model !== undefined) {
              s.implement = { ...s.implement, model: model || undefined };
              if (!s.implement.model && !s.implement.thinking)
                delete s.implement;
            }
          } else {
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
          break;
        }

        // ── Compound stage config ────────────────────────────────
        case menuItems[3]: {
          const sub = await ctx.ui.select('Compound settings', [
            `Model (${s.compound?.model || 'default'})`,
            `Thinking (${s.compound?.thinking || 'default'})`,
          ]);
          if (!sub) break;
          if (sub.startsWith('Model')) {
            const model = await pickModel(ctx, s.compound?.model);
            if (model !== undefined) {
              s.compound = { ...s.compound, model: model || undefined };
              if (!s.compound.model && !s.compound.thinking) delete s.compound;
            }
          } else {
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
          break;
        }

        // ── Timeout ──────────────────────────────────────────────
        case menuItems[4]: {
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
              return;
            }
          }
          break;
        }

        // ── View all settings ────────────────────────────────────
        case menuItems[5]: {
          const fmt = (label: string, model?: string, thinking?: string) =>
            `${label}: model=${model || 'default'}, thinking=${thinking || 'default'}`;
          const info =
            '🔧 Workflow Settings\n\n' +
            fmt('📝 Plan', s.plan?.model, s.plan?.thinking) +
            '\n' +
            `🔍 Verify: models=${s.verify?.models?.join(', ') || 'none'}, thinking=${s.verify?.thinking || 'default'}` +
            '\n' +
            fmt('🔨 Implement', s.implement?.model, s.implement?.thinking) +
            '\n' +
            fmt('🧠 Compound', s.compound?.model, s.compound?.thinking) +
            '\n' +
            `⏱️ Timeout: ${settings.verifyTimeout / 1000}s`;
          ctx.ui.notify(info, 'info');
          return;
        }
      }

      settings.stages = s;
      const err = saveSettings(ctx.cwd, settings);
      if (err) ctx.ui.notify(`Save failed: ${err}`, 'error');
      else ctx.ui.notify('Settings saved.', 'info');
    },
  });
}
