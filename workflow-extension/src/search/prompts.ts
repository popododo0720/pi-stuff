// search/prompts.ts — Search agent prompt templates
// Lightweight read-only prompts for parallel codebase exploration.

export type SearchScope = 'codebase' | 'docs' | 'both';

/**
 * Build a search prompt for a single query.
 * The search agent runs as a subprocess with read-only tools.
 */
export function buildSearchPrompt(
  query: string,
  scope: SearchScope,
  cwd: string,
): string {
  const scopeInstructions = getScopeInstructions(scope);

  return `You are a fast, focused search agent. Your ONLY job is to answer the query below by searching the codebase.

## Rules
- READ-ONLY: You may only read files, grep, find, and list directories. Never modify anything.
- Be CONCISE: Return only relevant findings. No preamble, no "I'll help you".
- Include FULL FILE PATHS for every finding.
- If you find nothing relevant, say "No results found" and stop.

## Scope
${scopeInstructions}

## Working Directory
${cwd}

## Query
${query}

## Output Format
Return your findings in this exact format:

<search_results>
<finding>
<file>/absolute/path/to/file.ts</file>
<lines>L10-L25</lines>
<summary>Brief description of what was found</summary>
<snippet>
relevant code or text excerpt (keep under 20 lines)
</snippet>
</finding>
<!-- repeat for each finding, max 10 findings -->
</search_results>

If the query asks for a high-level answer (not just file locations), add:
<answer>
Your concise answer based on the findings above.
</answer>

Start searching now.`;
}

function getScopeInstructions(scope: SearchScope): string {
  switch (scope) {
    case 'codebase':
      return `Search source code files. Use grep for pattern matching, find for file discovery, and read for examining file contents. Focus on:
- Source files (*.ts, *.js, *.py, etc.)
- Configuration files
- Type definitions and interfaces
- Function/class implementations`;

    case 'docs':
      return `Search documentation and reference files. Focus on:
- README.md, ARCHITECTURE.md, CONTRIBUTING.md
- Doc directories (docs/, doc/)
- Code comments and JSDoc/TSDoc
- Type definitions (for API understanding)
- Package.json descriptions`;

    case 'both':
      return `Search both source code and documentation. Cast a wide net:
- Source files for implementations
- Documentation for context and design decisions
- Type definitions for API surface
- Configuration for project setup`;
  }
}
