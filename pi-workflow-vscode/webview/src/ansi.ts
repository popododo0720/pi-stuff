// webview/src/ansi.ts — ANSI escape code to HTML converter
// Creates a fresh AnsiUp instance per call to avoid state leakage between tool cards.
// Post-processes output to merge inline styles into existing class attributes (CSP compliance).

import { AnsiUp } from 'ansi_up';

// Map of known inline style values → CSS class names
const STYLE_TO_CLASS: Array<[RegExp, string]> = [
  [/font-weight:\s*bold/i, 'ansi-bold'],
  [/font-style:\s*italic/i, 'ansi-italic'],
  [/text-decoration:\s*underline/i, 'ansi-underline'],
];

export function ansiToHtml(text: string): string {
  const converter = new AnsiUp();
  converter.use_classes = true;
  let html = converter.ansi_to_html(text);

  // Replace inline style= on elements that may already have class= attributes.
  // Strategy: match entire opening tag, extract existing classes, convert style to classes, merge.
  html = html.replace(
    /<span([^>]*)>/g,
    (_match: string, attrs: string) => {
      // Extract existing class attribute
      const classMatch = attrs.match(/class="([^"]*)"/);
      const existingClasses = classMatch ? classMatch[1] : '';

      // Extract style attribute and convert to classes
      const styleMatch = attrs.match(/style="([^"]*)"/);
      const newClasses: string[] = [];
      if (styleMatch) {
        const styleContent = styleMatch[1];
        for (const [pattern, className] of STYLE_TO_CLASS) {
          if (pattern.test(styleContent)) {
            newClasses.push(className);
          }
        }
      }

      // Merge all classes
      const allClasses = [existingClasses, ...newClasses].filter(Boolean).join(' ');

      // Rebuild attributes without style, with merged class
      let cleanAttrs = attrs
        .replace(/class="[^"]*"/, '')
        .replace(/style="[^"]*"/, '')
        .trim();

      if (allClasses) {
        cleanAttrs = `class="${allClasses}"${cleanAttrs ? ' ' + cleanAttrs : ''}`;
      }

      return `<span${cleanAttrs ? ' ' + cleanAttrs : ''}>`;
    },
  );

  return html;
}
