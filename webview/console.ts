// Webview client (Monaco build). Runs in the sandboxed webview — no Node, no
// credentials. Talks to the extension host purely over postMessage.
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import "monaco-editor/esm/vs/basic-languages/sql/sql.contribution";
// `editor.api` gives us the editor core and the `monaco.languages.register*`
// API surface, but NOT the editor feature contributions. Completion providers
// are only ever queried when the suggest controller contribution is bundled;
// hover providers need the hover contribution. Import them explicitly so our
// registered providers actually fire (without pulling in all of editor.main).
import "monaco-editor/esm/vs/editor/contrib/suggest/browser/suggestController.js";
import "monaco-editor/esm/vs/editor/contrib/hover/browser/hoverContribution.js";

// The host sets window.MONACO_WORKER_URI (webview URI of the bundled editor
// worker) via a nonce'd inline script before this bundle loads. We spin the
// worker up from that URL. Only the generic editor worker is needed for a
// plain language like SQL.
const workerUri = self.MONACO_WORKER_URI;
self.MonacoEnvironment = {
  getWorker() {
    return new Worker(workerUri);
  },
};

interface TableMeta {
  name: string;
  isView: boolean;
}

interface ColumnMeta {
  name: string;
  type: string;
  nullable: boolean;
  key: string;
}

type InboundMessage =
  | { type: "running" }
  | { type: "done" }
  | { type: "failed" }
  | {
      type: "schema";
      schemas: { name: string; tables: TableMeta[] }[];
      defaultSchema?: string;
    }
  | {
      type: "columns";
      schema: string;
      table: string;
      columns: ColumnMeta[];
    };

/**
 * In-memory schema model powering autocomplete. Table names arrive up front;
 * columns are fetched lazily (per table) and cached here. `columns` is keyed
 * by "schema\u0000table" to avoid ambiguity when a table name repeats across
 * schemas.
 */
class SchemaStore {
  /** schema -> table metadata. */
  readonly tables = new Map<string, TableMeta[]>();
  /** "schema\u0000table" -> columns (undefined = not yet fetched). */
  private readonly columns = new Map<string, ColumnMeta[]>();
  /** Pending column requests, to avoid asking the host twice. */
  private readonly requested = new Set<string>();
  /** The connection's default/bound schema, whose tables are offered bare. */
  defaultSchema: string | undefined;

  private key(schema: string, table: string): string {
    return `${schema}\u0000${table}`;
  }

  setSchemas(
    schemas: { name: string; tables: TableMeta[] }[],
    defaultSchema?: string,
  ): void {
    this.tables.clear();
    this.columns.clear();
    this.requested.clear();
    for (const s of schemas) {
      this.tables.set(s.name, s.tables);
    }
    this.defaultSchema = defaultSchema;
  }

  setColumns(schema: string, table: string, columns: ColumnMeta[]): void {
    this.columns.set(this.key(schema, table), columns);
  }

  /** All schema names known. */
  schemaNames(): string[] {
    return [...this.tables.keys()];
  }

  /** Tables in a schema (empty if unknown). */
  tablesIn(schema: string): TableMeta[] {
    return this.tables.get(schema) ?? [];
  }

  /**
   * Resolve a bare table name to its schema. Prefers the default schema, then
   * the first schema that contains a table of that name (case-insensitive).
   */
  schemaOf(table: string): string | undefined {
    const lower = table.toLowerCase();
    if (this.defaultSchema) {
      const inDefault = this.tablesIn(this.defaultSchema).some(
        (t) => t.name.toLowerCase() === lower,
      );
      if (inDefault) {
        return this.defaultSchema;
      }
    }
    for (const [schema, tables] of this.tables) {
      if (tables.some((t) => t.name.toLowerCase() === lower)) {
        return schema;
      }
    }
    return undefined;
  }

  /** True if `name` is a known schema (case-insensitive). */
  isSchema(name: string): boolean {
    const lower = name.toLowerCase();
    return this.schemaNames().some((s) => s.toLowerCase() === lower);
  }

