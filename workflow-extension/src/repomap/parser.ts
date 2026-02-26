// repomap/parser.ts — AST-based symbol extraction using web-tree-sitter
// Parses source files and extracts top-level symbols + import specifiers.

import { readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';

// ── Types ────────────────────────────────────────────────────────

export interface RepoSymbol {
  name: string;
  kind: 'function' | 'class' | 'interface' | 'type' | 'variable' | 'method';
  line: number;
}

export interface ParsedFile {
  /** Project-relative POSIX path */
  path: string;
  symbols: RepoSymbol[];
  /** Raw import specifiers (e.g. './foo', 'lodash') */
  imports: string[];
}

// ── Constants ────────────────────────────────────────────────────

const MAX_FILE_SIZE = 100 * 1024; // 100KB

/** Extension → tree-sitter language id */
const EXT_TO_LANG: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.c': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cs': 'c_sharp',
  '.rb': 'ruby',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.dart': 'dart',
  '.lua': 'lua',
  '.zig': 'zig',
  '.ex': 'elixir',
  '.exs': 'elixir',
  '.scala': 'scala',
  '.php': 'php',
  '.sh': 'bash',
  '.bash': 'bash',
};

// ── Lazy-loaded tree-sitter (avoid top-level require) ────────────

let PARSER: typeof import('web-tree-sitter').Parser | null = null;
let LANGUAGE: typeof import('web-tree-sitter').Language | null = null;
let initPromise: Promise<void> | null = null;

async function ensureInit(): Promise<boolean> {
  if (!initPromise) {
    initPromise = (async () => {
      try {
        const mod = require('web-tree-sitter');
        PARSER = mod.Parser;
        LANGUAGE = mod.Language;
        const wasmPath = require.resolve('web-tree-sitter/tree-sitter.wasm');
        await (PARSER as any).init({ locateFile: () => wasmPath });
      } catch (e) {
        PARSER = null;
        LANGUAGE = null;
        console.warn('[parser] web-tree-sitter init failed:', e);
        throw new Error('web-tree-sitter init failed');
      }
    })();
  }
  try {
    await initPromise;
    return PARSER !== null;
  } catch (e) {
    console.warn('[parser] ensureInit failed:', e);
    return false;
  }
}

const langCache = new Map<string, any>();

async function getLanguage(langId: string): Promise<any | null> {
  if (langCache.has(langId)) return langCache.get(langId)!;
  if (!LANGUAGE) return null;
  try {
    const wasmPath = join(
      dirname(require.resolve('tree-sitter-wasms/package.json')),
      'out',
      `tree-sitter-${langId}.wasm`,
    );
    const lang = await (LANGUAGE as any).load(wasmPath);
    langCache.set(langId, lang);
    return lang;
  } catch {
    return null;
  }
}

// ── Symbol extraction ────────────────────────────────────────────

/** Node types that represent top-level symbol declarations */
const SYMBOL_TYPES: Record<string, RepoSymbol['kind']> = {
  function_declaration: 'function',
  function_definition: 'function', // Python, C, etc.
  method_definition: 'method',
  method_declaration: 'method',
  class_declaration: 'class',
  class_definition: 'class',
  interface_declaration: 'interface',
  type_alias_declaration: 'type',
};

function extractNameFromNode(node: any): string | null {
  // Try common child field names
  for (const field of ['name', 'declarator']) {
    const child = node.childForFieldName?.(field);
    if (child) {
      // For declarator, might need to go deeper (e.g. variable_declarator → name)
      if (child.type === 'variable_declarator') {
        const nameNode = child.childForFieldName?.('name');
        return nameNode?.text ?? null;
      }
      return child.text ?? null;
    }
  }
  return null;
}

