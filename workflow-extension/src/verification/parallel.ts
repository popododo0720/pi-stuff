// verification/parallel.ts — Parallel verification orchestration
// Coordinates plan/impl verification across multiple models and domains.
// Parsing, error classification, model execution, formatting, and persistence
// are in separate modules.

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { loadCustomChecks } from '../storage/checks';
import type {
  ModelVerificationResult,
  VerificationResult,
  WorkflowSettings,
} from '../types';
import { ALL_DOMAINS } from './domains';
import { runSingleModel } from './model-runner';
import {
  buildCoreImplPrompt,
  buildCorePlanPrompt,
  buildDomainPrompt,
} from './prompt-builder';
import { detectStack, getStackHint } from './stack-detect';

// ── Parallel verification ────────────────────────────────────────

export async function runParallelVerification(
  type: 'plan' | 'impl',
  planContent: string,
  description: string,
  settings: WorkflowSettings,
  pi: ExtensionAPI,
  cwd: string,
  signal?: AbortSignal,
  implNotes?: string,
  todoContext?: {
    currentIndex: number;
    totalCount: number;
    completedTitles: string[];
  },
): Promise<VerificationResult> {
  const verifyConfig = settings.stages.verify;
  const verifyModels = verifyConfig?.models ?? [];
  const verifyThinking = verifyConfig?.thinking ?? 'high';
  const stacks = detectStack(cwd);
  const stackHint = getStackHint(stacks);
  const checks = loadCustomChecks(cwd);
  const customChecks = checks.length > 0 ? checks : undefined;

  if (type === 'plan') {
    // ── Plan: existing multi-model structure, no domain checks ──
    if (verifyModels.length === 0) {
      throw new Error(
        'No verification models configured. Plan verification requires core models. Use /workflow-settings to add models.',
      );
    }
    const prompt = buildCorePlanPrompt({
      description,
      planContent,
      stackHint,
      customChecks,
    });
    const promises = verifyModels.map((model) =>
      runSingleModel(
        model,
        prompt,
        pi,
        settings.verifyTimeout,
        verifyThinking,
        signal,
      ),
    );
    const results = await Promise.all(promises);
    if (results.some((r) => r.infrastructureError)) {
      return { passed: false, results, halted: true };
    }
    return { passed: results.every((r) => r.passed), results };
  }

  // ── Impl: Core + Domain parallel ──
  const corePrompt = buildCoreImplPrompt({
    description,
    planContent,
    implNotes,
    todoContext,
    stackHint,
    customChecks,
  });

  const corePromises = verifyModels.map((model) =>
    runSingleModel(
      model,
      corePrompt,
      pi,
      settings.verifyTimeout,
      verifyThinking,
      signal,
    ),
  );

  // ── Build domain task descriptors (stable index for retry) ──
  interface DomainTask {
    domain: (typeof ALL_DOMAINS)[number];
    model: string;
    prompt: string;
    thinking: string;
  }

  const domainConfig = verifyConfig?.domains ?? {};
  const domainTasks: DomainTask[] = [];

  for (const domain of ALL_DOMAINS) {
    if (domainConfig[domain.id]?.enabled === false) continue;
    const dc = domainConfig[domain.id];
    const models = dc?.models?.length
      ? dc.models
      : verifyModels.length > 0
        ? [verifyModels[ALL_DOMAINS.indexOf(domain) % verifyModels.length]]
        : [];
    if (models.length === 0) continue;
    const thinking = dc?.thinking ?? verifyThinking;
    const prompt = buildDomainPrompt(domain, {
      description,
      planContent,
      todoContext,
      stackHint,
    });
    for (const model of models) {
      domainTasks.push({ domain, model, prompt, thinking });
    }
  }

  // Must have at least one verification call
  if (corePromises.length === 0 && domainTasks.length === 0) {
    throw new Error(
      'No verification models configured. Use /workflow-settings to add models.',
    );
  }

  // Execute core + domain in parallel
  const domainPromises = domainTasks.map((task) =>
    runSingleModel(
      task.model,
      task.prompt,
      pi,
      settings.verifyTimeout,
      task.thinking,
      signal,
    ).then(
      (r): ModelVerificationResult => ({ ...r, domain: task.domain.name }),
    ),
  );

  const [coreResults, domainResults] = await Promise.all([
    Promise.all(corePromises),
    Promise.all(domainPromises),
  ]);

  // Core infra/format error → halt
  if (coreResults.some((r) => r.infrastructureError)) {
    return {
      passed: false,
      results: [...coreResults, ...domainResults],
      halted: true,
    };
  }

  // ── Domain partial retry: retry only infra/format failures (parallel) ──
  const retryIndices = domainResults
    .map((r, i) => (r.verificationErrorType ? i : -1))
    .filter((i) => i >= 0);

  if (retryIndices.length > 0) {
    const retryPromises = retryIndices.map((i) => {
      const task = domainTasks[i];
      return runSingleModel(
        task.model,
        task.prompt,
        pi,
        settings.verifyTimeout,
        task.thinking,
        signal,
      ).then((retried): [number, ModelVerificationResult] => [
        i,
        { ...retried, domain: task.domain.name, retryAttempt: 1 },
      ]);
    });
    const retryResults = await Promise.all(retryPromises);
    for (const [i, result] of retryResults) {
      domainResults[i] = result;
    }
  }

  const allResults = [...coreResults, ...domainResults];
  const validResults = allResults.filter((r) => !r.infrastructureError);

  // All results are infra/format errors → halt
  if (validResults.length === 0) {
    return { passed: false, results: allResults, halted: true };
  }

  const passed = validResults.every((r) => r.passed);
  return { passed, results: allResults };
}