  /**
   * Columns for schema.table if already cached. When not cached, calls
   * `request` (once per table) so the host can fetch them, and returns
   * undefined for now.
   */
  columnsFor(
    schema: string,
    table: string,
    request: (schema: string, table: string) => void,
  ): ColumnMeta[] | undefined {
    const key = this.key(schema, table);
    const cached = this.columns.get(key);
    if (cached) {
      return cached;
    }
    if (!this.requested.has(key)) {
      this.requested.add(key);
      request(schema, table);
    }
    return undefined;
  }
}

const store = new SchemaStore();

interface ConsoleState {
  sql: string;
}

const vscodeApi = acquireVsCodeApi();

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`Missing element #${id}`);
  }
  return el;
}

const statusEl = byId("status");
const editorEl = byId("editor");

/**
 * Read a --vscode-* CSS variable off the webview <body>, which VS Code keeps
 * in sync with the active colour theme. Returns undefined when unset.
 */
function cssVar(name: string): string | undefined {
  const value = getComputedStyle(document.body).getPropertyValue(name).trim();
  return value || undefined;
}

/** Normalise to bare 6/8-digit hex with a leading '#'; else the fallback. */
function hex(
  value: string | undefined,
  fallback: string | undefined,
): string | undefined {
  if (!value) {
    return fallback;
  }
  const v = value.startsWith("#") ? value.slice(1) : value;
  return /^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(v) ? "#" + v : fallback;
}

/**
 * Build a Monaco theme with hand-tuned SQL token colours. We keep two
 * palettes — one for dark themes, one for light — and pick by the active
 * theme's base. The editor background/foreground still come from the live
 * theme so the console sits inside whatever colour theme is installed; only
 * the SQL syntax colours are our own generic set.
 */
function applyTheme(): void {
  const isDark = document.body.classList.contains("vscode-dark");
  const isHc = document.body.classList.contains("vscode-high-contrast");
  const base = isHc ? "hc-black" : isDark ? "vs-dark" : "vs";
  const dark = isHc || isDark;

  const fg = hex(
    cssVar("--vscode-editor-foreground"),
    dark ? "#d4d4d4" : "#000000",
  ) as string;
  const bg = hex(
    cssVar("--vscode-editor-background"),
    dark ? "#1e1e1e" : "#ffffff",
  ) as string;

  // Generic SQL palettes. Foregrounds are bare hex (no leading '#') as
  // Monaco's rule format requires.
  const palette = dark
    ? {
        keyword: "569cd6", // blue
        string: "ce9178", // orange-brown
        number: "b5cea8", // green
        comment: "6a9955", // green, italic
        operator: "d4d4d4", // near-fg
        identifier: "9cdcfe", // light blue
      }
    : {
        keyword: "0000ff",
        string: "a31515",
        number: "098658",
        comment: "008000",
        operator: "000000",
        identifier: "001080",
      };

  const rules: monaco.editor.ITokenThemeRule[] = [
    { token: "keyword.sql", foreground: palette.keyword },
    { token: "operator.sql", foreground: palette.operator },
    { token: "string.sql", foreground: palette.string },
    { token: "number.sql", foreground: palette.number },
    { token: "comment.sql", foreground: palette.comment, fontStyle: "italic" },
    { token: "identifier.sql", foreground: palette.identifier },
    { token: "predefined.sql", foreground: palette.keyword },
  ];

  monaco.editor.defineTheme("burrowDbClient", {
    base,
    inherit: true,
    rules,
    colors: {
      "editor.foreground": fg,
      "editor.background": bg,
    },
  });
  monaco.editor.setTheme("burrowDbClient");
}

const prev = vscodeApi.getState() as ConsoleState | undefined;
const editor = monaco.editor.create(editorEl, {
  value: prev && typeof prev.sql === "string" ? prev.sql : "",
  language: "sql",
  automaticLayout: true,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  fontSize: Number.parseInt(cssVar("--vscode-editor-font-size") ?? "13", 10),
  fontFamily: cssVar("--vscode-editor-font-family") ?? "monospace",
  lineNumbers: "on",
  renderLineHighlight: "line",
  tabSize: 2,
});

applyTheme();

// The theme class on <body> flips when the user changes colour theme.
new MutationObserver(applyTheme).observe(document.body, {
  attributes: true,
  attributeFilter: ["class"],
});

