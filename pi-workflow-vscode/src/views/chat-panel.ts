// views/chat-panel.ts — Chat WebviewViewProvider for pi RPC communication
// Bridges RPC client events to webview messages and handles user input.

import * as vscode from 'vscode';
import type { PiRpcClient } from '../core/rpc-client';
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

  constructor(private readonly extensionUri: vscode.Uri) {}

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

    if (!this.rpcClient?.isRunning()) {
      // Post idle state so webview knows pi is not connected
      this.postToWebview({ type: 'stateUpdate', isStreaming: false });
      if (msg.type !== 'ready') {
        this.postToWebview({
          type: 'error',
          message: 'Pi is not running. Use "Pi: Start Chat" first.',
        });
      }
      return;
    }

    const client = this.rpcClient;

    switch (msg.type) {
      case 'sendMessage':
        if (typeof msg.text !== 'string' || !msg.text.trim()) return;
        client.prompt(msg.text).catch((err) =>
          this.postToWebview({ type: 'error', message: String(err) }),
        );
        break;
      case 'abort':
        client.abort().catch((err) =>
          this.postToWebview({ type: 'error', message: String(err) }),
        );
        break;
      case 'newSession':
        client
          .newSession()
          .then((resp) => {
            const d = resp.data as { cancelled?: boolean } | undefined;
            if (!d?.cancelled) {
              this.postToWebview({ type: 'clear' });
            }
          })
          .catch((err) =>
            this.postToWebview({ type: 'error', message: String(err) }),
          );
        break;
      case 'ready':
        client
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
        break;
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
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      display: flex; flex-direction: column; height: 100vh;
    }
    #toolbar {
      display: flex; align-items: center; justify-content: space-between;
      padding: 6px 10px;
      border-bottom: 1px solid var(--vscode-panel-border);
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
    #toolbar button {
      background: none; border: none; color: var(--vscode-foreground);
      cursor: pointer; font-size: 16px; padding: 2px 6px; border-radius: 3px;
    }
    #toolbar button:hover { background: var(--vscode-toolbar-hoverBackground); }
    #messages {
      flex: 1; overflow-y: auto; padding: 10px;
      display: flex; flex-direction: column; gap: 8px;
    }
    .msg { padding: 8px 12px; border-radius: 8px; max-width: 90%; word-wrap: break-word; }
    .msg-user {
      align-self: flex-end;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .msg-assistant {
      align-self: flex-start;
      background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
      border: 1px solid var(--vscode-panel-border);
    }
    .msg-assistant pre {
      white-space: pre-wrap; font-family: var(--vscode-editor-font-family);
      font-size: 13px; margin: 0;
    }
    .msg-error {
      align-self: center;
      background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
      color: var(--vscode-errorForeground, #f48771);
      font-size: 12px;
    }
    .msg-system {
      align-self: center;
      color: var(--vscode-descriptionForeground);
      font-size: 11px; font-style: italic;
    }
    .thinking-block {
      font-size: 12px; opacity: 0.6; margin: 4px 0;
    }
    .thinking-block summary { cursor: pointer; }
    .thinking-block pre {
      white-space: pre-wrap; font-family: var(--vscode-editor-font-family);
      font-size: 12px; margin: 4px 0 0 0;
    }
    .tool-card {
      margin: 4px 0; font-size: 12px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px; overflow: hidden;
    }
    .tool-card summary {
      cursor: pointer; padding: 4px 8px;
      background: var(--vscode-textCodeBlock-background);
    }
    .tool-card pre {
      white-space: pre-wrap; font-family: var(--vscode-editor-font-family);
      font-size: 12px; padding: 6px 8px; margin: 0;
      max-height: 200px; overflow-y: auto;
    }
    .tool-error { border-color: var(--vscode-errorForeground, #f48771); }
    .cursor-blink::after {
      content: '▊'; animation: blink 0.8s step-end infinite;
    }
    @keyframes blink { 50% { opacity: 0; } }
    #input-area {
      border-top: 1px solid var(--vscode-panel-border);
      padding: 8px 10px;
      display: flex; gap: 6px; align-items: flex-end;
    }
    #input {
      flex: 1; resize: none;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 4px; padding: 6px 8px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    #input:focus { outline: 1px solid var(--vscode-focusBorder); }
    #input-buttons { display: flex; flex-direction: column; gap: 4px; }
    #input-buttons button {
      padding: 4px 12px; border: none; border-radius: 4px; cursor: pointer;
      font-size: 12px;
    }
    #send-btn {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    #send-btn:hover { background: var(--vscode-button-hoverBackground); }
    #abort-btn {
      background: var(--vscode-errorForeground, #f48771);
      color: #fff;
    }
    .hidden { display: none !important; }
  </style>
</head>
<body>
  <div id="toolbar">
    <span id="model-info">Not connected</span>
    <button id="new-session-btn" title="New Session">⟳</button>
  </div>
  <div id="messages"></div>
  <div id="input-area">
    <textarea id="input" rows="3" placeholder="메시지 입력... (Shift+Enter 줄바꿈)"></textarea>
    <div id="input-buttons">
      <button id="send-btn">Send</button>
      <button id="abort-btn" class="hidden">Abort</button>
    </div>
  </div>

  <script nonce="${nonce}">
    (function() {
      const vscode = acquireVsCodeApi();
      const messagesEl = document.getElementById('messages');
      const inputEl = document.getElementById('input');
      const sendBtn = document.getElementById('send-btn');
      const abortBtn = document.getElementById('abort-btn');
      const newSessionBtn = document.getElementById('new-session-btn');
      const modelInfoEl = document.getElementById('model-info');

      let currentAssistantEl = null;
      let currentAssistantPre = null;
      let currentThinkingPre = null;
      let isStreaming = false;
      let userScrolledUp = false;

      // ── Auto-scroll (batched via rAF to avoid forced reflow per delta) ──
      let scrollPending = false;
      messagesEl.addEventListener('scroll', () => {
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

      // ── Message creation helpers (all use textContent/createTextNode) ──

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
        // Sync send/abort buttons and input with streaming state
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

      newSessionBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'newSession' });
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
