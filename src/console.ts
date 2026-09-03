import * as vscode from "vscode";
import { ConnectionConfig } from "./connections";
import { DbManager } from "./db";
import { ResultsView } from "./results";

/** host -> console webview (editor-side status only) */
type OutboundMessage =
  { type: "running" } | { type: "done" } | { type: "failed" };

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
    schema?: string,
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
    if (
      typeof msg === "object" &&
      msg !== null &&
      (msg as { type?: string }).type === "run"
    ) {
      const sql = String((msg as { sql?: string }).sql ?? "");
      await this.execute(sql);
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
      const result = await this.db.query(this.config, trimmed);
      this.post({ type: "done" });
      await this.results.showResult(
        result,
        this.config.name,
        Date.now() - started,
      );
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
