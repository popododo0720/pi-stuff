// tools/project-memory.ts — project_memory tool
// CRUD operations for global project conventions, rules, workflows, notes.

import { StringEnum } from '@mariozechner/pi-ai';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import {
  MAX_MEMORY_ENTRIES,
  MAX_MEMORY_VALUE_LENGTH,
  MAX_RULE_PATTERN_LENGTH,
  MAX_RULES,
} from '../constants';
import { loadMemory, saveMemory } from '../storage/memory';
import type { ConditionalRule, PatternEntry } from '../types';

// Helper to build text response
function t(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

/**
 * Register the project_memory tool.
 * Manages global conventions, conditional rules, workflows, current work, and notes.
 */
export function registerProjectMemoryTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'project_memory',
    label: 'Project Memory',
    description:
      'Manage project memory. Store/retrieve/delete: global conventions, ' +
      'conditional rules (directory/file pattern based), key workflows, current work, notes, ' +
      'patterns, gotchas, decisions. ' +
      "Rules use 'pattern|rule' format (e.g. 'src/api/**|error handling required'). " +
      'Save any project information worth remembering.',
    parameters: Type.Object({
      action: StringEnum(['get', 'add', 'remove', 'clear'] as const),
      category: StringEnum([
        'conventions',
        'rules',
        'workflows',
        'currentWork',
        'notes',
        'patterns',
        'gotchas',
        'decisions',
      ] as const),
      value: Type.Optional(
        Type.String({
          description:
            "Value to store. conventions/notes: text. rules: 'pattern|rule'. " +
            "workflows: 'name|description'. currentWork: 'what|why'",
        }),
      ),
      index: Type.Optional(
        Type.Number({
          description: 'Index of item to remove (0-based)',
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const memory = loadMemory(ctx.cwd);

      switch (params.action) {
        // ── Get: display category contents ──────────────────────
        case 'get': {
          const data = memory[params.category];
          if (!Array.isArray(data)) {
            return t(`${params.category}: (invalid data — use clear to reset)`);
          }
          const text =
            data.length === 0
              ? `${params.category}: (empty)`
              : `${params.category}:\n` +
                data
                  .map((item, i) => {
                    if (typeof item === 'string') return `  ${i}. ${item}`;
                    if ('pattern' in item)
                      return `  ${i}. [${(item as ConditionalRule).pattern}] ${(item as ConditionalRule).rule}`;
                    if ('text' in item && 'count' in item) {
                      const pe = item as PatternEntry;
                      let display = `  ${i}. [${pe.count}x] ${pe.text}`;
                      if (pe.wrong) display += `\n     ❌ ${pe.wrong}`;
                      if (pe.correct) display += `\n     ✅ ${pe.correct}`;
                      if (pe.why) display += `\n     Why: ${pe.why}`;
                      return display;
                    }
                    if ('name' in item)
                      return `  ${i}. ${item.name}: ${item.description}`;
                    if ('what' in item)
                      return `  ${i}. ${item.what} — ${item.why}`;
                    return `  ${i}. ${JSON.stringify(item)}`;
                  })
                  .join('\n');
          return t(text);
        }

        // ── Add: append new item to category ────────────────────
        case 'add': {
          if (!params.value) {
            return t('value is required.');
          }

          const value = params.value.slice(0, MAX_MEMORY_VALUE_LENGTH);
          const arr = memory[params.category];
          if (!Array.isArray(arr)) {
            return t(
              `${params.category} has invalid data. Try clearing it first.`,
            );
          }
          if (
            arr.length >= MAX_MEMORY_ENTRIES &&
            params.category !== 'patterns'
          ) {
            return t(
              `${params.category} reached max entries (${MAX_MEMORY_ENTRIES}).`,
            );
          }

          if (params.category === 'patterns') {
            // 1️⃣ Parse structured format "text|||wrong|||correct|||why"
            const parts = value.split('|||').map((s) => s.trim());
            const patternText = parts[0];
            if (!patternText) return t('Pattern text cannot be empty.');
            const wrong = parts[1] || undefined;
            const correct = parts[2] || undefined;
            const why = parts[3] || undefined;

            // 2️⃣ Fuzzy dedup on patternText (not raw ||| value)
            const existing =
              patternText.length >= 10
                ? memory.patterns.find(
                    (p) =>
                      p.text.includes(patternText) ||
                      patternText.includes(p.text),
                  )
                : undefined;
            if (existing) {
              existing.count++;
              existing.text = patternText;
              if (wrong) existing.wrong = wrong;
              if (correct) existing.correct = correct;
              if (why) existing.why = why;
            } else {
              if (memory.patterns.length >= MAX_MEMORY_ENTRIES) {
                return t(
                  `patterns reached max entries (${MAX_MEMORY_ENTRIES}).`,
                );
              }
              memory.patterns.push({
                text: patternText,
                count: 1,
                wrong,
                correct,
                why,
              });
            }
          } else if (params.category === 'rules') {
            if (memory.rules.length >= MAX_RULES) {
              return t(`rules reached max entries (${MAX_RULES}).`);
            }
            const sepIdx = value.indexOf('|');
            if (sepIdx < 0) {
              return t(
                "rules must use 'pattern|rule' format (e.g. 'src/api/**|error handling required').",
              );
            }
            const pattern = value
              .slice(0, sepIdx)
              .slice(0, MAX_RULE_PATTERN_LENGTH);
            const rule = value.slice(sepIdx + 1);
            memory.rules.push({ pattern, rule });
          } else if (
            params.category === 'conventions' ||
            params.category === 'notes' ||
            params.category === 'gotchas' ||
            params.category === 'decisions'
          ) {
            memory[params.category].push(value);
          } else if (params.category === 'workflows') {
            const sepIdx = value.indexOf('|');
            const name = sepIdx >= 0 ? value.slice(0, sepIdx) : value;
            const description = sepIdx >= 0 ? value.slice(sepIdx + 1) : '';
            memory.workflows.push({ name, description });
          } else if (params.category === 'currentWork') {
            const sepIdx = value.indexOf('|');
            const what = sepIdx >= 0 ? value.slice(0, sepIdx) : value;
            const why = sepIdx >= 0 ? value.slice(sepIdx + 1) : '';
            memory.currentWork.push({
              what,
              why,
              startedAt: new Date().toISOString().slice(0, 10),
            });
          }

          const err = saveMemory(ctx.cwd, memory);
          if (err) return t(`Save failed: ${err}`);
          return t(`Added to ${params.category}.`);
        }

        // ── Remove: delete item by index ─────────────────────────
        case 'remove': {
          if (params.index === undefined) {
            return t('index is required.');
          }
          const arr = memory[params.category];
          if (!Array.isArray(arr)) {
            return t(
              `${params.category} has invalid data. Try clearing it first.`,
            );
          }
          if (params.index < 0 || params.index >= arr.length) {
            return t(`Index out of range (0~${arr.length - 1}).`);
          }
          arr.splice(params.index, 1);
          const err = saveMemory(ctx.cwd, memory);
          if (err) return t(`Save failed: ${err}`);
          return t(`Removed ${params.category}[${params.index}].`);
        }

        // ── Clear: remove all items in category ──────────────────
        case 'clear': {
          memory[params.category] = [];
          const err = saveMemory(ctx.cwd, memory);
          if (err) return t(`Save failed: ${err}`);
          return t(`Cleared all ${params.category}.`);
        }
      }

      return t('Unknown action.');
    },
  });
}
