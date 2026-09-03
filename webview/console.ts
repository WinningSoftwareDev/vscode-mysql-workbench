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

type InboundMessage =
  { type: "running" } | { type: "done" } | { type: "failed" };

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
});
