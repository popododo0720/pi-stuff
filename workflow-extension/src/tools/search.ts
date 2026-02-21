// tools/search.ts — Parallel search tool registration
// Allows the main agent to dispatch lightweight model subprocesses
// for codebase exploration, reducing cost vs using the primary model.

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import type { SearchScope } from '../search/prompts';
import type { SearchQuery, SearchResult } from '../search/runner';
import { runParallelSearch } from '../search/runner';
import { loadSettings } from '../storage/settings';

/**
 * Register the `search` tool that dispatches parallel search queries
 * to a configured lightweight model.
 */
export function registerSearchTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'search',
    description:
      'Run parallel codebase searches using a lightweight model. ' +
      'Provide multiple search queries to explore different aspects simultaneously. ' +
      'Uses the search model configured in workflow settings (stages.search.model). ' +
      'Each query runs as an independent subprocess with read-only tools (read, grep, find, ls). ' +
      'Use this when you need to explore unfamiliar code, find patterns across files, ' +
      'or gather context from multiple areas of the codebase at once.',
    parameters: {
      type: 'object',
      properties: {
        queries: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description:
                  'A specific search question, e.g. "Find all API route handlers and their middleware"',
              },
              scope: {
                type: 'string',
                enum: ['codebase', 'docs', 'both'],
                description:
                  'Search scope: codebase (source files), docs (documentation), both. Default: codebase',
              },
            },
            required: ['query'],
          },
          description:
            'List of search queries to run in parallel. Each gets its own subprocess.',
        },
      },
      required: ['queries'],
    },
    execute: async (args, ctx) => {
      const input = args as {
        queries: Array<{ query: string; scope?: string }>;
      };

      if (!input.queries || input.queries.length === 0) {
        return 'Error: No search queries provided.';
      }

      // Cap query count to prevent abuse
      const MAX_QUERIES = 10;
      if (input.queries.length > MAX_QUERIES) {
        return `Error: Too many queries (${input.queries.length}). Maximum is ${MAX_QUERIES}.`;
      }

      const settings = loadSettings(ctx.cwd);
      const searchConfig = settings.stages.search;

      if (!searchConfig?.model) {
        return (
          'Error: No search model configured.\n' +
          'Set stages.search.model in .pi/workflow-settings.json\n' +
          'Example: { "stages": { "search": { "model": "anthropic/claude-haiku-4-5" } } }\n' +
          'Use a lightweight/cheap model for cost-effective parallel search.'
        );
      }

      const queries: SearchQuery[] = input.queries.map((q) => ({
        query: q.query,
        scope: (q.scope as SearchScope) ?? 'codebase',
      }));

      const results = await runParallelSearch(
        queries,
        searchConfig,
        pi,
        ctx.cwd,
      );

      return formatResults(results);
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
