// views/html-utils.ts — Shared HTML utilities for webview panels
// Escape responsibility is centralized here — callers pass raw text.

import { randomBytes } from 'node:crypto';

/** Escape HTML special characters to prevent XSS. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Convert basic markdown to HTML.
 * Escape responsibility is inside this function — pass raw markdown.
 *
 * Supported syntax:
 * - # / ## / ### headings
 * - ```code blocks```
 * - **bold**, *italic*
 * - - list items
 * - Blank lines → paragraph breaks
 */
export function markdownToHtml(md: string): string {
  const lines = md.split(/\r?\n/);
  const result: string[] = [];
  let inCodeBlock = false;
  let codeBuffer: string[] = [];
  let inList = false;

  for (const line of lines) {
    // Code block toggle
    if (line.trimStart().startsWith('```')) {
      if (inCodeBlock) {
        result.push(`<pre><code>${codeBuffer.join('\n')}</code></pre>`);
        codeBuffer = [];
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeBuffer.push(escapeHtml(line));
      continue;
    }

    // Close list if non-list line follows
    const isListItem = !inCodeBlock && line.trimStart().startsWith('- ');
    if (inList && !isListItem) {
      result.push('</ul>');
      inList = false;
    }

    // Blank line → paragraph break
    if (line.trim() === '') {
      result.push('<br>');
      continue;
    }

    let escaped = escapeHtml(line);

    // Headings (with inline formatting)
    if (escaped.startsWith('### ')) {
      result.push(`<h3>${applyInlineFormatting(escaped.slice(4))}</h3>`);
      continue;
    }
    if (escaped.startsWith('## ')) {
      result.push(`<h2>${applyInlineFormatting(escaped.slice(3))}</h2>`);
      continue;
    }
    if (escaped.startsWith('# ')) {
      result.push(`<h1>${applyInlineFormatting(escaped.slice(2))}</h1>`);
      continue;
    }

    // List items (wrapped in <ul>)
    if (isListItem) {
      if (!inList) {
        result.push('<ul>');
        inList = true;
      }
      const itemText = escaped.trimStart().slice(2); // Remove "- " prefix
      result.push(`<li>${applyInlineFormatting(itemText)}</li>`);
      continue;
    }

    // Inline formatting for paragraphs, headings handled above
    result.push(`<p>${applyInlineFormatting(escaped)}</p>`);
  }

  // Close unclosed list
  if (inList) {
    result.push('</ul>');
  }

  // Close unclosed code block
  if (inCodeBlock && codeBuffer.length > 0) {
    result.push(`<pre><code>${codeBuffer.join('\n')}</code></pre>`);
  }

  return result.join('\n');
}

/** Apply inline markdown formatting (bold, italic, inline code). */
function applyInlineFormatting(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

/** Generate CSP meta tag for webview. */
export function getCspMeta(nonce: string): string {
  return `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}';">`;
}

/** Generate cryptographic nonce for CSP. */
export function getNonce(): string {
  return randomBytes(16).toString('hex');
}
