// commands/settings.ts — /workflow-settings command
// Interactive UI for configuring verification models, timeout, retries.

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from '@mariozechner/pi-coding-agent';
import { loadSettings, saveSettings } from '../storage/settings';

/**
 * Register the /workflow-settings command.
 * Provides an interactive menu to configure verification settings.
 */
export function registerSettingsCommand(pi: ExtensionAPI) {
  pi.registerCommand('workflow-settings', {
    description:
      'Configure workflow settings (verification models, timeout, retries)',
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const settings = loadSettings(ctx.cwd);
      const availableModels = ctx.modelRegistry.getAvailable();

      const menuItems = [
        `Verify models (current: ${settings.verifyModels.length > 0 ? settings.verifyModels.join(', ') : 'none'})`,
        `Verify timeout (current: ${settings.verifyTimeout / 1000}s)`,
        `Max retries (current: ${settings.maxRetries})`,
        'View current settings',
      ];

      const choice = await ctx.ui.select('Workflow Settings', menuItems);
      if (choice === undefined) return;

      switch (choice) {
        // ── Model selection (multi-pick) ─────────────────────────
        case menuItems[0]: {
          const modelOptions = availableModels.map(
            (m) => `${m.provider}/${m.id}`,
          );
          if (modelOptions.length === 0) {
            ctx.ui.notify(
              'No models available. Please configure API keys.',
              'error',
            );
            return;
          }

          const selected: string[] = [];
          let picking = true;

          while (picking) {
            const remaining = modelOptions.filter((m) => !selected.includes(m));
            const options = [
              ...(selected.length > 0
                ? [`✅ Done (selected: ${selected.join(', ')})`]
                : []),
              ...remaining,
            ];

            const pick = await ctx.ui.select(
              `Select verify models (${selected.length} selected)`,
              options,
            );

            if (pick === undefined) {
              picking = false;
            } else if (pick === options[0] && selected.length > 0) {
              picking = false;
            } else {
              selected.push(pick);
              ctx.ui.notify(`+ ${pick}`, 'info');
            }
          }

          if (selected.length > 0) {
            settings.verifyModels = selected;
            const err = saveSettings(ctx.cwd, settings);
            if (err) {
              ctx.ui.notify(`Save failed: ${err}`, 'error');
            } else {
              ctx.ui.notify(
                `Verify models set: ${selected.join(', ')}`,
                'info',
              );
            }
          }
          break;
        }

        // ── Timeout configuration ────────────────────────────────
        case menuItems[1]: {
          const input = await ctx.ui.input(
            'Verify timeout (seconds):',
            String(settings.verifyTimeout / 1000),
          );
          if (input) {
            const seconds = parseInt(input, 10);
            if (!Number.isNaN(seconds) && seconds > 0 && seconds <= 600) {
              settings.verifyTimeout = seconds * 1000;
              const err = saveSettings(ctx.cwd, settings);
              if (err) ctx.ui.notify(`Save failed: ${err}`, 'error');
              else ctx.ui.notify(`Timeout: ${seconds}s`, 'info');
            } else {
              ctx.ui.notify('Enter a number between 1 and 600.', 'error');
            }
          }
          break;
        }

        // ── Retry limit configuration ────────────────────────────
        case menuItems[2]: {
          const input = await ctx.ui.input(
            'Max retries:',
            String(settings.maxRetries),
          );
          if (input) {
            const retries = parseInt(input, 10);
            if (!Number.isNaN(retries) && retries >= 1 && retries <= 10) {
              settings.maxRetries = retries;
              const err = saveSettings(ctx.cwd, settings);
              if (err) ctx.ui.notify(`Save failed: ${err}`, 'error');
              else ctx.ui.notify(`Max retries: ${retries}`, 'info');
            } else {
              ctx.ui.notify('Enter a number between 1 and 10.', 'error');
            }
          }
          break;
        }

        // ── Display current settings ─────────────────────────────
        case menuItems[3]: {
          const info =
            '🔧 Workflow Settings\n\n' +
            `Verify models: ${settings.verifyModels.length > 0 ? settings.verifyModels.join(', ') : '(none)'}\n` +
            `Timeout: ${settings.verifyTimeout / 1000}s\n` +
            `Max retries: ${settings.maxRetries}`;
          ctx.ui.notify(info, 'info');
          break;
        }
      }
    },
  });
}
