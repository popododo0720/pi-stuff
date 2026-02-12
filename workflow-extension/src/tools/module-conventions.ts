// tools/module-conventions.ts — module_conventions tool
// Per-module convention management for multi-module projects.

import { StringEnum } from '@mariozechner/pi-ai';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import {
  MAX_MEMORY_VALUE_LENGTH,
  MAX_MODULE_CONVENTIONS,
  MAX_MODULES,
  MAX_RULE_PATTERN_LENGTH,
  MAX_RULES,
} from '../constants';
import {
  deleteModule,
  isValidModuleName,
  listModules,
  loadModule,
  saveModule,
} from '../storage/modules';

// Helper to build text response
function t(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

/**
 * Register the module_conventions tool.
 * Manages per-module conventions and rules for multi-codebase projects.
 */
export function registerModuleConventionsTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'module_conventions',
    label: 'Module Conventions',
    description:
      'Manage per-module conventions. For multi-module projects, ' +
      'store conventions/rules per codebase. Each module has a root path; ' +
      'conventions are injected into prompts only when working on files under that path. ' +
      '(e.g. web-server module → applied when working under src/web-server/)',
    parameters: Type.Object({
      action: StringEnum([
        'create',
        'list',
        'get',
        'addConvention',
        'addRule',
        'removeConvention',
        'removeRule',
        'delete',
      ] as const),
      module: Type.Optional(
        Type.String({
          description: 'Module name (alphanumeric/hyphens, e.g. web-server)',
        }),
      ),
      path: Type.Optional(
        Type.String({
          description: 'Module root path (for create, e.g. src/web-server)',
        }),
      ),
      value: Type.Optional(
        Type.String({
          description: "Convention text or rule ('pattern|rule' format)",
        }),
      ),
      index: Type.Optional(
        Type.Number({
          description: 'Index of item to remove (0-based)',
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      switch (params.action) {
        // ── List all modules ─────────────────────────────────────
        case 'list': {
          const modules = listModules(ctx.cwd);
          if (modules.length === 0) return t('No modules registered.');
          const lines = modules.map((name) => {
            const data = loadModule(ctx.cwd, name);
            return `- ${name} (${data.path}) — ${data.conventions.length} conventions, ${data.rules.length} rules`;
          });
          return t(`Modules:\n${lines.join('\n')}`);
        }

        // ── Create new module ────────────────────────────────────
        case 'create': {
          if (!params.module) return t('module is required.');
          if (!params.path) return t('path is required (e.g. src/web-server).');
          if (!isValidModuleName(params.module))
            return t(
              'Module name must be alphanumeric/hyphens only (max 50 chars).',
            );
          if (listModules(ctx.cwd).length >= MAX_MODULES)
            return t(`Max ${MAX_MODULES} modules reached.`);
          const existing = loadModule(ctx.cwd, params.module);
          if (existing.path)
            return t(`Module '${params.module}' already exists.`);
          const err = saveModule(ctx.cwd, params.module, {
            path: params.path,
            conventions: [],
            rules: [],
          });
          if (err) return t(`Create failed: ${err}`);
          return t(`Module '${params.module}' created (path: ${params.path}).`);
        }

        // ── Get module details ───────────────────────────────────
        case 'get': {
          if (!params.module) return t('module is required.');
          const data = loadModule(ctx.cwd, params.module);
          if (!data.path) return t(`Module '${params.module}' not found.`);
          let text = `Module: ${params.module} (${data.path})\n`;
          text += `\nConventions (${data.conventions.length}):\n`;
          text +=
            data.conventions.length > 0
              ? data.conventions.map((c, i) => `  ${i}. ${c}`).join('\n')
              : '  (none)';
          text += `\n\nRules (${data.rules.length}):\n`;
          text +=
            data.rules.length > 0
              ? data.rules
                  .map((r, i) => `  ${i}. [${r.pattern}] ${r.rule}`)
                  .join('\n')
              : '  (none)';
          return t(text);
        }

        // ── Add convention to module ─────────────────────────────
        case 'addConvention': {
          if (!params.module) return t('module is required.');
          if (!params.value) return t('value is required.');
          const data = loadModule(ctx.cwd, params.module);
          if (!data.path) return t(`Module '${params.module}' not found.`);
          if (data.conventions.length >= MAX_MODULE_CONVENTIONS)
            return t(`Max ${MAX_MODULE_CONVENTIONS} conventions reached.`);
          data.conventions.push(params.value.slice(0, MAX_MEMORY_VALUE_LENGTH));
          const err = saveModule(ctx.cwd, params.module, data);
          if (err) return t(`Save failed: ${err}`);
          return t(`Convention added to ${params.module}.`);
        }

        // ── Add rule to module ───────────────────────────────────
        case 'addRule': {
          if (!params.module) return t('module is required.');
          if (!params.value)
            return t("value is required ('pattern|rule' format).");
          const data = loadModule(ctx.cwd, params.module);
          if (!data.path) return t(`Module '${params.module}' not found.`);
          if (data.rules.length >= MAX_RULES)
            return t(`Max ${MAX_RULES} rules reached.`);
          const sepIdx = params.value.indexOf('|');
          if (sepIdx < 0) return t("Use 'pattern|rule' format.");
          const pattern = params.value
            .slice(0, sepIdx)
            .slice(0, MAX_RULE_PATTERN_LENGTH);
          const rule = params.value.slice(sepIdx + 1);
          data.rules.push({ pattern, rule });
          const err = saveModule(ctx.cwd, params.module, data);
          if (err) return t(`Save failed: ${err}`);
          return t(`Rule added to ${params.module}.`);
        }

        // ── Remove convention from module ────────────────────────
        case 'removeConvention': {
          if (!params.module) return t('module is required.');
          if (params.index === undefined) return t('index is required.');
          const data = loadModule(ctx.cwd, params.module);
          if (!data.path) return t(`Module '${params.module}' not found.`);
          if (params.index < 0 || params.index >= data.conventions.length)
            return t(`Index out of range (0~${data.conventions.length - 1}).`);
          data.conventions.splice(params.index, 1);
          const err = saveModule(ctx.cwd, params.module, data);
          if (err) return t(`Save failed: ${err}`);
          return t(`Removed ${params.module} convention[${params.index}].`);
        }

        // ── Remove rule from module ──────────────────────────────
        case 'removeRule': {
          if (!params.module) return t('module is required.');
          if (params.index === undefined) return t('index is required.');
          const data = loadModule(ctx.cwd, params.module);
          if (!data.path) return t(`Module '${params.module}' not found.`);
          if (params.index < 0 || params.index >= data.rules.length)
            return t(`Index out of range (0~${data.rules.length - 1}).`);
          data.rules.splice(params.index, 1);
          const err = saveModule(ctx.cwd, params.module, data);
          if (err) return t(`Save failed: ${err}`);
          return t(`Removed ${params.module} rule[${params.index}].`);
        }

        // ── Delete entire module ─────────────────────────────────
        case 'delete': {
          if (!params.module) return t('module is required.');
          const err = deleteModule(ctx.cwd, params.module);
          if (err) return t(`Delete failed: ${err}`);
          return t(`Module '${params.module}' deleted.`);
        }
      }

      return t('Unknown action.');
    },
  });
}
