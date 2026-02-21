// webview/src/markdown.ts — Markdown rendering with syntax highlighting
// Uses marked for parsing, highlight.js for code blocks, DOMPurify for sanitization.

import { marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/core';

// Register languages (selective to minimize bundle size)
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml'; // includes html
import yaml from 'highlight.js/lib/languages/yaml';
import rust from 'highlight.js/lib/languages/rust';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import sql from 'highlight.js/lib/languages/sql';
import diff from 'highlight.js/lib/languages/diff';
import markdown from 'highlight.js/lib/languages/markdown';

hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('ts', typescript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('py', python);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('sh', bash);
hljs.registerLanguage('shell', bash);
hljs.registerLanguage('zsh', bash);
hljs.registerLanguage('json', json);
hljs.registerLanguage('css', css);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('yml', yaml);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('rs', rust);
hljs.registerLanguage('go', go);
hljs.registerLanguage('golang', go);
hljs.registerLanguage('java', java);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('diff', diff);
hljs.registerLanguage('patch', diff);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('md', markdown);

// ── Custom marked renderer ──

const renderer = new marked.Renderer();

renderer.code = function ({ text, lang }: { text: string; lang?: string | undefined }) {
  const language = lang && hljs.getLanguage(lang) ? lang : undefined;
  const highlighted = language
    ? hljs.highlight(text, { language }).value
    : escapeHtml(text);
  const langLabel = escapeHtml(lang || 'text');
  const escapedCode = escapeAttr(text);
  return `<div class="code-block"><div class="code-header"><span class="code-lang">${langLabel}</span><button class="copy-btn" data-code="${escapedCode}">Copy</button></div><pre><code class="hljs">${highlighted}</code></pre></div>`;
};

renderer.link = function (this: { parser: { parseInline(tokens: unknown[]): string } }, token: { href: string; title?: string | null; tokens: unknown[] }) {
  const text = this.parser.parseInline(token.tokens);
  return `<a href="${escapeAttr(token.href)}" target="_blank" rel="noopener">${text}</a>`;
};

// Configure marked
marked.setOptions({
  renderer,
  gfm: true,
  breaks: true,
});

// ── Public API ──

export function renderMarkdown(raw: string): string {
  const html = marked.parse(raw, { async: false }) as string;
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ['data-code', 'target', 'rel'],
    ADD_TAGS: ['button'],
  });
}

export function escapeHtml(s: string): string {
  const el = document.createElement('span');
  el.textContent = s;
  return el.innerHTML;
}

export function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
