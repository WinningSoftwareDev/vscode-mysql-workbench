import * as vscode from "vscode";
import { QueryResult } from "./db";

/** host -> results webview */
type OutboundMessage =
  | { type: "running"; label: string }
  | { type: "result"; result: QueryResult; label: string; ms: number }
  | { type: "error"; message: string; label: string }
  | { type: "reset" };

export const RESULTS_VIEW_ID = "burrowDbClient.results";

/**
 * The results grid, hosted as a WebviewView in the PANEL (next to Terminal /
 * Ports). There is one shared results view — it always shows the most recent
 * query's output, like the Terminal shows the active terminal. The SQL editor
 * itself stays in the editor area (see ConsolePanel).
 */
export class ResultsView implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  /** Buffered message when a query runs before the view is resolved. */
  private pending: OutboundMessage | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "media"),
      ],
    };
    webviewView.webview.html = this.html(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    // Flush anything that arrived before the view existed.
    if (this.pending) {
      void webviewView.webview.postMessage(this.pending);
      this.pending = undefined;
    }
  }

  private async onMessage(msg: unknown): Promise<void> {
    if (
      typeof msg !== "object" ||
      msg === null ||
      (msg as { type?: string }).type !== "save"
    ) {
      return;
    }
    const { format, content } = msg as {
      format: "csv" | "json";
      content: string;
    };
    const uri = await vscode.window.showSaveDialog({
      filters:
        format === "csv"
          ? { "CSV files": ["csv"] }
          : { "JSON files": ["json"] },
      saveLabel: "Export",
    });
    if (!uri) {
      return;
    }
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
    void vscode.window.showInformationMessage(
      `Exported results to ${uri.fsPath}`,
    );
  }

  /**
   * Ensure the panel view is visible, then run `send` to push a message.
   * VS Code resolves the provider lazily, so we reveal via the focus command
   * and post once resolved (buffering if needed).
   */
  private async reveal(): Promise<void> {
    if (this.view) {
      this.view.show?.(true);
      return;
    }
    // Focus the view to force VS Code to resolve the provider.
    await vscode.commands.executeCommand(`${RESULTS_VIEW_ID}.focus`);
  }

  private post(message: OutboundMessage): void {
    if (this.view) {
      void this.view.webview.postMessage(message);
    } else {
      // Not resolved yet — buffer the latest; resolveWebviewView flushes it.
      this.pending = message;
    }
  }

  async running(label: string): Promise<void> {
    await this.reveal();
    this.post({ type: "running", label });
  }

  async showResult(
    result: QueryResult,
    label: string,
    ms: number,
  ): Promise<void> {
    await this.reveal();
    this.post({ type: "result", result, label, ms });
  }

  async showError(message: string, label: string): Promise<void> {
    await this.reveal();
    this.post({ type: "error", message, label });
  }

  private html(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri,
        "media",
        "results.bundle.js",
      ),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "results.css"),
    );
    const bundleStyleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri,
        "media",
        "results.bundle.css",
      ),
    );
    // Tabulator injects <style> at runtime, so style-src needs 'unsafe-inline'.
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${bundleStyleUri}" rel="stylesheet" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>SQL Results</title>
</head>
<body>
  <div id="bar">
    <div id="meta" class="meta empty">Run a query to see results here.</div>
    <div id="toolbar">
      <button id="export-csv" class="tb" disabled>Export CSV</button>
      <button id="export-json" class="tb" disabled>Export JSON</button>
    </div>
  </div>
  <div id="grid"></div>
  <div id="preview" hidden>
    <div class="preview-head">
      <span>Export preview</span>
      <span class="spacer"></span>
      <button id="copy-btn" class="tb primary">Copy</button>
      <button id="save-btn" class="tb">Save to file…</button>
      <button id="close-preview" class="tb">Close</button>
    </div>
    <textarea id="preview-text" spellcheck="false" readonly></textarea>
  </div>
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
