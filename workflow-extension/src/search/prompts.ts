// search/prompts.ts — Search agent prompt templates
// Lightweight read-only prompts for parallel codebase exploration.

export type SearchScope =
  | 'codebase'
  | 'docs'
  | 'both'
  | 'solutions'
  | 'web'
  | 'all';

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

    case 'solutions':
      return `Search past workflow solutions, learnings, and project memory. Focus on:
- Solution documents in docs/solutions/ (organized by category: build-errors, runtime-errors, logic-errors, etc.)
- Project memory at .pi/memory.json (conventions, rules, patterns, gotchas, decisions)
- Critical patterns at .pi/critical-patterns/
- Workflow session files in .pi/workflows/
Look for: previous mistakes, proven patterns, root causes, prevention strategies.
Use grep to search across all .md files in docs/solutions/ and read .pi/memory.json for structured learnings.`;

    case 'web':
      return `Search for external knowledge, best practices, and general patterns.
You have access to installed skills (e.g., web search) in addition to read-only file tools.
Focus on:
- Industry best practices for the topic
- Common patterns and anti-patterns
- Library/framework documentation and recommendations
- Community knowledge and proven solutions
- Official documentation references
If web search skills are available, USE THEM for up-to-date information.
Otherwise, leverage your training knowledge to provide best-practice guidance.`;

    case 'all':
      return `Comprehensive search across ALL sources: codebase, documentation, past solutions, AND external knowledge.
This is broader than 'both' (which covers only codebase+docs). 'all' includes everything:
1. Source code files for implementations and patterns
2. Documentation for context and design decisions
3. docs/solutions/ for past workflow learnings and root causes
4. .pi/memory.json for project conventions, patterns, gotchas
5. .pi/critical-patterns/ for recurring issues
6. External sources — use web search skills if available for best practices
Be thorough — this is a compound search meant to gather comprehensive context from every available source.`;
  }
}
