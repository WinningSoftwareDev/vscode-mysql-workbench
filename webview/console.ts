// Webview client (Monaco build). Runs in the sandboxed webview — no Node, no
// credentials. Talks to the extension host purely over postMessage.
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import "monaco-editor/esm/vs/basic-languages/sql/sql.contribution";

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

interface QueryResult {
  fields: string[];
  rows: Record<string, unknown>[];
  affectedRows?: number;
}

type InboundMessage =
  | { type: "running"; sql: string }
  | { type: "result"; result: QueryResult; sql: string; ms: number }
  | { type: "error"; message: string; sql: string };

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

const gridEl = byId("grid");
const metaEl = byId("meta");
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

  monaco.editor.defineTheme("mysqlWorkbench", {
    base,
    inherit: true,
    rules,
    colors: {
      "editor.foreground": fg,
      "editor.background": bg,
    },
  });
  monaco.editor.setTheme("mysqlWorkbench");
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
  const sql = editor.getValue();
  vscodeApi.setState({ sql } satisfies ConsoleState);
  vscodeApi.postMessage({ type: "run", sql });
}

editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, run);

function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderCell(value: unknown): string {
  if (value === null || value === undefined) {
    return '<span class="null">NULL</span>';
  }
  if (typeof value === "object") {
    return escapeHtml(JSON.stringify(value));
  }
  return escapeHtml(value);
}

function renderGrid(result: QueryResult): void {
  if (!result.fields.length) {
    gridEl.innerHTML = "";
    return;
  }
  const head =
    "<thead><tr>" +
    result.fields.map((f) => "<th>" + escapeHtml(f) + "</th>").join("") +
    "</tr></thead>";
  const body =
    "<tbody>" +
    result.rows
      .map(
        (row) =>
          "<tr>" +
          result.fields
            .map((f) => "<td>" + renderCell(row[f]) + "</td>")
            .join("") +
          "</tr>",
      )
      .join("") +
    "</tbody>";
  gridEl.innerHTML = "<table>" + head + body + "</table>";
}

window.addEventListener("message", (event: MessageEvent<InboundMessage>) => {
  const msg = event.data;
  if (msg.type === "running") {
    statusEl.textContent = "Running…";
    metaEl.textContent = "";
    gridEl.innerHTML = "";
    return;
  }
  if (msg.type === "error") {
    statusEl.textContent = "Error";
    metaEl.innerHTML =
      '<span class="error">' + escapeHtml(msg.message) + "</span>";
    gridEl.innerHTML = "";
    return;
  }
  if (msg.type === "result") {
    statusEl.textContent = "Ready";
    if (typeof msg.result.affectedRows === "number") {
      metaEl.textContent =
        msg.result.affectedRows + " row(s) affected · " + msg.ms + " ms";
      gridEl.innerHTML = "";
    } else {
      metaEl.textContent =
        msg.result.rows.length + " row(s) · " + msg.ms + " ms";
      renderGrid(msg.result);
    }
  }
});
