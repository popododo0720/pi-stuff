// webview/src/main.ts — Chat webview entry point
// Handles message routing, DOM manipulation, and user input.

import type { AttachedFile, ExtToWebview } from './types';
import { renderMarkdown, escapeHtml } from './markdown';
import { ansiToHtml } from './ansi';
import cssText from './styles.css';

// ── CSS injection (nonce-based) ──
const nonce = document.querySelector('meta[name="csp-nonce"]')?.getAttribute('content') || '';
const styleEl = document.createElement('style');
styleEl.setAttribute('nonce', nonce);
styleEl.textContent = cssText;
document.head.appendChild(styleEl);

// ── VSCode API ──
declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscode = acquireVsCodeApi();

// ── DOM refs ──
const messagesEl = document.getElementById('messages')!;
const inputEl = document.getElementById('input') as HTMLTextAreaElement;
const sendBtn = document.getElementById('send-btn')!;
const abortBtn = document.getElementById('abort-btn')!;
const attachBtn = document.getElementById('attach-btn')!;
const fileChipsEl = document.getElementById('file-chips')!;
const modelInfoEl = document.getElementById('model-info')!;

let currentAssistantEl: HTMLElement | null = null;
let currentAssistantContent: HTMLDivElement | null = null;
let currentThinkingPre: HTMLPreElement | null = null;
let isStreaming = false;
let userScrolledUp = false;

// Streaming markdown state
let assistantRawBuffer = '';
let renderPending = false;

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

