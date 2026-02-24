// tools/search.ts — Parallel search tool registration
// Allows the main agent to dispatch lightweight model subprocesses
// for codebase exploration, reducing cost vs using the primary model.

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import type { SearchScope } from '../search/prompts';
import type { SearchQuery, SearchResult } from '../search/runner';
import { runParallelSearch } from '../search/runner';
import { loadSettings } from '../storage/settings';

const MAX_QUERIES = 10;
const VALID_SCOPES: Set<string> = new Set([
  'codebase',
  'docs',
  'both',
  'solutions',
  'web',
  'all',
]);

function t(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

/**
 * Register the `search` tool that dispatches parallel search queries
 * to a configured lightweight model.
 */
export function registerSearchTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'search',
    label: 'Parallel Search',
    description:
      'Run parallel codebase searches using a lightweight model. ' +
      'Provide multiple search queries to explore different aspects simultaneously. ' +
      'Uses the search model configured in workflow settings (stages.search.model). ' +
      'Each query runs as an independent subprocess with read-only tools (read, grep, find, ls). ' +
      'Use this when you need to explore unfamiliar code, find patterns across files, ' +
      'or gather context from multiple areas of the codebase at once. ' +
      'Scopes: codebase, docs, both (codebase+docs), solutions (past learnings), web (external best practices), all (codebase+docs+solutions+web).',
    parameters: Type.Object({
      queries: Type.Array(
        Type.Object({
          query: Type.String({
            description:
              'A specific search question, e.g. "Find all API route handlers and their middleware"',
          }),
          scope: Type.Optional(
            Type.Union(
              [
                Type.Literal('codebase'),
                Type.Literal('docs'),
                Type.Literal('both'),
                Type.Literal('solutions'),
                Type.Literal('web'),
                Type.Literal('all'),
              ],
              {
                description:
                  'Search scope: codebase (source files), docs (documentation), both (codebase+docs), ' +
                  'solutions (past learnings & memory), web (external best practices), ' +
                  'all (comprehensive: codebase+docs+solutions+web). Default: codebase',
              },
            ),
          ),
        }),
        {
          description:
            'List of search queries to run in parallel. Each gets its own subprocess.',
        },
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!params.queries || params.queries.length === 0) {
        return t('Error: No search queries provided.');
      }

      if (params.queries.length > MAX_QUERIES) {
        return t(
          `Error: Too many queries (${params.queries.length}). Maximum is ${MAX_QUERIES}.`,
        );
      }

      const settings = loadSettings(ctx.cwd);
      const searchConfig = settings.stages.search;

      if (!searchConfig?.model) {
        return t(
          'Error: No search model configured.\n' +
            'Set stages.search.model in .pi/workflow-settings.json\n' +
            'Example: { "stages": { "search": { "model": "anthropic/claude-haiku-4-5" } } }\n' +
            'Use a lightweight/cheap model for cost-effective parallel search.',
        );
      }

      const queries: SearchQuery[] = params.queries.map(
        (q: { query: string; scope?: string }) => ({
          query: q.query,
          scope: (q.scope && VALID_SCOPES.has(q.scope)
            ? q.scope
            : 'codebase') as SearchScope,
        }),
      );

      const results = await runParallelSearch(
        queries,
        searchConfig,
        pi,
        ctx.cwd,
        signal,
      );

      return t(formatResults(results));
    },
  });
}

function formatResults(results: SearchResult[]): string {
  const parts: string[] = [];

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    parts.push(`## Search ${i + 1}: ${r.query}`);

    if (r.error) {
      parts.push(`**Error:** ${r.error}\n`);
      continue;
    }

    if (r.findings.length > 0) {
      parts.push(`**${r.findings.length} finding(s):**\n`);
      for (const f of r.findings) {
        const loc = f.lines ? `${f.file}:${f.lines}` : f.file;
        parts.push(`### ${loc}`);
        parts.push(f.summary);
        if (f.snippet) {
          parts.push('```');
          parts.push(f.snippet);
          parts.push('```');
        }
        parts.push('');
      }
    }

    if (r.answer) {
      parts.push(`**Answer:**\n${r.answer}\n`);
    }

    if (r.findings.length === 0 && !r.answer) {
      parts.push('No results found.\n');
    }
  }

  return parts.join('\n');
}
