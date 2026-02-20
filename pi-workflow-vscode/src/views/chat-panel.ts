// views/chat-panel.ts — Chat WebviewViewProvider for pi RPC communication
// Bridges RPC client events to webview messages and handles user input.

import * as vscode from 'vscode';
import type { PiRpcClient } from '../core/rpc-client';
import type { ChatHistoryStore } from '../core/chat-history';
import type {
  AgentState,
  AutoRetryStartEvent,
  ExtToWebview,
  MessageUpdateEvent,
  ToolExecutionEndEvent,
  ToolExecutionStartEvent,
  ToolExecutionUpdateEvent,
  WebviewToExt,
} from '../types/rpc';
import { getNonce } from './html-utils';

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = 'pi.chat';

  private view: vscode.WebviewView | undefined;
  private rpcClient: PiRpcClient | null = null;
  private eventDisposables: Array<() => void> = [];

  private readonly _onDidResolve = new vscode.EventEmitter<void>();
  readonly onDidResolve = this._onDidResolve.event;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly historyStore: ChatHistoryStore,
  ) {}

  // ── WebviewViewProvider ──────────────────────────────────────

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(
      (msg: WebviewToExt) => this.handleWebviewMessage(msg),
    );

    webviewView.onDidDispose(() => {
      this.view = undefined;
    });

    // Fire after setup so extension can auto-start pi
    this._onDidResolve.fire();

    // Re-fire on visibility changes for reconnection
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible && !this.rpcClient?.isRunning()) {
        this._onDidResolve.fire();
      }
    });
  }

  // ── Public API ───────────────────────────────────────────────

  setRpcClient(client: PiRpcClient | null): void {
    this.unbindRpcEvents();
    this.rpcClient = client;
    if (client) {
      this.bindRpcEvents();
    } else {
      // When transitioning to null (pi exited/stopped), reset webview state
      this.postToWebview({ type: 'agentEnd' });
      this.postToWebview({ type: 'stateUpdate', isStreaming: false });
    }
  }

  postToWebview(msg: ExtToWebview): void {
    // No-op if view is not resolved yet
    if (!this.view) return;
    this.view.webview.postMessage(msg);
  }

  dispose(): void {
    this.unbindRpcEvents();
    this._onDidResolve.dispose();
  }

  // ── RPC → Webview ────────────────────────────────────────────

  private bindRpcEvents(): void {
    if (!this.rpcClient) return;
    const client = this.rpcClient;

    const on = <T>(event: string, handler: (data: T) => void): void => {
      client.on(event, handler);
      this.eventDisposables.push(() => client.removeListener(event, handler));
    };

    on('agent_start', () => {
      this.postToWebview({ type: 'agentStart' });
    });

    on('message_update', (data: MessageUpdateEvent) => {
      const evt = data?.assistantMessageEvent;
      if (!evt || typeof evt.type !== 'string') return;
      switch (evt.type) {
        case 'text_delta':
          if (typeof evt.delta === 'string') {
            this.postToWebview({ type: 'textDelta', delta: evt.delta });
          }
          break;
        case 'text_end':
          this.postToWebview({ type: 'textEnd', fullText: evt.content ?? '' });
          this.historyStore.append({
            role: 'assistant',
            content: evt.content ?? '',
            timestamp: Date.now(),
          });
          break;
        case 'thinking_start':
          this.postToWebview({ type: 'thinkingStart' });
          break;
        case 'thinking_delta':
          if (typeof evt.delta === 'string') {
            this.postToWebview({ type: 'thinkingDelta', delta: evt.delta });
          }
          break;
        case 'thinking_end':
          this.postToWebview({ type: 'thinkingEnd', fullThinking: evt.thinking ?? '' });
          break;
        case 'error':
          this.postToWebview({ type: 'error', message: evt.reason ?? 'Unknown error' });
          this.historyStore.append({
            role: 'error',
            content: evt.reason ?? 'Unknown error',
            timestamp: Date.now(),
          });
          break;
        // done → ignored (normal completion, agent_end handles it)
        // start, text_start, toolcall_start/delta/end → ignored
      }
    });

    on('tool_execution_start', (data: ToolExecutionStartEvent) => {
      this.postToWebview({
        type: 'toolStart',
        toolCallId: data.toolCallId,
        toolName: data.toolName,
        args: data.args,
      });
    });

    on('tool_execution_update', (data: ToolExecutionUpdateEvent) => {
      this.postToWebview({
        type: 'toolUpdate',
        toolCallId: data.toolCallId,
        text: extractText(data.partialResult),
      });
    });

    on('tool_execution_end', (data: ToolExecutionEndEvent) => {
      this.postToWebview({
        type: 'toolEnd',
        toolCallId: data.toolCallId,
        text: extractText(data.result),
        isError: data.isError,
      });
    });

    on('agent_end', () => {
      this.postToWebview({ type: 'agentEnd' });
    });

    on('auto_compaction_start', () => {
      this.postToWebview({ type: 'compactionStart', reason: 'threshold' });
    });

    on('auto_compaction_end', () => {
      this.postToWebview({ type: 'compactionEnd' });
    });

    on('auto_retry_start', (data: AutoRetryStartEvent) => {
      this.postToWebview({
        type: 'retryStart',
        attempt: data.attempt,
        maxAttempts: data.maxAttempts,
        delayMs: data.delayMs,
        error: data.errorMessage,
      });
    });

    on('auto_retry_end', (data: { success: boolean }) => {
      this.postToWebview({ type: 'retryEnd', success: data.success });
    });
  }

  private unbindRpcEvents(): void {
    for (const dispose of this.eventDisposables) {
      dispose();
    }
    this.eventDisposables = [];
  }

  // ── Webview → RPC ────────────────────────────────────────────

  private handleWebviewMessage(msg: WebviewToExt): void {
    // Top-level validation: reject malformed messages
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;

    // Handle 'ready' before rpcClient guard — history must load even if pi isn't running yet
    if (msg.type === 'ready') {
      const history = this.historyStore.getAll();
      if (history.length > 0) {
        this.postToWebview({ type: 'loadHistory', messages: history });
      }
      // If pi is running, also fetch current state
      if (this.rpcClient?.isRunning()) {
        this.rpcClient
          .getState()
          .then((resp) => {
            const d = resp.data as AgentState | undefined;
            this.postToWebview({
              type: 'stateUpdate',
              isStreaming: d?.isStreaming ?? false,
              model: d?.model?.name,
              thinkingLevel: d?.thinkingLevel,
            });
          })
          .catch((err) =>
            this.postToWebview({
              type: 'error',
              message: 'Failed to get state: ' + String(err),
            }),
          );
      } else {
        this.postToWebview({ type: 'stateUpdate', isStreaming: false });
      }
      return;
    }

    if (!this.rpcClient?.isRunning()) {
      this.postToWebview({ type: 'stateUpdate', isStreaming: false });
      this.postToWebview({
        type: 'error',
        message: 'Pi is not running. Use "Pi: Start Chat" first.',
      });
      return;
    }

    const client = this.rpcClient;

    switch (msg.type) {
      case 'sendMessage':
        if (typeof msg.text !== 'string' || !msg.text.trim()) return;
        this.historyStore.append({ role: 'user', content: msg.text, timestamp: Date.now() });
        client.prompt(msg.text).catch((err) =>
          this.postToWebview({ type: 'error', message: String(err) }),
        );
        break;
      case 'abort':
        client.abort().catch((err) =>
          this.postToWebview({ type: 'error', message: String(err) }),
        );
        break;
      // 'newSession' removed — palette command uses currentClient.newSession() directly
    }
  }

  // ── HTML ─────────────────────────────────────────────────────

  private getHtml(_webview: vscode.Webview): string {
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">
    :root {
      --color-token-bg-primary: var(--vscode-sideBar-background, var(--vscode-editor-background));
      --color-token-bg-secondary: color-mix(in srgb, var(--color-token-bg-primary) 92%, transparent);
      --color-token-foreground: var(--vscode-editor-foreground);
      --color-token-border: color-mix(in oklab, var(--vscode-foreground) 8%, transparent);
      --color-token-input-background: var(--vscode-input-background);
      --color-token-input-border: var(--vscode-input-border, transparent);
      --color-token-input-foreground: var(--vscode-input-foreground);
      --color-token-text-secondary: color-mix(in srgb, var(--color-token-foreground) 70%, transparent);
      --color-token-terminal-background: var(--vscode-textCodeBlock-background);
      --color-token-button-background: var(--vscode-button-background);
      --color-token-button-foreground: var(--vscode-button-foreground);
      --color-token-error: var(--vscode-errorForeground, #f48771);
      --color-token-success: var(--vscode-testing-iconPassed, #73c991);
      --color-token-warning: var(--vscode-editorWarning-foreground, #cca700);
      --color-token-bg-tertiary: color-mix(in srgb, var(--color-token-bg-primary) 85%, transparent);
      --color-token-user-bubble: color-mix(in oklab, var(--color-token-foreground) 5%, transparent);
      --radius-xl: 12px;
      --radius-lg: 8px;
      --font-mono: var(--vscode-editor-font-family);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--color-token-foreground);
      background: var(--color-token-bg-primary);
      display: flex; flex-direction: column; height: 100vh;
    }
    #toolbar {
      display: flex; align-items: center;
      height: 36px; padding: 0 12px;
      font-size: 12px;
      color: var(--color-token-text-secondary);
    }
    #messages {
      flex: 1; overflow-y: auto; padding: 8px 0;
      display: flex; flex-direction: column; gap: 0;
    }
    .msg {
      border-radius: 0; max-width: 100%; padding: 12px 16px;
      align-self: stretch; word-wrap: break-word;
      user-select: text; -webkit-user-select: text;
    }
    .msg-user {
      align-self: flex-end;
      max-width: 77%;
      background: var(--color-token-user-bubble);
      border-radius: 16px;
      padding: 8px 12px;
      font-weight: 500;
      word-break: break-word;
    }
    .msg-assistant {
      align-self: stretch;
    }
    .msg-assistant pre {
      white-space: pre-wrap; font-family: var(--font-mono);
      font-size: 13px; line-height: 1.5; margin: 0;
    }
    .msg-error {
      align-self: stretch;
      border-left: 3px solid var(--color-token-error);
      background: color-mix(in srgb, var(--color-token-error) 10%, transparent);
      color: var(--color-token-error);
      font-size: 12px;
    }
    .msg-system {
      text-align: center; opacity: 0.6; font-size: 12px;
      border-top: 1px solid var(--color-token-border);
      border-bottom: 1px solid var(--color-token-border);
      padding: 6px 16px;
    }
    .thinking-block {
      background: var(--color-token-terminal-background);
      border-radius: var(--radius-xl);
      border: 1px solid var(--color-token-border);
      padding: 8px 12px; margin: 8px 0;
      font-size: 12px; opacity: 0.7;
    }
    .thinking-block summary { cursor: pointer; }
    .thinking-block pre {
      white-space: pre-wrap; font-family: var(--font-mono);
      font-size: 12px; margin: 4px 0 0 0;
    }
    .tool-card {
      background: var(--color-token-terminal-background);
      border-radius: var(--radius-xl);
      border: 1px solid var(--color-token-border);
      margin: 8px 0; font-size: 12px; overflow: hidden;
    }
    .tool-card summary {
      cursor: pointer; padding: 8px 12px;
      font-family: var(--font-mono); font-size: 13px;
    }
    .tool-card pre {
      white-space: pre-wrap; font-family: var(--font-mono);
      font-size: 12px; margin: 0;
    }
    .tool-result pre,
    .tool-card .tool-result {
      padding: 8px 12px; max-height: 200px; overflow-y: auto;
    }
    .tool-error { border-color: var(--color-token-error); }
    .cursor-blink::after {
      content: '▊'; animation: blink 0.8s step-end infinite;
    }
    @keyframes blink { 50% { opacity: 0; } }
    #input-area {
      margin: 8px 12px 12px; padding: 0;
    }
    #input-card {
      background: var(--color-token-input-background);
      border: 1px solid var(--color-token-input-border);
      border-radius: var(--radius-xl);
      padding: 8px 12px;
      display: flex; align-items: flex-end; gap: 6px;
    }
    #input {
      flex: 1; resize: none;
      background: transparent; color: var(--color-token-input-foreground);
      border: none; outline: none;
      font-family: var(--vscode-font-family);
      font-size: 13px; line-height: 1.4;
    }
    #input:focus { outline: none; }
    #input-buttons { display: flex; flex-direction: column; gap: 4px; flex-shrink: 0; }
    #send-btn {
      background: var(--color-token-button-background);
      color: var(--color-token-button-foreground);
      border: none; border-radius: var(--radius-lg);
      padding: 6px 14px; cursor: pointer;
      font-size: 13px; font-weight: 500;
    }
    #send-btn:hover { opacity: 0.9; }
    #abort-btn {
      border: 1px solid var(--color-token-error);
      color: var(--color-token-error);
      background: transparent;
      border-radius: var(--radius-lg);
      padding: 6px 14px; cursor: pointer;
      font-size: 13px; font-weight: 500;
    }
    .hidden { display: none !important; }

    /* Verification progress list */
    .verify-progress {
      margin: 8px 0; padding: 12px;
      background: var(--color-token-terminal-background);
      border: 1px solid var(--color-token-border);
      border-radius: var(--radius-xl);
      font-size: 13px;
    }
    .verify-header { font-weight: 600; margin-bottom: 8px; }
    .verify-row {
      display: flex; align-items: center; gap: 8px;
      padding: 3px 0; font-family: var(--font-mono); font-size: 12px;
    }
    .verify-icon {
      width: 16px; height: 16px; text-align: center;
      flex-shrink: 0; line-height: 16px;
    }
    .verify-icon.running {
      border: 2px solid var(--color-token-text-secondary);
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      font-size: 0;
    }
    .verify-icon.passed { color: var(--color-token-success); font-weight: bold; }
    .verify-icon.failed { color: var(--color-token-error); font-weight: bold; }
    .verify-icon.skipped { color: var(--color-token-text-secondary); }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div id="toolbar">
    <span id="model-info">Not connected</span>
  </div>
  <div id="messages"></div>
  <div id="input-area">
    <div id="input-card">
      <textarea id="input" rows="3" placeholder="메시지 입력... (Shift+Enter 줄바꿈)"></textarea>
      <div id="input-buttons">
        <button id="send-btn">Send</button>
        <button id="abort-btn" class="hidden">Stop</button>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    (function() {
      const vscode = acquireVsCodeApi();
      const messagesEl = document.getElementById('messages');
      const inputEl = document.getElementById('input');
      const sendBtn = document.getElementById('send-btn');
      const abortBtn = document.getElementById('abort-btn');
      const modelInfoEl = document.getElementById('model-info');

      let currentAssistantEl = null;
      let currentAssistantPre = null;
      let currentThinkingPre = null;
      let isStreaming = false;
      let userScrolledUp = false;

      // ── Auto-scroll with drag-selection protection ──
      let scrollPending = false;
      let isMouseDown = false;

      messagesEl.addEventListener('mousedown', () => { isMouseDown = true; });
      document.addEventListener('mouseup', () => {
        isMouseDown = false;
        const diff = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
        userScrolledUp = diff > 50;
      });
      messagesEl.addEventListener('scroll', () => {
        if (isMouseDown) return;
        const diff = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
        userScrolledUp = diff > 50;
      });

      function autoScroll() {
        if (userScrolledUp || scrollPending) return;
        scrollPending = true;
        requestAnimationFrame(() => {
          scrollPending = false;
          if (!userScrolledUp) {
            messagesEl.scrollTop = messagesEl.scrollHeight;
          }
        });
      }

      // ── Helpers ──

      function escapeText(s) {
        const d = document.createElement('span');
        d.textContent = s;
        return d.innerHTML;
      }

      // ── Verification progress list ──

      let verifyContainer = null;

      function createVerifyList(tasks) {
        if (verifyContainer) verifyContainer.remove();
        const container = document.createElement('div');
        container.className = 'verify-progress';
        container.innerHTML = '<div class="verify-header">🔍 Verification</div>';
        for (const task of tasks) {
          const row = document.createElement('div');
          row.className = 'verify-row';
          row.id = 'verify-' + task.taskId;
          row.innerHTML = '<span class="verify-icon running"></span><span class="verify-label">' + escapeText(task.label) + '</span>';
          container.appendChild(row);
        }
        if (currentAssistantEl) { currentAssistantEl.appendChild(container); }
        else { messagesEl.appendChild(container); }
        verifyContainer = container;
        autoScroll();
      }

      function updateVerifyRow(taskId, status) {
        const row = document.getElementById('verify-' + taskId);
        if (!row) return;
        const icon = row.querySelector('.verify-icon');
        if (!icon) return;
        icon.className = 'verify-icon ' + status;
        switch (status) {
          case 'passed': icon.textContent = '✓'; break;
          case 'failed': icon.textContent = '✗'; break;
          case 'skipped': icon.textContent = '⊘'; break;
          default: icon.textContent = ''; break;
        }
        autoScroll();
      }

      // ── Message creation helpers ──

      function addUserMessage(text) {
        const div = document.createElement('div');
        div.className = 'msg msg-user';
        div.textContent = text;
        messagesEl.appendChild(div);
        autoScroll();
      }

      function addErrorMessage(text) {
        const div = document.createElement('div');
        div.className = 'msg msg-error';
        div.textContent = text;
        messagesEl.appendChild(div);
        autoScroll();
      }

      function addSystemMessage(text) {
        const div = document.createElement('div');
        div.className = 'msg msg-system';
        div.textContent = text;
        messagesEl.appendChild(div);
        autoScroll();
      }

      function startStreaming() {
        isStreaming = true;
        sendBtn.classList.add('hidden');
        abortBtn.classList.remove('hidden');
        inputEl.disabled = true;

        const div = document.createElement('div');
        div.className = 'msg msg-assistant';
        const pre = document.createElement('pre');
        pre.className = 'cursor-blink';
        div.appendChild(pre);
        messagesEl.appendChild(div);
        currentAssistantEl = div;
        currentAssistantPre = pre;
        autoScroll();
      }

      function appendToAssistant(delta) {
        if (!currentAssistantPre) return;
        currentAssistantPre.appendChild(document.createTextNode(delta));
        autoScroll();
      }

      function finalizeAssistantText(fullText) {
        if (!currentAssistantPre) return;
        currentAssistantPre.textContent = fullText;
        currentAssistantPre.classList.remove('cursor-blink');
      }

      function createThinkingBlock() {
        if (!currentAssistantEl) return;
        const details = document.createElement('details');
        details.className = 'thinking-block';
        const summary = document.createElement('summary');
        summary.textContent = '💭 Thinking...';
        details.appendChild(summary);
        const pre = document.createElement('pre');
        details.appendChild(pre);
        currentAssistantEl.appendChild(details);
        currentThinkingPre = pre;
      }

      function appendToThinking(delta) {
        if (!currentThinkingPre) return;
        currentThinkingPre.appendChild(document.createTextNode(delta));
        autoScroll();
      }

      function finalizeThinking(fullThinking) {
        if (!currentThinkingPre) return;
        currentThinkingPre.textContent = fullThinking;
        currentThinkingPre = null;
      }

      function createToolCard(toolCallId, toolName, args) {
        if (!currentAssistantEl) return;
        const details = document.createElement('details');
        details.className = 'tool-card';
        details.id = 'tool-' + toolCallId;
        const summary = document.createElement('summary');
        summary.textContent = '🔧 ' + toolName;
        details.appendChild(summary);
        const argsPre = document.createElement('pre');
        argsPre.textContent = JSON.stringify(args, null, 2);
        details.appendChild(argsPre);
        const resultPre = document.createElement('pre');
        resultPre.className = 'tool-result';
        resultPre.textContent = 'Running...';
        details.appendChild(resultPre);
        currentAssistantEl.appendChild(details);
        autoScroll();
      }

      function updateToolCard(toolCallId, text) {
        // Verify progress interception — before card lookup
        if (text) {
          try {
            const parsed = JSON.parse(text);
            if (parsed.__verifyStart) { createVerifyList(parsed.tasks); return; }
            if (parsed.__verifyProgress) { updateVerifyRow(parsed.taskId, parsed.status); return; }
          } catch { /* not JSON, normal flow */ }
        }
        const card = document.getElementById('tool-' + toolCallId);
        if (!card) return;
        const resultPre = card.querySelector('.tool-result');
        if (resultPre) resultPre.textContent = text || 'Running...';
        autoScroll();
      }

      function finalizeToolCard(toolCallId, text, isError) {
        const card = document.getElementById('tool-' + toolCallId);
        if (!card) return;
        if (isError) card.classList.add('tool-error');
        const resultPre = card.querySelector('.tool-result');
        if (resultPre) resultPre.textContent = text || (isError ? '(error)' : '(done)');
      }

      function endStreaming() {
        isStreaming = false;
        sendBtn.classList.remove('hidden');
        abortBtn.classList.add('hidden');
        inputEl.disabled = false;
        if (currentAssistantPre) {
          currentAssistantPre.classList.remove('cursor-blink');
        }
        currentAssistantEl = null;
        currentAssistantPre = null;
        currentThinkingPre = null;
        autoScroll();
      }

      function updateToolbar(data) {
        if (data.model) {
          modelInfoEl.textContent = data.model + (data.thinkingLevel ? ' (' + data.thinkingLevel + ')' : '');
        } else {
          modelInfoEl.textContent = 'Not connected';
        }
        if (data.isStreaming) {
          isStreaming = true;
          sendBtn.classList.add('hidden');
          abortBtn.classList.remove('hidden');
          inputEl.disabled = true;
        } else {
          isStreaming = false;
          sendBtn.classList.remove('hidden');
          abortBtn.classList.add('hidden');
          inputEl.disabled = false;
        }
      }

      // ── Event handler ──

      window.addEventListener('message', (event) => {
        const msg = event.data;
        if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
        switch (msg.type) {
          case 'agentStart': startStreaming(); break;
          case 'agentEnd': endStreaming(); break;
          case 'textDelta': appendToAssistant(msg.delta); break;
          case 'textEnd': finalizeAssistantText(msg.fullText); break;
          case 'thinkingStart': createThinkingBlock(); break;
          case 'thinkingDelta': appendToThinking(msg.delta); break;
          case 'thinkingEnd': finalizeThinking(msg.fullThinking); break;
          case 'toolStart': createToolCard(msg.toolCallId, msg.toolName, msg.args); break;
          case 'toolUpdate': updateToolCard(msg.toolCallId, msg.text); break;
          case 'toolEnd': finalizeToolCard(msg.toolCallId, msg.text, msg.isError); break;
          case 'userMessage': addUserMessage(msg.text); break;
          case 'error': addErrorMessage(msg.message); break;
          case 'stateUpdate': updateToolbar(msg); break;
          case 'compactionStart': addSystemMessage('Compacting context...'); break;
          case 'compactionEnd': addSystemMessage('Compaction complete.'); break;
          case 'retryStart': addSystemMessage('Retrying (' + msg.attempt + '/' + msg.maxAttempts + ')...'); break;
          case 'retryEnd': addSystemMessage(msg.success ? 'Retry succeeded.' : 'Retry failed.'); break;
          case 'clear': messagesEl.innerHTML = ''; break;
          case 'loadHistory':
            messagesEl.innerHTML = '';
            for (const item of msg.messages) {
              switch (item.role) {
                case 'user': addUserMessage(item.content); break;
                case 'assistant': {
                  const div = document.createElement('div');
                  div.className = 'msg msg-assistant';
                  const pre = document.createElement('pre');
                  pre.textContent = item.content;
                  div.appendChild(pre);
                  messagesEl.appendChild(div);
                  break;
                }
                case 'error': addErrorMessage(item.content); break;
                case 'system': addSystemMessage(item.content); break;
              }
            }
            autoScroll();
            break;
        }
      });

      // ── Input ──

      function sendMessage() {
        if (isStreaming) return;
        const text = inputEl.value.trim();
        if (!text) return;
        vscode.postMessage({ type: 'sendMessage', text: text });
        addUserMessage(text);
        inputEl.value = '';
        userScrolledUp = false;
      }

      inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendMessage();
        }
      });

      sendBtn.addEventListener('click', sendMessage);

      abortBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'abort' });
      });

      // ── Init ──
      vscode.postMessage({ type: 'ready' });
    })();
  </script>
</body>
</html>`;
  }
}

// ── Helpers ──────────────────────────────────────────────────

function extractText(result: {
  content: Array<{ type: string; text?: string }>;
} | null | undefined): string {
  if (!result?.content || !Array.isArray(result.content)) return '';
  return result.content
    .filter(
      (c): c is { type: 'text'; text: string } =>
        c != null && typeof c === 'object' && c.type === 'text' && typeof c.text === 'string',
    )
    .map((c) => c.text)
    .join('\n');
}