function autoScroll(): void {
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

// ── Verification progress list ──

let verifyContainer: HTMLElement | null = null;

function createVerifyList(tasks: Array<{ taskId: string; label: string }>): void {
  if (verifyContainer) verifyContainer.remove();
  const container = document.createElement('div');
  container.className = 'verify-progress';
  container.innerHTML = '<div class="verify-header">🔍 Verification</div>';
  for (const task of tasks) {
    const row = document.createElement('div');
    row.className = 'verify-row';
    row.id = 'verify-' + task.taskId;
    row.innerHTML =
      '<span class="verify-icon running"></span><span class="verify-label">' +
      escapeHtml(task.label) +
      '</span>';
    container.appendChild(row);
  }
  if (currentAssistantEl) {
    currentAssistantEl.appendChild(container);
  } else {
    messagesEl.appendChild(container);
  }
  verifyContainer = container;
  autoScroll();
}

function updateVerifyRow(taskId: string, status: string): void {
  const row = document.getElementById('verify-' + taskId);
  if (!row) return;
  const icon = row.querySelector('.verify-icon');
  if (!icon) return;
  icon.className = 'verify-icon ' + status;
  switch (status) {
    case 'passed':
      icon.textContent = '✓';
      break;
    case 'failed':
      icon.textContent = '✗';
      break;
    case 'skipped':
      icon.textContent = '⊘';
      break;
    default:
      icon.textContent = '';
      break;
  }
  autoScroll();
}

// ── Message creation helpers ──

function addUserMessage(text: string): void {
  const div = document.createElement('div');
  div.className = 'msg msg-user';
  div.textContent = text;
  messagesEl.appendChild(div);
  autoScroll();
}

function addErrorMessage(text: string): void {
  const div = document.createElement('div');
  div.className = 'msg msg-error';
  div.textContent = text;
  messagesEl.appendChild(div);
  autoScroll();
}

function addSystemMessage(text: string): void {
  const div = document.createElement('div');
  div.className = 'msg msg-system';
  div.textContent = text;
  messagesEl.appendChild(div);
  autoScroll();
}

function startStreaming(): void {
  isStreaming = true;
  sendBtn.classList.add('hidden');
  abortBtn.classList.remove('hidden');
  inputEl.disabled = true;

  const div = document.createElement('div');
  div.className = 'msg msg-assistant';
  const content = document.createElement('div');
  content.className = 'msg-content';
  content.innerHTML = '<span class="cursor-blink"></span>';
  div.appendChild(content);
  messagesEl.appendChild(div);
  currentAssistantEl = div;
  currentAssistantContent = content;
  assistantRawBuffer = '';
  autoScroll();
}

function appendToAssistant(delta: string): void {
  if (!currentAssistantContent) return;
  assistantRawBuffer += delta;
  if (!renderPending) {
    renderPending = true;
    requestAnimationFrame(() => {
      renderPending = false;
      // Guard: if finalized or buffer cleared, skip stale render
      if (!currentAssistantContent || !assistantRawBuffer) return;
      currentAssistantContent.innerHTML =
        renderMarkdown(assistantRawBuffer) +
        '<span class="cursor-blink"></span>';
      bindCopyButtons(currentAssistantContent);
      autoScroll();
    });
  }
}

function finalizeAssistantText(fullText: string): void {
  if (!currentAssistantContent) return;
  currentAssistantContent.innerHTML = renderMarkdown(fullText);
  bindCopyButtons(currentAssistantContent);
  assistantRawBuffer = '';
  renderPending = false;
}

function createThinkingBlock(): void {
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

function appendToThinking(delta: string): void {
  if (!currentThinkingPre) return;
  currentThinkingPre.appendChild(document.createTextNode(delta));
  autoScroll();
}

function finalizeThinking(fullThinking: string): void {
  if (!currentThinkingPre) return;
  currentThinkingPre.textContent = fullThinking;
  currentThinkingPre = null;
}

// ── Tool card helpers ──

function getToolIcon(name: string): string {
  const icons: Record<string, string> = {
    Bash: '⚡', Read: '📄', Edit: '✏️', Write: '📝',
    workflow_transition: '🔄', project_memory: '🧠',
    module_conventions: '📦',
  };
  return icons[name] || '🔧';
}

function getToolSummary(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'Bash': {
      const cmd = typeof args.command === 'string' ? args.command : '';
      const firstLine = cmd.split('\n')[0] || '';
      return firstLine.length > 80 ? firstLine.slice(0, 77) + '...' : firstLine;
    }
    case 'Read':
      return typeof args.path === 'string' ? args.path : '';
    case 'Edit':
      return typeof args.path === 'string' ? args.path + ' (edit)' : '';
    case 'Write':
      return typeof args.path === 'string' ? args.path + ' (write)' : '';
    case 'workflow_transition':
      return typeof args.action === 'string' ? args.action : '';
    case 'project_memory': {
      const action = typeof args.action === 'string' ? args.action : '';
      const cat = typeof args.category === 'string' ? args.category : '';
      return cat ? `${action} ${cat}` : action;
    }
    default: {
      const s = JSON.stringify(args);
      return s.length > 80 ? s.slice(0, 77) + '...' : s;
    }
  }
}

function createToolCard(
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown>,
): void {
  if (!currentAssistantEl) return;

  const card = document.createElement('div');
  card.className = 'tool-card';
  card.setAttribute('data-tool-id', toolCallId);

  const header = document.createElement('div');
  header.className = 'tool-header';
  header.innerHTML =
    `<span class="tool-chevron">▶</span>` +
    `<span class="tool-icon">${getToolIcon(toolName)}</span>` +
    `<span class="tool-name">${escapeHtml(toolName)}</span>` +
    `<span class="tool-summary">${escapeHtml(getToolSummary(toolName, args))}</span>` +
    `<span class="tool-status"><span class="spinner"></span></span>`;
  header.addEventListener('click', () => {
    card.classList.toggle('open');
  });
  card.appendChild(header);

  const body = document.createElement('div');
  body.className = 'tool-body';
  const output = document.createElement('div');
  output.className = 'tool-output';
  body.appendChild(output);
  card.appendChild(body);

  currentAssistantEl.appendChild(card);
  autoScroll();
}

function updateToolCard(toolCallId: string, text: string): void {
  // Verify progress interception — before card lookup
  if (text) {
    try {
      const parsed = JSON.parse(text);
      if (parsed.__verifyStart) {
        createVerifyList(parsed.tasks);
        return;
      }
      if (parsed.__verifyProgress) {
        updateVerifyRow(parsed.taskId, parsed.status);
        return;
      }
    } catch {
      /* not JSON, normal flow */
    }
  }
  const card = document.querySelector(`[data-tool-id="${toolCallId}"]`);
  if (!card) return;
  const output = card.querySelector('.tool-output');
  if (output) output.innerHTML = ansiToHtml(text || '');
  autoScroll();
}

function finalizeToolCard(
  toolCallId: string,
  text: string,
  isError: boolean,
): void {
  const card = document.querySelector(`[data-tool-id="${toolCallId}"]`);
  if (!card) return;

  // Update status icon
  const status = card.querySelector('.tool-status');
  if (status) {
    if (isError) {
      status.className = 'tool-status error';
      status.textContent = '✗';
    } else {
      status.className = 'tool-status done';
      status.textContent = '✓';
    }
  }

  // Update output with ANSI colors
  const output = card.querySelector('.tool-output');
  if (output) {
    output.innerHTML = text ? ansiToHtml(text) : (isError ? '(error)' : '(done)');
  }

  // Auto-expand on error
  if (isError) {
    card.classList.add('tool-error', 'open');
  }
}

function createRestoredToolCard(toolName: string, content: string, isError: boolean): HTMLElement {
  const card = document.createElement('div');
  card.className = 'tool-card';
  const header = document.createElement('div');
  header.className = 'tool-header';
  header.innerHTML =
    `<span class="tool-chevron">▶</span>` +
    `<span class="tool-icon">${getToolIcon(toolName)}</span>` +
    `<span class="tool-name">${escapeHtml(toolName)}</span>` +
    `<span class="tool-status ${isError ? 'error' : 'done'}">${isError ? '✗' : '✓'}</span>`;
  header.addEventListener('click', () => card.classList.toggle('open'));
  card.appendChild(header);
  if (content) {
    const body = document.createElement('div');
    body.className = 'tool-body';
    const output = document.createElement('div');
    output.className = 'tool-output';
    output.textContent = content;
    body.appendChild(output);
    card.appendChild(body);
  }
  return card;
}

function bindCopyButtons(container: HTMLElement): void {
  container.querySelectorAll('.copy-btn').forEach((btn) => {
    if (btn.getAttribute('data-bound')) return;
    btn.setAttribute('data-bound', '1');
    btn.addEventListener('click', () => {
      const code = btn.getAttribute('data-code') || '';
      navigator.clipboard.writeText(code).then(() => {
        btn.textContent = 'Copied!';
        setTimeout(() => {
          btn.textContent = 'Copy';
        }, 1500);
      });
    });
  });
}

function endStreaming(): void {
  isStreaming = false;
  sendBtn.classList.remove('hidden');
  abortBtn.classList.add('hidden');
  inputEl.disabled = false;
  // Remove cursor blink from content
  if (currentAssistantContent) {
    const cursor = currentAssistantContent.querySelector('.cursor-blink');
    if (cursor) cursor.remove();
  }
  currentAssistantEl = null;
  currentAssistantContent = null;
  currentThinkingPre = null;
  assistantRawBuffer = '';
  renderPending = false;
  autoScroll();
}

function updateToolbar(data: {
  isStreaming: boolean;
  model?: string;
  thinkingLevel?: string;
}): void {
  if (data.model) {
    modelInfoEl.textContent =
      data.model + (data.thinkingLevel ? ' (' + data.thinkingLevel + ')' : '');
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

window.addEventListener('message', (event: MessageEvent) => {
  const msg = event.data as ExtToWebview;
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
  switch (msg.type) {
    case 'agentStart':
      startStreaming();
      break;
    case 'agentEnd':
      endStreaming();
      break;
    case 'textDelta':
      appendToAssistant(msg.delta);
      break;
    case 'textEnd':
      finalizeAssistantText(msg.fullText);
      break;
    case 'thinkingStart':
      createThinkingBlock();
      break;
    case 'thinkingDelta':
      appendToThinking(msg.delta);
      break;
    case 'thinkingEnd':
      finalizeThinking(msg.fullThinking);
      break;
    case 'toolStart':
      createToolCard(msg.toolCallId, msg.toolName, msg.args);
      break;
    case 'toolUpdate':
      updateToolCard(msg.toolCallId, msg.text);
      break;
    case 'toolEnd':
      finalizeToolCard(msg.toolCallId, msg.text, msg.isError);
      break;
    case 'userMessage':
      addUserMessage(msg.text);
      break;
    case 'error':
      addErrorMessage(msg.message);
      break;
    case 'stateUpdate':
      updateToolbar(msg);
      break;
    case 'compactionStart':
      addSystemMessage('Compacting context...');
      break;
    case 'compactionEnd':
      addSystemMessage('Compaction complete.');
      break;
    case 'retryStart':
      addSystemMessage(
        'Retrying (' + msg.attempt + '/' + msg.maxAttempts + ')...',
      );
      break;
    case 'retryEnd':
      addSystemMessage(msg.success ? 'Retry succeeded.' : 'Retry failed.');
      break;
    case 'fileAttached':
      addFileChip(msg.file);
      break;
    case 'clear':
      messagesEl.innerHTML = '';
      break;
    case 'loadHistory': {
      messagesEl.innerHTML = '';
      let lastAssistantDiv: HTMLElement | null = null;
      for (const item of msg.messages) {
        switch (item.role) {
          case 'user':
            lastAssistantDiv = null;
            addUserMessage(item.content);
            break;
          case 'assistant': {
            const div = document.createElement('div');
            div.className = 'msg msg-assistant';
            const content = document.createElement('div');
            content.className = 'msg-content';
            content.innerHTML = renderMarkdown(item.content);
            bindCopyButtons(content);
            div.appendChild(content);
            messagesEl.appendChild(div);
            lastAssistantDiv = div;
            break;
          }
          case 'tool': {
            const card = createRestoredToolCard(
              item.toolName || 'tool',
              item.content,
              item.isError || false,
            );
            if (lastAssistantDiv) lastAssistantDiv.appendChild(card);
            else messagesEl.appendChild(card);
            break;
          }
          case 'error':
            lastAssistantDiv = null;
            addErrorMessage(item.content);
            break;
          case 'system':
            lastAssistantDiv = null;
            addSystemMessage(item.content);
            break;
        }
      }
      autoScroll();
      break;
    }
  }
});

// ── Auto-resize textarea ──

const MIN_ROWS = 1;
const MAX_ROWS = 12;
const LINE_HEIGHT = 20; // px, matches CSS

function autoResizeInput(): void {
  inputEl.style.height = 'auto';
  const scrollH = inputEl.scrollHeight;
  const maxH = MAX_ROWS * LINE_HEIGHT;
  const minH = MIN_ROWS * LINE_HEIGHT;
  inputEl.style.height = Math.min(Math.max(scrollH, minH), maxH) + 'px';
  inputEl.style.overflowY = scrollH > maxH ? 'auto' : 'hidden';
}

inputEl.addEventListener('input', autoResizeInput);

// Initialize height
requestAnimationFrame(autoResizeInput);

// ── File attachment state ──

const attachedFiles: AttachedFile[] = [];

function addFileChip(file: AttachedFile): void {
  attachedFiles.push(file);
  renderFileChips();
}

function removeFileChip(index: number): void {
  attachedFiles.splice(index, 1);
  renderFileChips();
}

function renderFileChips(): void {
  fileChipsEl.innerHTML = '';
  for (let i = 0; i < attachedFiles.length; i++) {
    const file = attachedFiles[i];
    const chip = document.createElement('div');
    chip.className = 'file-chip';

    const isImage = file.mimeType.startsWith('image/');
    if (isImage && file.data) {
      const thumb = document.createElement('img');
      thumb.src = `data:${file.mimeType};base64,${file.data}`;
      thumb.className = 'file-thumb';
      thumb.alt = file.name;
      chip.appendChild(thumb);
    } else {
      const icon = document.createElement('span');
      icon.className = 'file-icon';
      icon.textContent = '📄';
      chip.appendChild(icon);
    }

    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = file.name;
    chip.appendChild(name);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'file-remove';
    removeBtn.textContent = '×';
    removeBtn.title = 'Remove';
    const idx = i;
    removeBtn.addEventListener('click', () => removeFileChip(idx));
    chip.appendChild(removeBtn);

    fileChipsEl.appendChild(chip);
  }
  fileChipsEl.style.display = attachedFiles.length > 0 ? 'flex' : 'none';
}

// ── Input ──

function sendMessage(): void {
  if (isStreaming) return;
  const text = inputEl.value.trim();
  if (!text && attachedFiles.length === 0) return;

  // Collect images for RPC
  const images: Array<{ type: 'image'; data: string; mimeType: string }> = [];
  const textFileRefs: string[] = [];

  for (const f of attachedFiles) {
    if (f.mimeType.startsWith('image/') && f.data) {
      images.push({ type: 'image', data: f.data, mimeType: f.mimeType });
    } else if (f.path) {
      textFileRefs.push(f.path);
    }
  }

  // Build message: append file references for non-image files
  let message = text;
  if (textFileRefs.length > 0) {
    const refs = textFileRefs.map((p) => `[attached: ${p}]`).join('\n');
    message = message ? message + '\n\n' + refs : refs;
  }

  if (!message && images.length === 0) return;

  vscode.postMessage({
    type: 'sendMessage',
    text: message,
    images: images.length > 0 ? images : undefined,
  });

  // Show user message
  let displayText = text;
  if (attachedFiles.length > 0) {
    const fileNames = attachedFiles.map((f) => f.name).join(', ');
    displayText = displayText
      ? displayText + '\n📎 ' + fileNames
      : '📎 ' + fileNames;
  }
  addUserMessage(displayText);

  // Reset
  inputEl.value = '';
  attachedFiles.length = 0;
  renderFileChips();
  autoResizeInput();
  userScrolledUp = false;
}

inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

sendBtn.addEventListener('click', sendMessage);

abortBtn.addEventListener('click', () => {
  vscode.postMessage({ type: 'abort' });
});

attachBtn.addEventListener('click', () => {
  vscode.postMessage({ type: 'pickFile' });
});

// ── Event handler for file attachment responses ──

// Handle fileAttached in the message handler
// (already in the switch case above via main event handler)

// ── Init ──
renderFileChips(); // hide initially
vscode.postMessage({ type: 'ready' });
