// bridge/extension-ui.ts — Maps pi extension_ui_request events to VSCode native dialogs.
// Dialog methods (select/confirm/input/editor) send a response back to pi.
// Fire-and-forget methods (notify/setStatus/setWidget/setTitle/set_editor_text) are handled without response.

import * as vscode from 'vscode';
import type { PiRpcClient } from '../core/rpc-client';
import type { ExtensionUIRequest, ExtensionUIResponse } from '../types/rpc';

export class ExtensionUIBridge {
  private handler: ((req: ExtensionUIRequest) => void) | null = null;

  constructor(private readonly rpcClient: PiRpcClient) {}

  /** Attach extension_ui_request listener to the RPC client. Idempotent. */
  bind(): void {
    // Prevent duplicate listener registration
    if (this.handler) return;
    this.handler = (req: ExtensionUIRequest) => {
      this.handleRequest(req);
    };
    this.rpcClient.on('extension_ui_request', this.handler);
  }

  /** Remove listener. */
  dispose(): void {
    if (this.handler) {
      this.rpcClient.removeListener('extension_ui_request', this.handler);
      this.handler = null;
    }
  }

  // ── Request routing ──────────────────────────────────────────

  private async handleRequest(req: ExtensionUIRequest): Promise<void> {
    // Fire-and-forget methods — no response needed, no id required
    switch (req.method) {
      case 'notify':
        this.handleNotify(req);
        return;
      case 'setStatus':
      case 'setWidget':
      case 'setTitle':
      case 'set_editor_text':
        // Ignored — fire-and-forget
        return;
    }

    // Dialog methods require a valid id for response correlation
    if (!req.id || typeof req.id !== 'string') return;

    // Dialog methods — always send a response
    let result: Partial<ExtensionUIResponse>;
    try {
      switch (req.method) {
        case 'select':
          result = await this.handleSelect(req);
          break;
        case 'confirm':
          result = await this.handleConfirm(req);
          break;
        case 'input':
          result = await this.handleInput(req);
          break;
        case 'editor':
          result = await this.handleEditor(req);
          break;
        default:
          // Unknown method — send cancelled to prevent pi from hanging
          result = { cancelled: true };
          break;
      }
    } catch {
      // On any error, send cancelled to prevent pi from hanging indefinitely
      result = { cancelled: true };
    }

    this.rpcClient.sendUIResponse({
      type: 'extension_ui_response',
      id: req.id,
      ...result,
    });
  }

  // ── Dialog handlers ──────────────────────────────────────────

  private async handleSelect(
    req: ExtensionUIRequest,
  ): Promise<Partial<ExtensionUIResponse>> {
    const picked = await vscode.window.showQuickPick(req.options ?? [], {
      title: req.title,
    });
    if (picked === undefined) return { cancelled: true };
    return { value: picked };
  }

  private async handleConfirm(
    req: ExtensionUIRequest,
  ): Promise<Partial<ExtensionUIResponse>> {
    const picked = await vscode.window.showQuickPick(['Yes', 'No'], {
      title: req.title,
    });
    if (picked === undefined) return { cancelled: true };
    return { confirmed: picked === 'Yes' };
  }

  private async handleInput(
    req: ExtensionUIRequest,
  ): Promise<Partial<ExtensionUIResponse>> {
    const value = await vscode.window.showInputBox({
      prompt: req.title,
      value: req.prefill,
    });
    if (value === undefined) return { cancelled: true };
    return { value };
  }

  private async handleEditor(
    req: ExtensionUIRequest,
  ): Promise<Partial<ExtensionUIResponse>> {
    const value = await vscode.window.showInputBox({
      prompt: req.title,
      value: req.text,
    });
    if (value === undefined) return { cancelled: true };
    return { value };
  }

  // ── Fire-and-forget handlers ─────────────────────────────────

  private handleNotify(req: ExtensionUIRequest): void {
    const msg = req.message ?? '';
    switch (req.notifyType) {
      case 'warning':
        vscode.window.showWarningMessage(msg);
        break;
      case 'error':
        vscode.window.showErrorMessage(msg);
        break;
      default:
        vscode.window.showInformationMessage(msg);
        break;
    }
  }
}