function run(): void {
  // Run the selection if there is one, else the whole buffer — mirrors the
  // "Run Active SQL File / Selection" command.
  const model = editor.getModel();
  const selection = editor.getSelection();
  let sql = editor.getValue();
  if (model && selection && !selection.isEmpty()) {
    sql = model.getValueInRange(selection);
  }
  vscodeApi.setState({ sql: editor.getValue() } satisfies ConsoleState);
  vscodeApi.postMessage({ type: "run", sql });
}

editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, run);

// ---------------------------------------------------------------------------
// Autocomplete / hover
// ---------------------------------------------------------------------------

/** Ask the host for a table's columns (lazy fetch). */
function requestColumns(schema: string, table: string): void {
  vscodeApi.postMessage({ type: "needColumns", schema, table });
}

/**
 * Look back from the cursor for a "qualifier." prefix, i.e. the user typed
 * `foo.` and is now completing after the dot. Returns the qualifier text
 * (an alias, table, or schema name) or undefined.
 */
function dotQualifier(textBeforeCursor: string): string | undefined {
  const m = /([A-Za-z_][A-Za-z0-9_$]*)\.\s*[A-Za-z0-9_$]*$/.exec(
    textBeforeCursor,
  );
  return m ? m[1] : undefined;
}

/** True when the cursor is right after a FROM / JOIN / INTO / UPDATE clause. */
function expectsTable(textBeforeCursor: string): boolean {
  // Allow an optional "schema." prefix on the partially-typed table.
  return /\b(from|join|into|update)\s+(?:[A-Za-z0-9_$]+\.)?[A-Za-z0-9_$]*$/i.test(
    textBeforeCursor,
  );
}

/** A referenced table, optionally schema-qualified. */
interface TableRef {
  schema?: string;
  table: string;
}

/** Keywords that must never be mistaken for a table alias. */
const NON_ALIAS_KEYWORDS = new Set([
  "where",
  "join",
  "inner",
  "left",
  "right",
  "outer",
  "cross",
  "on",
  "using",
  "group",
  "order",
  "limit",
  "having",
  "set",
  "values",
  "select",
  "as",
]);

/**
 * Parse `FROM [schema.]table [AS] alias, …` and JOIN/INTO/UPDATE clauses across
 * the whole buffer, mapping every alias AND every table name (lower-cased) to a
 * {schema?, table} reference. Used to resolve `x.` column completions and
 * hovers. Best-effort and deliberately lenient; it also handles the
 * comma-separated table list after a single FROM.
 */
function aliasMap(fullText: string): Map<string, TableRef> {
  const map = new Map<string, TableRef>();

  // One table reference: optional schema, table, optional [AS] alias.
  const tableRef =
    "(?:([A-Za-z_][A-Za-z0-9_$]*)\\.)?([A-Za-z_][A-Za-z0-9_$]*)" +
    "(?:\\s+(?:as\\s+)?([A-Za-z_][A-Za-z0-9_$]*))?";

  const record = (schema: string | undefined, table: string, alias?: string) => {
    const ref: TableRef = { schema, table };
    if (alias && !NON_ALIAS_KEYWORDS.has(alias.toLowerCase())) {
      map.set(alias.toLowerCase(), ref);
    }
    map.set(table.toLowerCase(), ref);
  };

  // JOIN / INTO / UPDATE take a single table reference.
  const single = new RegExp(`\\b(?:join|into|update)\\s+${tableRef}`, "gi");
  let m: RegExpExecArray | null;
  while ((m = single.exec(fullText)) !== null) {
    record(m[1], m[2], m[3]);
  }

  // FROM can take a comma-separated list: FROM a x, b y, c
  const fromClause = /\bfrom\s+([\s\S]*?)(?:\bwhere\b|\bgroup\b|\border\b|\bhaving\b|\blimit\b|\bjoin\b|;|$)/gi;
  const item = new RegExp(`^\\s*${tableRef}\\s*$`, "i");
  while ((m = fromClause.exec(fullText)) !== null) {
    for (const part of m[1].split(",")) {
      const im = item.exec(part);
      if (im) {
        record(im[1], im[2], im[3]);
      }
    }
  }

  return map;
}

/**
 * Resolve a qualifier (alias, bare table, or schema-qualified reference) to a
 * concrete {schema, table}. Consults the buffer's alias map first (so aliases
 * and schema-qualified references resolve), then falls back to schemaOf().
 */
