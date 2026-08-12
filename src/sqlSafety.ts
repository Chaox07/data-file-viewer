// Allowlist, not a blocklist: a statement is only "safe" if it's clearly
// read-only. Anything else (INSERT, UPDATE, DELETE, DROP, ALTER, CREATE,
// TRUNCATE, REPLACE, ATTACH, DETACH, COPY, PRAGMA, VACUUM, INSTALL, LOAD,
// USE, SET, ...) is treated as destructive. Errs toward over-blocking.
const SAFE_LEADING_KEYWORDS = ['select', 'with', 'explain', 'describe', 'show', 'summarize', 'call'];

// Checking only the leading keyword isn't enough on its own. Two ways a write
// hides behind a safe-looking first word:
//   select 1; drop table bars_1h        -- second statement
//   with x as (...) delete from t ...   -- DuckDB allows DML after a CTE
// So the leading-keyword check below is backed by a scan of the whole input.
const WRITE_KEYWORDS = [
  'insert',
  'update',
  'delete',
  'drop',
  'alter',
  'create',
  'truncate',
  'replace',
  'attach',
  'detach',
  'copy',
  'pragma',
  'vacuum',
  'install',
  'load',
  'export',
  'import',
  'checkpoint',
];

// Word boundaries matter: a column named create_date or update_time must not
// trip this, and doesn't, because _ is a word character.
const WRITE_KEYWORD_RE = new RegExp(`\\b(${WRITE_KEYWORDS.join('|')})\\b`, 'i');

/**
 * Removes comments, string literals and quoted identifiers in one
 * left-to-right pass, so what's left is only SQL structure.
 *
 * This has to be a scanner rather than a couple of regexes: the two are
 * mutually nesting. A comment can contain a quote (`-- it's fine`) and a
 * string can contain comment or statement punctuation (`where note = 'a;b'`).
 * Regexes applied in either order get one of those wrong, and the cost isn't
 * theoretical here -- without this, the ';' and keyword scans below would
 * block ordinary queries over text columns.
 *
 * Quoted identifiers go too, so a column that is legitimately named "update"
 * can't look like a write statement.
 */
function stripCommentsAndLiterals(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (ch === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      out += ' ';
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i++;
      while (i < sql.length) {
        if (sql[i] === quote) {
          // Doubled quote is an escaped quote, not the end of the literal.
          if (sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      out += ' ';
      continue;
    }

    out += ch;
    i++;
  }
  return out;
}

/**
 * Returns a short human-readable reason the statement isn't safe to run in
 * Safe Mode, or null if it is. The reason exists so the block message can
 * name what actually tripped: reporting the first word is actively wrong for
 * `select 1; drop table x`, where the first word is the innocent half.
 */
export function destructiveReason(sql: string): string | null {
  const stripped = stripCommentsAndLiterals(sql).trim();

  if (!stripped) return null;

  // Anything after a ';' is a second statement. A single trailing ';' is fine.
  if (/;\s*\S/.test(stripped)) {
    return 'it contains more than one statement';
  }

  const firstWordMatch = stripped.match(/^[a-zA-Z]+/);
  const firstWord = firstWordMatch ? firstWordMatch[0].toLowerCase() : '';
  if (!SAFE_LEADING_KEYWORDS.includes(firstWord)) {
    return `it starts with "${firstWord || stripped.slice(0, 12)}"`;
  }

  const writeMatch = stripped.match(WRITE_KEYWORD_RE);
  if (writeMatch) {
    return `it contains "${writeMatch[1].toLowerCase()}"`;
  }

  return null;
}

/** True if the input runs more than one statement -- see destructiveReason. */
export function hasMultipleStatements(sql: string): boolean {
  return /;\s*\S/.test(stripCommentsAndLiterals(sql));
}