function extractSymbols(rootNode: any): RepoSymbol[] {
  const symbols: RepoSymbol[] = [];

  for (const child of rootNode.children) {
    const kind = SYMBOL_TYPES[child.type];
    if (kind) {
      const name = extractNameFromNode(child);
      if (name) {
        symbols.push({ name, kind, line: child.startPosition.row + 1 });
      }
      continue;
    }

    // export_statement → unwrap to inner declaration
    if (child.type === 'export_statement') {
      const decl = child.children?.find(
        (c: any) => SYMBOL_TYPES[c.type] || c.type === 'lexical_declaration',
      );
      if (decl) {
        const declKind = SYMBOL_TYPES[decl.type];
        if (declKind) {
          const name = extractNameFromNode(decl);
          if (name) {
            symbols.push({
              name,
              kind: declKind,
              line: decl.startPosition.row + 1,
            });
          }
        } else if (decl.type === 'lexical_declaration') {
          // const/let declarations with arrow functions or values
          for (const vd of decl.children) {
            if (vd.type === 'variable_declarator') {
              const nameNode = vd.childForFieldName?.('name');
              const value = vd.childForFieldName?.('value');
              if (nameNode) {
                const isFunc =
                  value?.type === 'arrow_function' ||
                  value?.type === 'function_expression' ||
                  value?.type === 'function';
                symbols.push({
                  name: nameNode.text,
                  kind: isFunc ? 'function' : 'variable',
                  line: vd.startPosition.row + 1,
                });
              }
            }
          }
        }
      }
      continue;
    }

    // Top-level lexical_declaration (const/let without export)
    if (child.type === 'lexical_declaration') {
      for (const vd of child.children) {
        if (vd.type === 'variable_declarator') {
          const nameNode = vd.childForFieldName?.('name');
          const value = vd.childForFieldName?.('value');
          if (nameNode) {
            const isFunc =
              value?.type === 'arrow_function' ||
              value?.type === 'function_expression' ||
              value?.type === 'function';
            symbols.push({
              name: nameNode.text,
              kind: isFunc ? 'function' : 'variable',
              line: vd.startPosition.row + 1,
            });
          }
        }
      }
    }
  }

  return symbols;
}

// ── Import extraction ────────────────────────────────────────────

function extractImports(rootNode: any): string[] {
  const imports: string[] = [];
  for (const child of rootNode.children) {
    if (
      child.type === 'import_statement' ||
      child.type === 'import_declaration'
    ) {
      // Find the source string node
      const source = child.childForFieldName?.('source');
      if (source) {
        // Remove quotes
        const raw = source.text?.replace(/^['"]|['"]$/g, '');
        if (raw) imports.push(raw);
      }
    }
  }
  return imports;
}

// ── Main API ─────────────────────────────────────────────────────

/**
 * Parse a single file and extract symbols + imports.
 * Returns null if parsing fails or file is unsupported.
 */
export async function parseFile(
  filePath: string,
  cwd: string,
): Promise<ParsedFile | null> {
  try {
    const ext = extname(filePath).toLowerCase();
    const langId = EXT_TO_LANG[ext];
    if (!langId) return null;

    // Check file size
    const stat = statSync(filePath);
    if (stat.size > MAX_FILE_SIZE) return null;

    // Ensure tree-sitter is initialized
    const ok = await ensureInit();
    if (!ok || !PARSER) return null;

    // Load language grammar
    const lang = await getLanguage(langId);
    if (!lang) return null;

    // Parse
    const parser = new (PARSER as any)();
    parser.setLanguage(lang);
    const source = readFileSync(filePath, 'utf-8');
    const tree = parser.parse(source);

    const relPath = relative(cwd, filePath).split('\\').join('/');

    return {
      path: relPath,
      symbols: extractSymbols(tree.rootNode),
      imports: extractImports(tree.rootNode),
    };
  } catch {
    return null;
  }
}

/** Get the set of supported file extensions. */
export function getSupportedExtensions(): Set<string> {
  return new Set(Object.keys(EXT_TO_LANG));
}
