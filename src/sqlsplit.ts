/**
 * Split a SQL script into individual statements on top-level `;`, ignoring
 * semicolons inside string literals ('...', "..."), quoted identifiers
 * (`...`), and comments (-- line, # line, and block comments). Returns the
 * trimmed, non-empty statements in order.
 *
 * This is intentionally a lexical splitter, not a full SQL parser — it handles
 * the cases that actually cause mis-splits (a `;` inside a string or comment)
 * without trying to understand the grammar. `DELIMITER` is not supported
 * (rare in ad-hoc consoles); stored-program bodies with internal `;` would
 * need it and are out of scope for now.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i];
    const next = i + 1 < n ? sql[i + 1] : "";

    // Line comment: -- (followed by space/EOL) or #
    if (
      (ch === "-" && next === "-" && (i + 2 >= n || /\s/.test(sql[i + 2]))) ||
      ch === "#"
    ) {
      const eol = sql.indexOf("\n", i);
      const end = eol === -1 ? n : eol;
      current += sql.slice(i, end);
      i = end;
      continue;
    }

    // Block comment: /* ... */
    if (ch === "/" && next === "*") {
      const close = sql.indexOf("*/", i + 2);
      const end = close === -1 ? n : close + 2;
      current += sql.slice(i, end);
      i = end;
      continue;
    }

    // Quoted spans: '...', "...", `...`
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      current += ch;
      i++;
      while (i < n) {
        const c = sql[i];
        // Backslash escape (MySQL allows \' inside '...' / "...").
        if (c === "\\" && quote !== "`" && i + 1 < n) {
          current += c + sql[i + 1];
          i += 2;
          continue;
        }
        // Doubled quote escape ('' or "" or ``).
        if (c === quote && sql[i + 1] === quote) {
          current += c + c;
          i += 2;
          continue;
        }
        current += c;
        i++;
        if (c === quote) {
          break;
        }
      }
      continue;
    }

    // Statement terminator at top level.
    if (ch === ";") {
      const trimmed = current.trim();
      if (trimmed !== "") {
        statements.push(trimmed);
      }
      current = "";
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  const tail = current.trim();
  if (tail !== "") {
    statements.push(tail);
  }
  return statements;
}
