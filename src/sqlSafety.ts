// Allowlist, not a blocklist: a statement is only "safe" if it's clearly
// read-only. Anything else (INSERT, UPDATE, DELETE, DROP, ALTER, CREATE,
// TRUNCATE, REPLACE, ATTACH, DETACH, COPY, PRAGMA, VACUUM, INSTALL, LOAD,
// USE, SET, ...) is treated as destructive. Errs toward over-blocking.
const SAFE_LEADING_KEYWORDS = ['select', 'with', 'explain', 'describe', 'show', 'summarize', 'call'];

export function isDestructiveStatement(sql: string): boolean {
  const stripped = sql
    .replace(/--[^\n]*/g, '') // line comments
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
    .trim();

  if (!stripped) return false;

  const firstWordMatch = stripped.match(/^[a-zA-Z]+/);
  const firstWord = firstWordMatch ? firstWordMatch[0].toLowerCase() : '';

  return !SAFE_LEADING_KEYWORDS.includes(firstWord);
}
