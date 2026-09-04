import * as vscode from "vscode";
import { ConnectionConfig } from "./connections";
import { DbManager } from "./db";
import { ResultsView } from "./results";

/** A schema and its table/view names, for autocomplete. */
interface SchemaMeta {
  name: string;
  tables: { name: string; isView: boolean }[];
}

/** host -> console webview */
type OutboundMessage =
  | { type: "running" }
  | { type: "done" }
  | { type: "failed" }
  // Schema/table names for all schemas on the connection (autocomplete).
  | { type: "schema"; schemas: SchemaMeta[]; defaultSchema?: string }
  // Columns for a specific table, sent in reply to a "needColumns" request.
  | {
      type: "columns";
      schema: string;
      table: string;
      columns: { name: string; type: string; nullable: boolean; key: string }[];
    };

/** console webview -> host */
type InboundMessage =
  | { type: "ready" }
  | { type: "run"; sql: string }
  | { type: "needColumns"; schema: string; table: string }
  | { type: "refreshSchema" };

/**
 * A SQL editor (Monaco), bound to a connection, hosted in the editor area.
 * Running a query sends its results to the shared ResultsView in the panel —
 * the editor itself only shows lightweight status. Not bound to a single
 * schema, so cross-schema queries work.
 */
export class ConsolePanel {
  private static readonly panels = new Map<string, ConsolePanel>();

  static show(
    context: vscode.ExtensionContext,
    db: DbManager,
    results: ResultsView,
    config: ConnectionConfig,
    schema?: string,
  ): ConsolePanel {
    const key = config.id;
    const existing = ConsolePanel.panels.get(key);
    if (existing) {
      existing.panel.reveal();
      return existing;
    }
    const created = new ConsolePanel(context, db, results, config, schema);
    ConsolePanel.panels.set(key, created);
    return created;
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly db: DbManager,
    private readonly results: ResultsView,
    private readonly config: ConnectionConfig,
    private readonly schema?: string,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      "burrowDbClient.console",
      `SQL · ${config.name}${schema ? ` · ${schema}` : ""}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, "media"),
        ],
      },
    );

    this.panel.webview.html = this.html(this.panel.webview);

    this.panel.webview.onDidReceiveMessage(
      (msg) => this.onMessage(msg),
      undefined,
      this.disposables,
    );

    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);

    // Autocomplete is primed when the webview signals it's ready (see the
    // "ready" message in onMessage). Sending here would race the webview's
    // message listener and get dropped.
  }

  /**
   * Load every schema on the connection plus its table/view names (no columns
   * — those are fetched lazily on demand) and push them to the webview. Errors
   * are swallowed: autocomplete is best-effort and must never break the panel.
   */
  private async sendSchema(): Promise<void> {
    try {
      const schemaNames = await this.db.listSchemas(this.config);
      const schemas: SchemaMeta[] = await Promise.all(
        schemaNames.map(async (name) => {
          const tables = await this.db.listTables(this.config, name);
          return {
            name,
            tables: tables.map((t) => ({
              name: t.name,
              isView: t.type.toUpperCase().includes("VIEW"),
            })),
          };
        }),
      );
      this.post({
        type: "schema",
        schemas,
        defaultSchema: this.schema ?? this.config.defaultSchema,
      });
    } catch {
      // Best-effort: leave autocomplete without data rather than surfacing.
    }
  }

  /** Fetch one table's columns on demand and reply to the webview. */
  private async sendColumns(schema: string, table: string): Promise<void> {
    try {
      const columns = await this.db.listColumns(this.config, schema, table);
      this.post({ type: "columns", schema, table, columns });
    } catch {
      // Best-effort: a failed column fetch just means no column completions.
    }
  }

  /** Run SQL programmatically (e.g. from the "run active file" command). */
  run(sql: string): void {
    this.panel.reveal();
    void this.execute(sql);
  }

  private post(message: OutboundMessage): void {
    void this.panel.webview.postMessage(message);
  }

  private async onMessage(msg: unknown): Promise<void> {
    if (typeof msg !== "object" || msg === null) {
      return;
    }
    const message = msg as InboundMessage;
    switch (message.type) {
      case "ready":
        await this.sendSchema();
        return;
      case "run":
        await this.execute(String(message.sql ?? ""));
        return;
      case "needColumns":
        await this.sendColumns(
          String(message.schema),
          String(message.table),
        );
        return;
      case "refreshSchema":
        await this.sendSchema();
        return;
    }
  }

  private async execute(sql: string): Promise<void> {
    const trimmed = sql.trim();
    if (trimmed === "") {
      return;
    }
    this.post({ type: "running" });
    await this.results.running(this.config.name);
    const started = Date.now();
    try {
      const result = await this.db.run(this.config, trimmed);
      const ms = Date.now() - started;
      this.post({ type: "done" });
      if ("isBatch" in result) {
        await this.results.showBatch(result, this.config.name, ms);
      } else {
        await this.results.showResult(result, this.config.name, ms);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.post({ type: "failed" });
      await this.results.showError(message, this.config.name);
    }
  }

  private dispose(): void {
    ConsolePanel.panels.delete(this.config.id);
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
    this.panel.dispose();
  }

  private html(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri,
        "media",
        "console.bundle.js",
      ),
    );
    const workerUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri,
        "media",
        "editor.worker.js",
      ),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "console.css"),
    );
    const monacoStyleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri,
        "media",
        "console.bundle.css",
      ),
    );
    // Monaco injects <style> tags at runtime (so style-src needs
    // 'unsafe-inline') and spins up a Web Worker from our bundled worker
    // (worker-src). Everything else stays locked down.
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `worker-src ${webview.cspSource} blob:`,
      `font-src ${webview.cspSource}`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${monacoStyleUri}" rel="stylesheet" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>SQL Console</title>
</head>
<body>
  <div id="toolbar">
    <span id="status">Ready — ${escapeHtml(this.config.name)}</span>
    <span id="hint">Ctrl/Cmd+Enter to run · results appear in the SQL Results panel</span>
  </div>
  <div id="editor"></div>
  <script nonce="${nonce}">window.MONACO_WORKER_URI = "${workerUri}";</script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
