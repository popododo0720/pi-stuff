// views/settings-panel.ts — WebviewPanel for editing .pi/workflow-settings.json

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { getNonce } from './html-utils';
import type { PiRpcClient } from '../core/rpc-client';

const SETTINGS_REL = '.pi/workflow-settings.json';
const PI_DIR = '.pi';

const THINKING_OPTIONS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];
const DETAIL_OPTIONS = ['minimal', 'standard', 'detailed'];

interface DomainConfig {
  models?: string[];
  thinking?: string;
  enabled?: boolean;
}

interface SearchConfig {
  model?: string;
  thinking?: string;
  maxParallel?: number;
  timeout?: number;
}

interface Settings {
  verifyTimeout?: number;
  maxRetries?: number;
  detailLevel?: string;
  stages?: {
    plan?: { model?: string; thinking?: string };
    implement?: { model?: string; thinking?: string };
    compound?: { model?: string; thinking?: string };
    verify?: { models?: string[]; thinking?: string; domains?: Record<string, DomainConfig> };
    search?: SearchConfig;
  };
  git?: Record<string, boolean | undefined>;
  preflight?: { enabled?: boolean; commands?: string[]; timeout?: number };
  repoMap?: { enabled?: boolean; tokenBudget?: number };
}

const DOMAIN_IDS = ['security', 'performance', 'architecture', 'data-integrity', 'simplicity'] as const;

