// search/runner.ts — Parallel search execution engine
// Spawns lightweight model subprocesses for codebase exploration.
// Reuses the pi -p subprocess pattern from verification/model-runner.ts.

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import type { SearchStageConfig } from '../types';
import type { SearchScope } from './prompts';
import { buildSearchPrompt } from './prompts';

const DEFAULT_MAX_PARALLEL = 3;
const DEFAULT_TIMEOUT = 60_000;
const DEFAULT_THINKING = 'low';

export interface SearchQuery {
  query: string;
  scope?: SearchScope;
}

export interface SearchFinding {
  file: string;
  lines?: string;
  summary: string;
  snippet: string;
}

export interface SearchResult {
  query: string;
  findings: SearchFinding[];
  answer?: string;
  error?: string;
}

/**
 * Run multiple search queries in parallel using lightweight model subprocesses.
 * Respects maxParallel concurrency limit.
 */
export async function runParallelSearch(
  queries: SearchQuery[],
  config: SearchStageConfig,
  pi: ExtensionAPI,
  cwd: string,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const model = config.model;
  if (!model) {
    return queries.map((q) => ({
      query: q.query,
      findings: [],
      error:
        'No search model configured. Set stages.search.model in workflow settings.',
    }));
  }

  const maxParallel = config.maxParallel ?? DEFAULT_MAX_PARALLEL;
  const timeout = config.timeout ?? DEFAULT_TIMEOUT;
  const thinking = config.thinking ?? DEFAULT_THINKING;

  // Execute with concurrency limit
  const results: SearchResult[] = new Array(queries.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < queries.length) {
      if (signal?.aborted) return;
      const idx = nextIndex++;
      const q = queries[idx];
      results[idx] = await executeSingleSearch(
        q,
        model,
        thinking,
        timeout,
        pi,
        cwd,
        signal,
      );
    }
  }

  const workerCount = Math.min(maxParallel, queries.length);
  const workers: Promise<void>[] = [];
  for (let i = 0; i < workerCount; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  return results;
}

async function executeSingleSearch(
  query: SearchQuery,
  model: string,
  thinking: string,
  timeout: number,
  pi: ExtensionAPI,
  cwd: string,
  signal?: AbortSignal,
): Promise<SearchResult> {
  const scope = query.scope ?? 'codebase';
  const prompt = buildSearchPrompt(query.query, scope, cwd);
  const [provider, ...modelParts] = model.split('/');
  const modelId = modelParts.join('/');

  const args = [
    '-p',
    prompt,
    '--no-extensions',
    '--tools',
    'read,bash,grep,find,ls',
    '--provider',
    provider,
    '--model',
    modelId,
    '--thinking',
    thinking,
  ];

  try {
    const result = await pi.exec('pi', args, { signal, timeout });
    const output = `${result.stdout}\n${result.stderr}`.trim();

    if (!output) {
      return { query: query.query, findings: [], error: 'Empty response' };
    }

    return parseSearchOutput(query.query, output);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return { query: query.query, findings: [], error: msg };
  }
}

/**
 * Parse search agent output into structured findings.
 */
function parseSearchOutput(query: string, output: string): SearchResult {
  const findings: SearchFinding[] = [];

  // Parse <finding> blocks
  const findingRegex = /<finding>([\s\S]*?)<\/finding>/g;
  for (const m of output.matchAll(findingRegex)) {
    const block = m[1];
    const file = extractTag(block, 'file');
    const lines = extractTag(block, 'lines');
    const summary = extractTag(block, 'summary');
    const snippet = extractTag(block, 'snippet');

    if (file && summary) {
      findings.push({
        file,
        ...(lines ? { lines } : {}),
        summary,
        snippet: snippet ?? '',
      });
    }
  }

  // Parse <answer> block
  const answerMatch = output.match(/<answer>([\s\S]*?)<\/answer>/);
  const answer = answerMatch ? answerMatch[1].trim() : undefined;

  // Fallback: if no structured output, treat entire output as answer
  if (findings.length === 0 && !answer) {
    return {
      query,
      findings: [],
      answer: output.slice(0, 3000), // cap unstructured output
    };
  }

  return { query, findings, answer };
}

function extractTag(block: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`);
  const m = block.match(re);
  return m ? m[1].trim() : undefined;
}
