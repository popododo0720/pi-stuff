// views/chat-panel.ts — Chat WebviewViewProvider for pi RPC communication
// Bridges RPC client events to webview messages and handles user input.

import * as vscode from 'vscode';
import type { PiRpcClient } from '../core/rpc-client';
import type { ChatHistoryStore } from '../core/chat-history';
import type {
  AgentState,
  AttachedFile,
  AutoRetryStartEvent,
  ExtToWebview,
  ImageContent,
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
        {
          const images = Array.isArray(msg.images) && msg.images.length > 0
            ? msg.images as ImageContent[]
            : undefined;
          client.prompt(msg.text, images ? { images } : undefined).catch((err) =>
            this.postToWebview({ type: 'error', message: String(err) }),
          );
        }
        break;
      case 'abort':
        client.abort().catch((err) =>
          this.postToWebview({ type: 'error', message: String(err) }),
        );
        break;
      case 'pickFile':
        this.handlePickFile();
        break;
    }
  }

  // ── File attachment ───────────────────────────────────────────

  private async handlePickFile(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: 'Attach',
      filters: {
        'Images': ['png', 'jpg', 'jpeg', 'gif', 'webp'],
        'Text': ['txt', 'md', 'json', 'yaml', 'yml', 'toml', 'ts', 'js', 'py', 'rs', 'go', 'java', 'sh'],
        'All Files': ['*'],
      },
    });

    if (!uris || uris.length === 0) return;

    const uri = uris[0];
    const name = uri.path.split('/').pop() || 'file';
    const ext = name.split('.').pop()?.toLowerCase() || '';

    const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
    const MIME_MAP: Record<string, string> = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
    };

    const attached: AttachedFile = { name, mimeType: 'text/plain' };

    if (IMAGE_EXTS.has(ext)) {
      try {
        const fileData = await vscode.workspace.fs.readFile(uri);
        // Size guard: max 10MB for images
        if (fileData.byteLength > 10 * 1024 * 1024) {
          this.postToWebview({ type: 'error', message: `File too large: ${name} (max 10MB)` });
          return;
        }
        attached.mimeType = MIME_MAP[ext] || 'image/png';
        attached.data = Buffer.from(fileData).toString('base64');
      } catch (err) {
        this.postToWebview({ type: 'error', message: `Failed to read file: ${String(err)}` });
        return;
      }
    } else {
      attached.path = uri.fsPath;
    }

    this.postToWebview({ type: 'fileAttached', file: attached });
  }

  // ── HTML ─────────────────────────────────────────────────────

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const mainJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'out', 'webview', 'main.js'),
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="csp-nonce" content="${nonce}">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}' ${webview.cspSource}; img-src data:;">
</head>
<body>
  <div id="toolbar">
    <span id="model-info">Not connected</span>
  </div>
  <div id="messages"></div>
  <div id="input-area">
    <div id="file-chips"></div>
    <div id="input-card">
      <textarea id="input" rows="1" placeholder="메시지 입력... (Shift+Enter 줄바꿈)"></textarea>
      <div id="input-buttons">
        <button id="attach-btn" title="Attach file">📎</button>
        <button id="send-btn">Send</button>
        <button id="abort-btn" class="hidden">Stop</button>
      </div>
    </div>
  </div>
  <script nonce="${nonce}" src="${mainJsUri}"></script>
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
