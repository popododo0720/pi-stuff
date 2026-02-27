import { describe, expect, it } from 'vitest';
import { escapeHtml, getCspMeta, markdownToHtml } from '../html-utils';

describe('escapeHtml', () => {
  it('escapes &, <, >, ", \'', () => {
    expect(escapeHtml('&<>"\''))
      .toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  it('returns empty string for empty input', () => {
    expect(escapeHtml('')).toBe('');
  });

  it('preserves normal text', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });
});

describe('markdownToHtml', () => {
  it('converts # heading to h1', () => {
    expect(markdownToHtml('# Title')).toContain('<h1>Title</h1>');
  });

  it('converts ## heading to h2', () => {
    expect(markdownToHtml('## Section')).toContain('<h2>Section</h2>');
  });

  it('converts ### heading to h3', () => {
    expect(markdownToHtml('### Sub')).toContain('<h3>Sub</h3>');
  });

  it('converts code blocks', () => {
    const input = '```\nconst x = 1;\n```';
    const result = markdownToHtml(input);
    expect(result).toContain('<pre><code>');
    expect(result).toContain('const x = 1;');
  });

  it('converts list items', () => {
    const result = markdownToHtml('- item 1\n- item 2');
    expect(result).toContain('<ul>');
    expect(result).toContain('<li>item 1</li>');
    expect(result).toContain('<li>item 2</li>');
    expect(result).toContain('</ul>');
  });

  it('converts bold text', () => {
    expect(markdownToHtml('**bold**')).toContain('<strong>bold</strong>');
  });

  it('converts italic text', () => {
    expect(markdownToHtml('*italic*')).toContain('<em>italic</em>');
  });

  it('converts inline code', () => {
    expect(markdownToHtml('`code`')).toContain('<code>code</code>');
  });

  it('escapes HTML in content (XSS prevention)', () => {
    const result = markdownToHtml('<script>alert("xss")</script>');
    expect(result).not.toContain('<script>');
    expect(result).toContain('&lt;script&gt;');
  });

  it('handles empty input', () => {
    const result = markdownToHtml('');
    expect(result).toBeDefined();
  });

  it('closes unclosed lists', () => {
    const result = markdownToHtml('- item');
    expect(result).toContain('</ul>');
  });

  it('handles indented list items', () => {
    const result = markdownToHtml('  - indented');
    expect(result).toContain('<li>');
  });
});

describe('getCspMeta', () => {
  it('includes style-src by default', () => {
    const result = getCspMeta('abc123');
    expect(result).toContain("style-src 'nonce-abc123'");
  });

  it('does not include script-src by default', () => {
    const result = getCspMeta('abc123');
    expect(result).not.toContain('script-src');
  });

  it('includes script-src when opts.scripts is true', () => {
    const result = getCspMeta('abc123', { scripts: true });
    expect(result).toContain("script-src 'nonce-abc123'");
    expect(result).toContain("style-src 'nonce-abc123'");
  });

  it('does not include script-src when opts.scripts is false', () => {
    const result = getCspMeta('abc123', { scripts: false });
    expect(result).not.toContain('script-src');
  });
});