function resolveQualifier(
  qualifier: string,
  fullText: string,
): { schema: string; table: string } | undefined {
  const ref = aliasMap(fullText).get(qualifier.toLowerCase());
  if (ref) {
    const schema = ref.schema ?? store.schemaOf(ref.table);
    if (schema) {
      return { schema, table: ref.table };
    }
  }
  const schema = store.schemaOf(qualifier);
  return schema ? { schema, table: qualifier } : undefined;
}

/**
 * When the cursor sits inside an INSERT column list — `INSERT INTO t (col…` —
 * return the target table so we can offer its columns. Returns undefined when
 * not in that context.
 */
function insertColumnListTable(
  textBeforeCursor: string,
): { schema: string; table: string } | undefined {
  // Match "insert into [schema.]table (" with the paren still open (no ")"
  // between it and the cursor).
  const m =
    /\binsert\s+into\s+(?:([A-Za-z_][A-Za-z0-9_$]*)\.)?([A-Za-z_][A-Za-z0-9_$]*)\s*\(([^)]*)$/i.exec(
      textBeforeCursor,
    );
  if (!m) {
    return undefined;
  }
  const schema = m[1] ?? store.schemaOf(m[2]);
  return schema ? { schema, table: m[2] } : undefined;
}

const KIND = monaco.languages.CompletionItemKind;

