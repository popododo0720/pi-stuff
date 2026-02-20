// core/chat-history.ts — Persists chat messages across VSCode sessions via workspaceState.
// Per-workflow storage: each workflow gets its own history key.

import * as vscode from 'vscode';
import type { ChatHistoryItem } from '../types/rpc';

const STORAGE_KEY = 'pi.chatHistory';
const MAX_MESSAGES = 500;
const MAX_CONTENT_LENGTH = 10_000;

export class ChatHistoryStore {
  private workflowId: string | null = null;

  constructor(private readonly state: vscode.Memento) {}

  /** Set active workflow ID. Changes storage key for per-workflow history. */
  setWorkflowId(id: string | null): void {
    this.workflowId = id;
  }

  private get storageKey(): string {
    return this.workflowId ? `${STORAGE_KEY}.${this.workflowId}` : STORAGE_KEY;
  }

  getAll(): ChatHistoryItem[] {
    return this.state.get<ChatHistoryItem[]>(this.storageKey, []);
  }

  append(item: ChatHistoryItem): void {
    const history = this.getAll();
    const truncated: ChatHistoryItem = {
      ...item,
      content:
        item.content.length > MAX_CONTENT_LENGTH
          ? item.content.slice(0, MAX_CONTENT_LENGTH) + '...(truncated)'
          : item.content,
    };
    history.push(truncated);
    if (history.length > MAX_MESSAGES) {
      history.splice(0, history.length - MAX_MESSAGES);
    }
    void this.state.update(this.storageKey, history);
  }

  addSessionSeparator(): void {
    this.append({
      role: 'system',
      content: '--- New Session ---',
      timestamp: Date.now(),
    });
  }

  clear(): void {
    void this.state.update(this.storageKey, []);
  }
}