export class SettingsPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private rpcClient: PiRpcClient | null = null;

  constructor(
    private readonly workspaceRoot: string,
    private readonly extensionUri: vscode.Uri,
  ) {}

  setRpcClient(client: PiRpcClient | null): void {
    this.rpcClient = client;
  }

  async show(): Promise<void> {
    const models = await this.fetchAvailableModels();

    if (this.panel) {
      this.panel.reveal();
      this.panel.webview.html = this.getHtml(this.panel.webview, models);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'piSettings',
      'Pi: Settings',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    this.panel.webview.html = this.getHtml(this.panel.webview, models);

    this.panel.webview.onDidReceiveMessage(async (msg: { type: string; settings?: unknown }) => {
      if (msg.type === 'save' && msg.settings) {
        this.saveSettings(msg.settings as Settings);
        vscode.window.showInformationMessage('Pi settings saved.');
      } else if (msg.type === 'refreshModels') {
        const fresh = await this.fetchAvailableModels();
        this.panel?.webview.postMessage({ type: 'modelsUpdate', models: fresh });
      }
    });

    this.panel.onDidDispose(() => { this.panel = undefined; });
  }

  private async fetchAvailableModels(): Promise<string[]> {
    if (!this.rpcClient?.isRunning()) return [];
    try {
      const resp = await this.rpcClient.getAvailableModels();
      if (resp.success && resp.data?.models) {
        const raw = resp.data.models as Array<{ provider?: string; id?: string } | string>;
        return raw.map(m => typeof m === 'string' ? m : `${m.provider}/${m.id}`);
      }
    } catch { /* ignore */ }
    return [];
  }

  private loadSettings(): Settings {
    try {
      const path = join(this.workspaceRoot, SETTINGS_REL);
      if (!existsSync(path)) return {};
      return JSON.parse(readFileSync(path, 'utf-8')) as Settings;
    } catch {
      return {};
    }
  }

  private saveSettings(settings: Settings): void {
    try {
      const dir = join(this.workspaceRoot, PI_DIR);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const path = join(this.workspaceRoot, SETTINGS_REL);

      // Clamp numeric values to valid ranges (mirror backend validation)
      if (settings.verifyTimeout != null) {
        settings.verifyTimeout = Math.max(10000, Math.min(600000, settings.verifyTimeout));
      }
      if (settings.maxRetries != null) {
        settings.maxRetries = Math.max(1, Math.min(20, settings.maxRetries));
      }
      if (settings.stages?.search) {
        const s = settings.stages.search;
        if (s.maxParallel != null) s.maxParallel = Math.max(1, Math.min(10, s.maxParallel));
        if (s.timeout != null) s.timeout = Math.max(10000, Math.min(300000, s.timeout));
      }
      if (settings.repoMap?.tokenBudget != null) {
        settings.repoMap.tokenBudget = Math.max(256, Math.min(8192, settings.repoMap.tokenBudget));
      }
      if (settings.preflight?.timeout != null) {
        settings.preflight.timeout = Math.max(10, Math.min(300, settings.preflight.timeout));
      }

      // Atomic write: write to temp file then rename
      const content = JSON.stringify(settings, null, '\t');
      const tmpPath = path + '.tmp.' + randomBytes(4).toString('hex');
      writeFileSync(tmpPath, content, { encoding: 'utf-8', mode: 0o600 });
      try {
        renameSync(tmpPath, path);
      } catch {
        // Cross-device fallback: direct write + cleanup orphan
        try { unlinkSync(tmpPath); } catch { /* ignore */ }
        writeFileSync(path, content, { encoding: 'utf-8', mode: 0o600 });
      }
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to save settings: ${err}`);
    }
  }

  private getHtml(webview: vscode.Webview, availableModels: string[] = []): string {
    const nonce = getNonce();
    const settings = this.loadSettings();
    const settingsJson = JSON.stringify(settings)
      .replace(/</g, '\\u003c')
      .replace(/>/g, '\\u003e');

    const thinkingOpts = THINKING_OPTIONS.map(o => `<option value="${o}">${o}</option>`).join('');
    const detailOpts = DETAIL_OPTIONS.map(o => `<option value="${o}">${o}</option>`).join('');
    const modelOpts = availableModels.map(m => `<option value="${m}">${m}</option>`).join('');
    const modelsJson = JSON.stringify(availableModels).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      padding: 16px 24px; line-height: 1.6;
      max-width: 700px;
    }
    h1 { font-size: 1.4em; margin-bottom: 16px; border-bottom: 1px solid var(--vscode-panel-border, transparent); padding-bottom: 8px; }
    h2 { font-size: 1.1em; margin: 24px 0 8px; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }
    .field { margin: 8px 0; display: flex; align-items: center; gap: 12px; }
    .field label { min-width: 180px; font-size: 13px; }
    .field input[type="text"], .field input[type="number"] {
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 4px; padding: 4px 8px; font-size: 13px;
      width: 220px; outline: none;
    }
    .field input:focus, .field select:focus, .field textarea:focus {
      border-color: var(--vscode-focusBorder, #007fd4);
    }
    .field select {
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border: 1px solid var(--vscode-dropdown-border, transparent);
      border-radius: 4px; padding: 4px 8px; font-size: 13px;
      outline: none;
    }
    .field select[multiple] {
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
    }
    .field select[multiple] option {
      padding: 2px 4px;
    }
    .field select:focus, .field select[multiple]:focus {
      border-color: var(--vscode-focusBorder, #007fd4);
    }
    .field-check { margin: 6px 0; display: flex; align-items: center; gap: 8px; }
    .field-check input[type="checkbox"] { width: 16px; height: 16px; accent-color: var(--vscode-checkbox-background); }
    .field-check label { font-size: 13px; cursor: pointer; }
    textarea {
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 4px; padding: 6px 8px; font-size: 13px;
      font-family: var(--vscode-editor-font-family);
      width: 100%; min-height: 60px; resize: vertical; outline: none;
    }
    .save-bar {
      position: sticky; bottom: 0; padding: 12px 0;
      background: var(--vscode-editor-background);
      border-top: 1px solid var(--vscode-panel-border, transparent);
      margin-top: 24px;
    }
    .save-btn {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none; border-radius: 4px;
      padding: 8px 24px; cursor: pointer; font-size: 13px; font-weight: 500;
    }
    .save-btn:hover { opacity: 0.9; }
    .desc { font-size: 12px; color: var(--vscode-descriptionForeground); margin: 2px 0 8px 192px; }
    .tab-bar {
      display: flex; gap: 0; margin-bottom: 16px;
      border-bottom: 1px solid var(--vscode-panel-border, transparent);
    }
    .tab-btn {
      background: none; border: none; border-bottom: 2px solid transparent;
      color: var(--vscode-descriptionForeground);
      padding: 8px 16px; cursor: pointer; font-size: 13px; font-weight: 500;
    }
    .tab-btn:hover { color: var(--vscode-editor-foreground); }
    .tab-btn.active {
      color: var(--vscode-editor-foreground);
      border-bottom-color: var(--vscode-focusBorder, #007fd4);
    }
    .tab-content.hidden { display: none; }
  </style>
</head>
<body>
  <h1>⚙️ Pi Workflow Settings</h1>

  <div class="tab-bar">
    <button class="tab-btn active" data-tab="general">General</button>
    <button class="tab-btn" data-tab="stages">Stages</button>
    <button class="tab-btn" data-tab="git">Git</button>
    <button class="tab-btn" data-tab="advanced">Advanced</button>
  </div>

  <!-- ── General Tab ── -->
  <div class="tab-content" id="tab-general">
    <h2>General</h2>
    <div class="field">
      <label>Verify Timeout (ms)</label>
      <input type="number" id="verifyTimeout" min="10000" max="600000" step="1000">
    </div>
    <div class="field">
      <label>Max Retries</label>
      <input type="number" id="maxRetries" min="1" max="20">
    </div>
    <div class="field">
      <label>Detail Level</label>
      <select id="detailLevel"><option value="">(default)</option>${detailOpts}</select>
    </div>
  </div>

  <!-- ── Stages Tab ── -->
  <div class="tab-content hidden" id="tab-stages">
    <h2>Plan</h2>
    <div class="field">
      <label>Model</label>
      <select id="plan-model"><option value="">(default)</option>${modelOpts}</select>
    </div>
    <div class="field">
      <label>Thinking</label>
      <select id="plan-thinking"><option value="">(default)</option>${thinkingOpts}</select>
    </div>

    <h2>Implement</h2>
    <div class="field">
      <label>Model</label>
      <select id="impl-model"><option value="">(default)</option>${modelOpts}</select>
    </div>
    <div class="field">
      <label>Thinking</label>
      <select id="impl-thinking"><option value="">(default)</option>${thinkingOpts}</select>
    </div>

    <h2>Compound</h2>
    <div class="field">
      <label>Model</label>
      <select id="compound-model"><option value="">(default)</option>${modelOpts}</select>
    </div>
    <div class="field">
      <label>Thinking</label>
      <select id="compound-thinking"><option value="">(default)</option>${thinkingOpts}</select>
    </div>

    <h2>Verify</h2>
    <div class="field">
      <label>Models</label>
      <select id="verify-models" multiple style="width:300px;min-height:80px">${modelOpts}</select>
    </div>
    <p class="desc" style="margin-left:0">Ctrl/Cmd+Click to select multiple models</p>
    <div class="field">
      <label>Thinking</label>
      <select id="verify-thinking"><option value="">(default)</option>${thinkingOpts}</select>
    </div>

    <h2>Verify Domains</h2>
    <p class="desc" style="margin-left:0">Per-domain model/thinking overrides. Leave empty to inherit from Verify defaults.</p>
    ${DOMAIN_IDS.map(d => `
    <details style="margin:8px 0;border:1px solid var(--vscode-panel-border,#333);border-radius:4px;padding:4px 8px;">
      <summary style="cursor:pointer;font-size:13px;font-weight:500;padding:4px 0;">${d}</summary>
      <div class="field-check" style="margin-top:6px;"><input type="checkbox" id="domain-${d}-enabled" checked><label for="domain-${d}-enabled">Enabled</label></div>
      <div class="field"><label>Models</label><select id="domain-${d}-models" multiple style="width:280px;min-height:60px"><option value="">(inherit)</option>${modelOpts}</select></div>
      <div class="field"><label>Thinking</label><select id="domain-${d}-thinking"><option value="">(inherit)</option>${thinkingOpts}</select></div>
    </details>`).join('')}

    <h2>Search</h2>
    <p class="desc" style="margin-left:0">Lightweight model for parallel codebase search. Use a cheap/fast model to reduce costs.</p>
    <div class="field">
      <label>Model</label>
      <select id="search-model"><option value="">(default)</option>${modelOpts}</select>
    </div>
    <div class="field">
      <label>Thinking</label>
      <select id="search-thinking"><option value="">(default)</option>${thinkingOpts}</select>
    </div>
    <div class="field">
      <label>Max Parallel</label>
      <input type="number" id="search-maxParallel" min="1" max="10" placeholder="3">
    </div>
    <div class="field">
      <label>Timeout (ms)</label>
      <input type="number" id="search-timeout" min="10000" max="300000" step="1000" placeholder="60000">
    </div>
  </div>

  <!-- ── Git Tab ── -->
  <div class="tab-content hidden" id="tab-git">
    <h2>Git Automation</h2>
    <div class="field-check"><input type="checkbox" id="git-enabled"><label for="git-enabled">Enabled</label></div>
    <div class="field-check"><input type="checkbox" id="git-commitPerTodo"><label for="git-commitPerTodo">Commit per TODO</label></div>
    <div class="field-check"><input type="checkbox" id="git-pushPerTodo"><label for="git-pushPerTodo">Push per TODO</label></div>
    <div class="field-check"><input type="checkbox" id="git-pushOnComplete"><label for="git-pushOnComplete">Push on complete</label></div>
    <div class="field-check"><input type="checkbox" id="git-requireCleanStart"><label for="git-requireCleanStart">Require clean start</label></div>
    <div class="field-check"><input type="checkbox" id="git-useWorkflowBranch"><label for="git-useWorkflowBranch">Use workflow branch</label></div>
    <div class="field-check"><input type="checkbox" id="git-useWorkflowWorktree"><label for="git-useWorkflowWorktree">Use workflow worktree</label></div>
  </div>

  <!-- ── Advanced Tab ── -->
  <div class="tab-content hidden" id="tab-advanced">
    <h2>Preflight</h2>
    <div class="field-check"><input type="checkbox" id="preflight-enabled"><label for="preflight-enabled">Enabled</label></div>
    <div class="field">
      <label>Timeout (seconds)</label>
      <input type="number" id="preflight-timeout" min="10" max="300">
    </div>
    <div style="margin: 8px 0;">
      <label style="font-size:13px; display:block; margin-bottom:4px;">Commands (one per line)</label>
      <textarea id="preflight-commands" rows="3"></textarea>
    </div>

    <h2>Repo Map</h2>
    <div class="field-check"><input type="checkbox" id="repoMap-enabled"><label for="repoMap-enabled">Enabled</label></div>
    <div class="field">
      <label>Token Budget</label>
      <input type="number" id="repoMap-tokenBudget" min="256" max="8192">
    </div>
  </div>

  <div class="save-bar">
    <button class="save-btn" id="refresh-models-btn" style="margin-right:8px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);">🔄 Refresh Models</button>
    <button class="save-btn" id="save-btn">Save Settings</button>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const settings = ${settingsJson};
    let availableModels = ${modelsJson};

    // ── Tab switching ──
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
        btn.classList.add('active');
        const tabId = 'tab-' + btn.getAttribute('data-tab');
        const tabEl = document.getElementById(tabId);
        if (tabEl) tabEl.classList.remove('hidden');
      });
    });

    // ── Helpers ──
    function val(id, v) { const el = document.getElementById(id); if (el && v != null) el.value = v; }
    function chk(id, v) { const el = document.getElementById(id); if (el) el.checked = !!v; }
    function setMultiSelect(id, values) {
      const el = document.getElementById(id);
      if (!el) return;
      for (const opt of el.options) {
        opt.selected = values.includes(opt.value);
      }
    }
    function getMultiSelect(id) {
      const el = document.getElementById(id);
      if (!el) return [];
      return Array.from(el.selectedOptions).map(o => o.value).filter(v => v !== '');
    }
    function rebuildModelSelects(models) {
      const singleIds = ['plan-model', 'impl-model', 'compound-model', 'search-model'];
      const multiIds = ['verify-models', ...domainIds.map(d => 'domain-' + d + '-models')];
      for (const id of singleIds) {
        const el = document.getElementById(id);
        if (!el) continue;
        const cur = el.value;
        el.innerHTML = '<option value="">(default)</option>' + models.map(m => '<option value="' + m + '">' + m + '</option>').join('');
        el.value = cur;
      }
      for (const id of multiIds) {
        const el = document.getElementById(id);
        if (!el) continue;
        const cur = getMultiSelect(id);
        const hasInherit = id.startsWith('domain-');
        el.innerHTML = (hasInherit ? '<option value="">(inherit)</option>' : '') + models.map(m => '<option value="' + m + '">' + m + '</option>').join('');
        setMultiSelect(id, cur);
      }
    }

    // ── Listen for model updates ──
    window.addEventListener('message', e => {
      const msg = e.data;
      if (msg.type === 'modelsUpdate' && msg.models) {
        availableModels = msg.models;
        rebuildModelSelects(availableModels);
      }
    });

    // ── Populate ──
    val('verifyTimeout', settings.verifyTimeout || 120000);
    val('maxRetries', settings.maxRetries || 5);
    val('detailLevel', settings.detailLevel || '');

    const stages = settings.stages || {};
    val('plan-model', stages.plan?.model || '');
    val('plan-thinking', stages.plan?.thinking || '');
    val('impl-model', stages.implement?.model || '');
    val('impl-thinking', stages.implement?.thinking || '');
    val('compound-model', stages.compound?.model || '');
    val('compound-thinking', stages.compound?.thinking || '');
    setMultiSelect('verify-models', stages.verify?.models || []);
    val('verify-thinking', stages.verify?.thinking || '');

    // Verify domains
    const domains = stages.verify?.domains || {};
    const domainIds = ${JSON.stringify(DOMAIN_IDS)};
    for (const d of domainIds) {
      const dc = domains[d] || {};
      chk('domain-' + d + '-enabled', dc.enabled !== false);
      setMultiSelect('domain-' + d + '-models', dc.models || []);
      val('domain-' + d + '-thinking', dc.thinking || '');
    }

    // Search
    const searchCfg = stages.search || {};
    val('search-model', searchCfg.model || '');
    val('search-thinking', searchCfg.thinking || '');
    val('search-maxParallel', searchCfg.maxParallel || 3);
    val('search-timeout', searchCfg.timeout || 60000);

    const git = settings.git || {};
    chk('git-enabled', git.enabled !== false);
    chk('git-commitPerTodo', git.commitPerTodo !== false);
    chk('git-pushPerTodo', !!git.pushPerTodo);
    chk('git-pushOnComplete', git.pushOnComplete !== false);
    chk('git-requireCleanStart', git.requireCleanStart !== false);
    chk('git-useWorkflowBranch', git.useWorkflowBranch !== false);
    chk('git-useWorkflowWorktree', !!git.useWorkflowWorktree);

    const pf = settings.preflight || {};
    chk('preflight-enabled', pf.enabled !== false);
    val('preflight-timeout', pf.timeout || 60);
    val('preflight-commands', (pf.commands || []).join('\\n'));

    const rm = settings.repoMap || {};
    chk('repoMap-enabled', rm.enabled !== false);
    val('repoMap-tokenBudget', rm.tokenBudget || 2048);

    // ── Collect ──
    function getVal(id) { return document.getElementById(id)?.value || ''; }
    function getNum(id) { return parseInt(document.getElementById(id)?.value, 10) || 0; }
    function getChk(id) { return !!document.getElementById(id)?.checked; }

    function stageConfig(modelId, thinkingId) {
      const m = getVal(modelId), t = getVal(thinkingId);
      const c = {};
      if (m) c.model = m;
      if (t) c.thinking = t;
      return Object.keys(c).length ? c : undefined;
    }

    // ── Refresh models button ──
    document.getElementById('refresh-models-btn').addEventListener('click', () => {
      vscode.postMessage({ type: 'refreshModels' });
    });

    document.getElementById('save-btn').addEventListener('click', () => {
      const verifyModels = getMultiSelect('verify-models');
      const verifyThinking = getVal('verify-thinking');
      const verifyStage = {};
      if (verifyModels.length) verifyStage.models = verifyModels;
      if (verifyThinking) verifyStage.thinking = verifyThinking;

      // Collect per-domain verify config
      const domainsOut = {};
      for (const d of domainIds) {
        const dc = {};
        const enabled = getChk('domain-' + d + '-enabled');
        if (!enabled) dc.enabled = false;
        const dModels = getMultiSelect('domain-' + d + '-models');
        if (dModels.length) dc.models = dModels;
        const dThinking = getVal('domain-' + d + '-thinking');
        if (dThinking) dc.thinking = dThinking;
        if (Object.keys(dc).length) domainsOut[d] = dc;
      }
      if (Object.keys(domainsOut).length) verifyStage.domains = domainsOut;

      const stagesOut = {};
      const plan = stageConfig('plan-model', 'plan-thinking');
      if (plan) stagesOut.plan = plan;
      const impl = stageConfig('impl-model', 'impl-thinking');
      if (impl) stagesOut.implement = impl;
      const compound = stageConfig('compound-model', 'compound-thinking');
      if (compound) stagesOut.compound = compound;
      if (Object.keys(verifyStage).length) stagesOut.verify = verifyStage;

      // Collect search config
      const searchOut = {};
      const searchModel = getVal('search-model');
      if (searchModel) searchOut.model = searchModel;
      const searchThinking = getVal('search-thinking');
      if (searchThinking) searchOut.thinking = searchThinking;
      const searchMaxP = getNum('search-maxParallel');
      if (searchMaxP > 0) searchOut.maxParallel = searchMaxP;
      const searchTimeout = getNum('search-timeout');
      if (searchTimeout > 0) searchOut.timeout = searchTimeout;
      if (Object.keys(searchOut).length) stagesOut.search = searchOut;

      const cmdLines = getVal('preflight-commands').split('\\n').filter(Boolean);

      const result = {
        verifyTimeout: getNum('verifyTimeout') || 120000,
        stages: stagesOut,
        git: {
          enabled: getChk('git-enabled'),
          commitPerTodo: getChk('git-commitPerTodo'),
          pushPerTodo: getChk('git-pushPerTodo'),
          pushOnComplete: getChk('git-pushOnComplete'),
          requireCleanStart: getChk('git-requireCleanStart'),
          useWorkflowBranch: getChk('git-useWorkflowBranch'),
          useWorkflowWorktree: getChk('git-useWorkflowWorktree'),
        },
      };
      const mr = getNum('maxRetries');
      if (mr > 0) result.maxRetries = mr;
      const dl = getVal('detailLevel');
      if (dl) result.detailLevel = dl;
      // Always persist preflight (even when disabled, to preserve user intent)
      const pfEnabled = getChk('preflight-enabled');
      result.preflight = { enabled: pfEnabled };
      if (cmdLines.length) result.preflight.commands = cmdLines;
      const pt = getNum('preflight-timeout');
      if (pt > 0) result.preflight.timeout = pt;

      // Always persist repoMap (even when disabled, to preserve user intent)
      const rmEnabled = getChk('repoMap-enabled');
      const rmBudget = getNum('repoMap-tokenBudget');
      result.repoMap = { enabled: rmEnabled };
      if (rmBudget) result.repoMap.tokenBudget = rmBudget;

      vscode.postMessage({ type: 'save', settings: result });
    });
  </script>
</body>
</html>`;
  }

  dispose(): void {
    this.panel?.dispose();
  }
}
