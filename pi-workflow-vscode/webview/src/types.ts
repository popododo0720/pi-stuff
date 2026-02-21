// SYNC: keep in sync with src/types/rpc.ts (ExtToWebview, WebviewToExt)
// These types are declared independently because webview and extension
// are separate build targets that cannot share imports.

export interface ChatHistoryItem {
  role: 'user' | 'assistant' | 'system' | 'error' | 'tool';
  content: string;
  timestamp: number;
  /** Tool name (tool role only) */
  toolName?: string;
  /** Whether tool execution errored (tool role only) */
  isError?: boolean;
}

export interface AttachedFile {
  name: string;
  mimeType: string;
  /** base64-encoded data for images */
  data?: string;
  /** Absolute path for non-image files */
  path?: string;
}

export type ExtToWebview =
  | { type: 'agentStart' }
  | { type: 'agentEnd' }
  | { type: 'textDelta'; delta: string }
  | { type: 'textEnd'; fullText: string }
  | { type: 'thinkingStart' }
  | { type: 'thinkingDelta'; delta: string }
  | { type: 'thinkingEnd'; fullThinking: string }
  | { type: 'toolStart'; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { type: 'toolUpdate'; toolCallId: string; text: string }
  | { type: 'toolEnd'; toolCallId: string; text: string; isError: boolean }
  | { type: 'userMessage'; text: string }
  | { type: 'error'; message: string }
  | { type: 'stateUpdate'; isStreaming: boolean; model?: string; thinkingLevel?: string }
  | { type: 'compactionStart'; reason: string }
  | { type: 'compactionEnd' }
  | { type: 'retryStart'; attempt: number; maxAttempts: number; delayMs: number; error: string }
  | { type: 'retryEnd'; success: boolean }
  | { type: 'clear' }
  | { type: 'loadHistory'; messages: ChatHistoryItem[] }
  | { type: 'fileAttached'; file: AttachedFile };

export type WebviewToExt =
  | { type: 'sendMessage'; text: string; images?: Array<{ type: 'image'; data: string; mimeType: string }> }
  | { type: 'abort' }
  | { type: 'ready' }
  | { type: 'pickFile' };
