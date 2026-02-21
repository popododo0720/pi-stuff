// types/rpc.ts — RPC protocol types for pi --mode rpc communication
// Based on pi RPC documentation. Only types actually consumed by the extension.

// ── Commands (extension → pi stdin) ────────────────────────────

export interface RpcCommand {
  id?: string;
  type: string;
  [key: string]: unknown;
}

export interface PromptCommand extends RpcCommand {
  type: 'prompt';
  message: string;
  images?: ImageContent[];
  streamingBehavior?: 'steer' | 'followUp';
}

export interface ImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}

// ── Responses (pi stdout → extension) ──────────────────────────

export interface RpcResponse {
  type: 'response';
  id?: string;
  command: string;
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

// ── Agent Events ───────────────────────────────────────────────

export interface AgentStartEvent {
  type: 'agent_start';
}

export interface AgentEndEvent {
  type: 'agent_end';
  messages: unknown[];
}

export interface MessageUpdateEvent {
  type: 'message_update';
  message: unknown;
  assistantMessageEvent: AssistantMessageDelta;
}

export interface AssistantMessageDelta {
  type:
    | 'text_start'
    | 'text_delta'
    | 'text_end'
    | 'thinking_start'
    | 'thinking_delta'
    | 'thinking_end'
    | 'toolcall_start'
    | 'toolcall_delta'
    | 'toolcall_end'
    | 'start'
    | 'done'
    | 'error';
  contentIndex?: number;
  delta?: string;
  content?: string;
  thinking?: string;
  toolCall?: {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  };
  reason?: string;
}

export interface ToolExecutionStartEvent {
  type: 'tool_execution_start';
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface ToolExecutionUpdateEvent {
  type: 'tool_execution_update';
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  partialResult: {
    content: Array<{ type: string; text?: string }>;
  };
}

export interface ToolExecutionEndEvent {
  type: 'tool_execution_end';
  toolCallId: string;
  toolName: string;
  result: {
    content: Array<{ type: string; text?: string }>;
  };
  isError: boolean;
}

export interface AutoCompactionStartEvent {
  type: 'auto_compaction_start';
  reason: string;
}

export interface AutoCompactionEndEvent {
  type: 'auto_compaction_end';
  result: unknown;
  aborted: boolean;
}

export interface AutoRetryStartEvent {
  type: 'auto_retry_start';
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  errorMessage: string;
}

export interface AutoRetryEndEvent {
  type: 'auto_retry_end';
  success: boolean;
  attempt: number;
  finalError?: string;
}

// ── Extension UI Protocol ──────────────────────────────────────

export interface ExtensionUIRequest {
  type: 'extension_ui_request';
  id: string;
  method:
    | 'select'
    | 'confirm'
    | 'input'
    | 'editor'
    | 'notify'
    | 'setStatus'
    | 'setWidget'
    | 'setTitle'
    | 'set_editor_text';
  title?: string;
  options?: string[];
  message?: string;
  placeholder?: string;
  prefill?: string;
  timeout?: number;
  notifyType?: 'info' | 'warning' | 'error';
  statusKey?: string;
  statusText?: string;
  widgetKey?: string;
  widgetLines?: string[];
  text?: string;
}

export interface ExtensionUIResponse {
  type: 'extension_ui_response';
  id: string;
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
}

// ── Agent State (get_state response) ───────────────────────────

export interface AgentState {
  model: {
    id: string;
    name: string;
    provider: string;
  } | null;
  thinkingLevel: string;
  isStreaming: boolean;
  isCompacting: boolean;
  sessionFile: string;
  sessionId: string;
  sessionName?: string;
  messageCount: number;
}

// ── RPC Event union ────────────────────────────────────────────

export type RpcEvent =
  | RpcResponse
  | AgentStartEvent
  | AgentEndEvent
  | MessageUpdateEvent
  | ToolExecutionStartEvent
  | ToolExecutionUpdateEvent
  | ToolExecutionEndEvent
  | AutoCompactionStartEvent
  | AutoCompactionEndEvent
  | AutoRetryStartEvent
  | AutoRetryEndEvent
  | ExtensionUIRequest;

// ── Chat History ───────────────────────────────────────────────

export interface ChatHistoryItem {
  role: 'user' | 'assistant' | 'system' | 'error' | 'tool';
  content: string;
  timestamp: number;
  /** Tool name (tool role only) */
  toolName?: string;
  /** Whether tool execution errored (tool role only) */
  isError?: boolean;
}

// ── Webview <-> Extension messages ─────────────────────────────
// SYNC: keep in sync with webview/src/types.ts

export type ExtToWebview =
  | { type: 'agentStart' }
  | { type: 'agentEnd' }
  | { type: 'textDelta'; delta: string }
  | { type: 'textEnd'; fullText: string }
  | { type: 'thinkingStart' }
  | { type: 'thinkingDelta'; delta: string }
  | { type: 'thinkingEnd'; fullThinking: string }
  | {
      type: 'toolStart';
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
    }
  | { type: 'toolUpdate'; toolCallId: string; text: string }
  | {
      type: 'toolEnd';
      toolCallId: string;
      text: string;
      isError: boolean;
    }
  | { type: 'userMessage'; text: string }
  | { type: 'error'; message: string }
  | {
      type: 'stateUpdate';
      isStreaming: boolean;
      model?: string;
      thinkingLevel?: string;
    }
  | { type: 'compactionStart'; reason: string }
  | { type: 'compactionEnd' }
  | {
      type: 'retryStart';
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      error: string;
    }
  | { type: 'retryEnd'; success: boolean }
  | { type: 'clear' }
  | { type: 'loadHistory'; messages: ChatHistoryItem[] };

export type WebviewToExt =
  | {
      type: 'sendMessage';
      text: string;
      streamingBehavior?: 'steer' | 'followUp';
    }
  | { type: 'abort' }
  | { type: 'ready' };
