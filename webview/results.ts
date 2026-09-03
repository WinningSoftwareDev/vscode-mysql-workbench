// Results panel webview (Tabulator build). Sandboxed — receives query results
// from the host over postMessage, renders a sortable/resizable grid, and can
// export the current view (respecting sort order) as CSV/JSON with a preview,
// copy-to-clipboard, and optional save-to-file (routed through the host).
import { TabulatorFull as Tabulator } from "tabulator-tables";
import type { ColumnDefinition } from "tabulator-tables";
import "tabulator-tables/dist/css/tabulator.min.css";

interface QueryResult {
  fields: string[];
  rows: Record<string, unknown>[];
  affectedRows?: number;
}

type InboundMessage =
  | { type: "reset" }
  | { type: "running"; label: string }
  | { type: "result"; result: QueryResult; label: string; ms: number }
  | { type: "error"; message: string; label: string };

const vscodeApi = acquireVsCodeApi();

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`Missing element #${id}`);
  }
  return el;
}

const metaEl = byId("meta");
const gridEl = byId("grid");
const exportCsvBtn = byId("export-csv") as HTMLButtonElement;
const exportJsonBtn = byId("export-json") as HTMLButtonElement;
const previewEl = byId("preview");
const previewTextEl = byId("preview-text") as HTMLTextAreaElement;
const copyBtn = byId("copy-btn") as HTMLButtonElement;
const saveBtn = byId("save-btn") as HTMLButtonElement;
const closePreviewBtn = byId("close-preview") as HTMLButtonElement;

let table: Tabulator | undefined;
let lastFields: string[] = [];
let currentFormat: "csv" | "json" = "csv";

function setMeta(text: string, kind?: string): void {
  metaEl.textContent = text;
  metaEl.className = "meta" + (kind ? " " + kind : "");
}

function setToolbarEnabled(enabled: boolean): void {
  exportCsvBtn.disabled = !enabled;
  exportJsonBtn.disabled = !enabled;
}

/** Infer a Tabulator sorter from a column's values (number/date/string). */
function inferSorter(
  rows: Record<string, unknown>[],
  field: string,
): "number" | "datetime" | "string" {
  for (const row of rows) {
    const v = row[field];
    if (v === null || v === undefined || v === "") {
      continue;
    }
    if (typeof v === "number") {
      return "number";
    }
    const s = String(v);
    if (/^-?\d+(\.\d+)?$/.test(s)) {
      return "number";
    }
    if (/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2})?/.test(s)) {
      return "datetime";
    }
    return "string";
  }
  return "string";
}

function renderGrid(result: QueryResult): void {
  lastFields = result.fields;
  if (table) {
    table.destroy();
    table = undefined;
  }
  gridEl.innerHTML = "";
  if (!result.fields.length) {
    return;
  }
  const columns: ColumnDefinition[] = result.fields.map((f) => ({
    title: f,
    field: f,
    headerSort: true,
    resizable: true,
    sorter: inferSorter(result.rows, f),
    // Render NULL/undefined distinctly.
    formatter: (cell) => {
      const v = cell.getValue();
      if (v === null || v === undefined) {
        return '<span class="null">NULL</span>';
      }
      if (typeof v === "object") {
        return escapeHtml(JSON.stringify(v));
      }
      return escapeHtml(String(v));
    },
  }));

  table = new Tabulator(gridEl, {
    data: result.rows,
    columns,
    layout: "fitDataStretch",
    resizableColumnFit: false,
    height: "100%",
    placeholder: "No rows",
    reactiveData: false,
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Rows in the grid's CURRENT (post-sort) order, as plain objects. */
function currentRows(): Record<string, unknown>[] {
  if (!table) {
    return [];
  }
  return table.getData("active") as Record<string, unknown>[];
}

function toCsv(rows: Record<string, unknown>[]): string {
  const esc = (v: unknown): string => {
    if (v === null || v === undefined) {
      return "";
    }
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    // Quote if the value contains a comma, quote, or newline.
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const header = lastFields.map(esc).join(",");
  const body = rows
    .map((row) => lastFields.map((f) => esc(row[f])).join(","))
    .join("\n");
  return header + "\n" + body;
}

function toJson(rows: Record<string, unknown>[]): string {
  return JSON.stringify(rows, null, 2);
}

function openPreview(format: "csv" | "json"): void {
  currentFormat = format;
  const rows = currentRows();
  previewTextEl.value = format === "csv" ? toCsv(rows) : toJson(rows);
  previewEl.hidden = false;
  previewTextEl.focus();
  previewTextEl.select();
}

exportCsvBtn.addEventListener("click", () => openPreview("csv"));
exportJsonBtn.addEventListener("click", () => openPreview("json"));
closePreviewBtn.addEventListener("click", () => {
  previewEl.hidden = true;
});

copyBtn.addEventListener("click", () => {
  void navigator.clipboard.writeText(previewTextEl.value).then(
    () => {
      copyBtn.textContent = "Copied!";
      setTimeout(() => (copyBtn.textContent = "Copy"), 1200);
    },
    () => {
      // Fallback: select so the user can Ctrl+C.
      previewTextEl.focus();
      previewTextEl.select();
    },
  );
});

saveBtn.addEventListener("click", () => {
  vscodeApi.postMessage({
    type: "save",
    format: currentFormat,
    content: previewTextEl.value,
  });
});

window.addEventListener("message", (event: MessageEvent<InboundMessage>) => {
  const msg = event.data;
  previewEl.hidden = true;
  if (msg.type === "reset") {
    setMeta("Run a query to see results here.", "empty");
    setToolbarEnabled(false);
    if (table) {
      table.destroy();
      table = undefined;
    }
    gridEl.innerHTML = "";
    return;
  }
  if (msg.type === "running") {
    setMeta((msg.label ? msg.label + " — " : "") + "Running…", "pending");
    setToolbarEnabled(false);
    return;
  }
  if (msg.type === "error") {
    setMeta((msg.label ? msg.label + " — " : "") + msg.message, "error");
    setToolbarEnabled(false);
    if (table) {
      table.destroy();
      table = undefined;
    }
    gridEl.innerHTML = "";
    return;
  }
  if (msg.type === "result") {
    const prefix = msg.label ? msg.label + " — " : "";
    if (typeof msg.result.affectedRows === "number") {
      setMeta(
        prefix +
          msg.result.affectedRows +
          " row(s) affected · " +
          msg.ms +
          " ms",
        "ok",
      );
      setToolbarEnabled(false);
      if (table) {
        table.destroy();
        table = undefined;
      }
      gridEl.innerHTML = "";
    } else {
      setMeta(
        prefix + msg.result.rows.length + " row(s) · " + msg.ms + " ms",
        "ok",
      );
      renderGrid(msg.result);
      setToolbarEnabled(msg.result.rows.length > 0);
    }
  }
});