monaco.languages.registerCompletionItemProvider("sql", {
  triggerCharacters: [".", " "],
  provideCompletionItems(model, position) {
    const word = model.getWordUntilPosition(position);
    const range: monaco.IRange = {
      startLineNumber: position.lineNumber,
      endLineNumber: position.lineNumber,
      startColumn: word.startColumn,
      endColumn: word.endColumn,
    };
    const textBeforeCursor = model.getValueInRange({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: position.lineNumber,
      endColumn: position.column,
    });
    const fullText = model.getValue();
    const suggestions: monaco.languages.CompletionItem[] = [];

    // INSERT INTO t (col…) — offer that table's columns and nothing else.
    const insertTarget = insertColumnListTable(textBeforeCursor);
    if (insertTarget) {
      const cols = store.columnsFor(
        insertTarget.schema,
        insertTarget.table,
        requestColumns,
      );
      if (cols) {
        for (const c of cols) {
          suggestions.push({
            label: c.name,
            kind: KIND.Field,
            insertText: c.name,
            detail: columnDetail(c),
            range,
          });
        }
      }
      return { suggestions };
    }

    const qualifier = dotQualifier(textBeforeCursor);
    if (qualifier) {
      // `schema.` -> that schema's tables.
      if (store.isSchema(qualifier)) {
        const schema = store
          .schemaNames()
          .find((s) => s.toLowerCase() === qualifier.toLowerCase());
        for (const t of store.tablesIn(schema as string)) {
          suggestions.push({
            label: t.name,
            kind: t.isView ? KIND.Interface : KIND.Struct,
            insertText: t.name,
            detail: `${schema} · ${t.isView ? "view" : "table"}`,
            range,
          });
        }
        return { suggestions };
      }
      // `table.` / `alias.` -> that table's columns (lazy).
      const resolved = resolveQualifier(qualifier, fullText);
      if (resolved) {
        const cols = store.columnsFor(
          resolved.schema,
          resolved.table,
          requestColumns,
        );
        if (cols) {
          for (const c of cols) {
            suggestions.push({
              label: c.name,
              kind: KIND.Field,
              insertText: c.name,
              detail: columnDetail(c),
              range,
            });
          }
        }
      }
      return { suggestions };
    }

    // Unqualified. After FROM/JOIN prefer tables; otherwise offer schemas +
    // tables + all columns of tables already referenced in the statement.
    for (const schema of store.schemaNames()) {
      suggestions.push({
        label: schema,
        kind: KIND.Module,
        insertText: schema,
        detail: "schema",
        range,
      });
    }
    // Default-schema tables are offered bare; other schemas' tables are shown
    // with their schema in the detail so it's clear where they live.
    for (const schema of store.schemaNames()) {
      const bare = schema === store.defaultSchema;
      for (const t of store.tablesIn(schema)) {
        suggestions.push({
          label: t.name,
          kind: t.isView ? KIND.Interface : KIND.Struct,
          insertText: bare ? t.name : `${schema}.${t.name}`,
          detail: `${schema} · ${t.isView ? "view" : "table"}`,
          range,
        });
      }
    }

    if (!expectsTable(textBeforeCursor)) {
      // Offer columns of tables referenced in the current buffer. Dedupe by
      // resolved schema.table so the same table referenced via alias and name
      // isn't listed twice.
      const seen = new Set<string>();
      for (const ref of aliasMap(fullText).values()) {
        const schema = ref.schema ?? store.schemaOf(ref.table);
        if (!schema) {
          continue;
        }
        const key = `${schema}\u0000${ref.table}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        const cols = store.columnsFor(schema, ref.table, requestColumns);
        if (!cols) {
          continue;
        }
        for (const c of cols) {
          suggestions.push({
            label: c.name,
            kind: KIND.Field,
            insertText: c.name,
            detail: `${ref.table} · ${columnDetail(c)}`,
            range,
          });
        }
      }
    }

    return { suggestions };
  },
});

function columnDetail(c: ColumnMeta): string {
  return [c.type, c.nullable ? "NULL" : "NOT NULL", c.key]
    .filter(Boolean)
    .join(" · ");
}

monaco.languages.registerHoverProvider("sql", {
  provideHover(model, position) {
    const wordInfo = model.getWordAtPosition(position);
    if (!wordInfo) {
      return null;
    }
    const word = wordInfo.word;
    const fullText = model.getValue();

    // Is it a known table (or alias)?
    const aliases = aliasMap(fullText);
    const ref = aliases.get(word.toLowerCase());
    const tableName = ref?.table ?? word;
    const schema = ref?.schema ?? store.schemaOf(tableName);
    if (schema && store.tablesIn(schema).some((t) => t.name === tableName)) {
      const cols = store.columnsFor(schema, tableName, requestColumns);
      const header = `**${schema}.${tableName}**`;
      const body = cols
        ? cols.map((c) => `- \`${c.name}\` ${columnDetail(c)}`).join("\n")
        : "_loading columns…_";
      return {
        contents: [{ value: header }, { value: body }],
      };
    }

    // Is it a column of some referenced table?
    const seen = new Set<string>();
    for (const tref of aliases.values()) {
      const tSchema = tref.schema ?? store.schemaOf(tref.table);
      if (!tSchema) {
        continue;
      }
      const key = `${tSchema}\u0000${tref.table}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const cols = store.columnsFor(tSchema, tref.table, requestColumns);
      const col = cols?.find((c) => c.name.toLowerCase() === word.toLowerCase());
      if (col) {
        return {
          contents: [
            { value: `**${tref.table}.${col.name}**` },
            { value: columnDetail(col) },
          ],
        };
      }
    }
    return null;
  },
});

/** Manually re-pull schema metadata from the host. */
function refreshSchema(): void {
  vscodeApi.postMessage({ type: "refreshSchema" });
  statusEl.textContent = "Refreshing schema…";
}

editor.addAction({
  id: "burrow.refreshSchema",
  label: "Burrow: Refresh Schema for Autocomplete",
  run: refreshSchema,
});

window.addEventListener("message", (event: MessageEvent<InboundMessage>) => {
  const msg = event.data;
  if (msg.type === "running") {
    statusEl.textContent = "Running…";
    return;
  }
  if (msg.type === "failed") {
    statusEl.textContent = "Error — see SQL Results panel";
    return;
  }
  if (msg.type === "done") {
    statusEl.textContent = "Ready";
    return;
  }
  if (msg.type === "schema") {
    store.setSchemas(msg.schemas, msg.defaultSchema);
    return;
  }
  if (msg.type === "columns") {
    store.setColumns(msg.schema, msg.table, msg.columns);
    // Columns often arrive just after the user typed `alias.`, by which point
    // the suggest widget has already shown an empty/partial list. Re-trigger
    // it so the freshly-arrived columns appear without another keystroke.
    if (editor.hasTextFocus()) {
      editor.trigger("burrow", "editor.action.triggerSuggest", {});
    }
    return;
  }
});

// Tell the host we're mounted and listening, so it can send schema metadata
// without racing our message listener above.
vscodeApi.postMessage({ type: "ready" });
