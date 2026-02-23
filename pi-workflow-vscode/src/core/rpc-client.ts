// core/rpc-client.ts — Pi RPC client: spawn pi --mode rpc, JSON lines communication
// Manages child process lifecycle, command/response correlation, and event emission.

import { type ChildProcess, spawn } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import { EventEmitter } from 'node:events';
import type { ExtensionUIResponse, RpcResponse } from '../types/rpc';

const DEFAULT_TIMEOUT_MS = 30_000;
const COMPACT_TIMEOUT_MS = 120_000;

export interface RpcClientOptions {
  cwd: string;
  piPath?: string;
  provider?: string;
  model?: string;
  extraArgs?: string[];
}

interface PendingRequest {
  resolve: (resp: RpcResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class PiRpcClient extends EventEmitter {
  private process: ChildProcess | null = null;
  private rl: Interface | null = null;
  private nextId = 0;
  private readonly pending = new Map<string, PendingRequest>();
  private _running = false;

  constructor(private readonly options: RpcClientOptions) {
    super();
  }

  // ── Lifecycle ────────────────────────────────────────────────

  /**
   * Spawn pi in RPC mode.
   * IMPORTANT: Callers MUST register 'error' and 'exit' listeners BEFORE
   * calling start(). Node.js EventEmitter throws on unhandled 'error' events.
   */
  start(): void {
    if (this._running) return;

    const piPath = this.options.piPath ?? 'pi';
    const args = ['--mode', 'rpc'];
    if (this.options.provider) {
      args.push('--provider', this.options.provider);
    }
    if (this.options.model) {
      args.push('--model', this.options.model);
    }
    if (this.options.extraArgs) {
      args.push(...this.options.extraArgs);
    }

    this.process = spawn(piPath, args, {
      cwd: this.options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32', // Windows .cmd shim compatibility
    });

    this._running = true;

    // Spawn failure (ENOENT, EPERM, etc.) — async event
    this.process.on('error', (err: Error) => {
      this.emit('error', err);
      this.cleanup();
    });

    // Process exit
    this.process.on('close', (code: number | null) => {
      this.emit('exit', code);
      this.cleanup();
    });

    // stdin error → reject all pending immediately (broken pipe, closed stdin)
    if (this.process.stdin) {
      this.process.stdin.on('error', () => {
        this.rejectAllPending('stdin write error');
      });
    }

    // stdout → JSON lines
    if (this.process.stdout) {
      this.rl = createInterface({ input: this.process.stdout });
      this.rl.on('line', (line: string) => this.handleLine(line));
    }

    // stderr → emit for logging
    if (this.process.stderr) {
      this.process.stderr.on('data', (chunk: Buffer) => {
        this.emit('stderr', chunk.toString());
      });
    }
  }

  /** Send SIGTERM and clean up. */
  stop(): void {
    if (this.process) {
      try {
        this.process.kill('SIGTERM');
      } catch {
        // Already dead
      }
    }
    this.cleanup();
  }

  isRunning(): boolean {
    return this._running;
  }

  // ── Commands ─────────────────────────────────────────────────

  prompt(
    message: string,
    options?: {
      streamingBehavior?: 'steer' | 'followUp';
      images?: Array<{ type: 'image'; data: string; mimeType: string }>;
    },
  ): Promise<RpcResponse> {
    const cmd: Record<string, unknown> = { type: 'prompt', message };
    if (options?.streamingBehavior) {
      cmd.streamingBehavior = options.streamingBehavior;
    }
    if (options?.images && options.images.length > 0) {
      cmd.images = options.images;
    }
    return this.sendCommand(cmd);
  }

  abort(): Promise<RpcResponse> {
    return this.sendCommand({ type: 'abort' });
  }

  newSession(): Promise<RpcResponse> {
    return this.sendCommand({ type: 'new_session' });
  }

  getState(): Promise<RpcResponse> {
    return this.sendCommand({ type: 'get_state' });
  }

  getMessages(): Promise<RpcResponse> {
    return this.sendCommand({ type: 'get_messages' });
  }

  setModel(provider: string, modelId: string): Promise<RpcResponse> {
    return this.sendCommand({ type: 'set_model', provider, modelId });
  }

  cycleModel(): Promise<RpcResponse> {
    return this.sendCommand({ type: 'cycle_model' });
  }

  setThinkingLevel(level: string): Promise<RpcResponse> {
    return this.sendCommand({ type: 'set_thinking_level', level });
  }

  compact(customInstructions?: string): Promise<RpcResponse> {
    const cmd: Record<string, unknown> = { type: 'compact' };
    if (customInstructions) {
      cmd.customInstructions = customInstructions;
    }
    return this.sendCommand(cmd, COMPACT_TIMEOUT_MS);
  }

  getAvailableModels(): Promise<RpcResponse> {
    return this.sendCommand({ type: 'get_available_models' });
  }

  getCommands(): Promise<RpcResponse> {
    return this.sendCommand({ type: 'get_commands' });
  }

  // ── Extension UI ─────────────────────────────────────────────

  /** Send extension_ui_response to pi. Fire-and-forget, no command id. */
  sendUIResponse(response: ExtensionUIResponse): void {
    if (!this.process?.stdin?.writable) return;
    this.process.stdin.write(JSON.stringify(response) + '\n');
  }

  // ── Internal ─────────────────────────────────────────────────

  private sendCommand(
    cmd: Record<string, unknown>,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ): Promise<RpcResponse> {
    if (!this._running || !this.process?.stdin?.writable) {
      return Promise.reject(new Error('Not running or stdin not writable'));
    }

    const id = `req-${++this.nextId}`;
    const stdin = this.process.stdin;

    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Command timed out after ${timeoutMs}ms: ${cmd.type}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });

      const message = JSON.stringify({ ...cmd, id }) + '\n';
      stdin.write(message);
    });
  }

  private handleLine(line: string): void {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // Ignore non-JSON lines
    }

    // Command response — correlate with pending request
    if (data.type === 'response' && typeof data.id === 'string') {
      const pending = this.pending.get(data.id);
      if (pending) {
        this.pending.delete(data.id);
        clearTimeout(pending.timer);

        const response = data as unknown as RpcResponse;
        if (response.success) {
          pending.resolve(response);
        } else {
          // Reject on failure so consumers' .catch() handles errors naturally
          pending.reject(
            new Error(response.error ?? `Command failed: ${response.command}`),
          );
        }
      }
    }

    // Emit typed event for all messages (including responses).
    // Guard: never emit 'error' as event name — Node.js EventEmitter throws
    // on unhandled 'error' events. A crafted child output could trigger this.
    if (typeof data.type === 'string' && data.type !== 'error') {
      this.emit(data.type, data);
    }
  }

  private rejectAllPending(reason: string): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }

  private cleanup(): void {
    this._running = false;

    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }

    this.process = null;
    this.rejectAllPending('Process terminated');
  }
}
