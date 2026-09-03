import * as vscode from "vscode";
import { ConnectionConfig, ConnectionStore } from "./connections";
import { DbManager } from "./db";

/** A connection as sent to the webview (never includes the password). */
interface ConnectionView {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  defaultSchema: string;
}

/** webview -> host */
type InboundMessage =
  | { type: "ready" }
  | { type: "select"; id: string | null }
  | { type: "test"; form: FormPayload }
  | { type: "save"; form: FormPayload }
  | { type: "delete"; id: string };

/** host -> webview */
type OutboundMessage =
  | { type: "list"; connections: ConnectionView[]; selectedId: string | null }
  | { type: "testResult"; ok: boolean; message: string }
  | { type: "saved"; id: string }
  | { type: "deleted" };

interface FormPayload {
  id: string | null;
  name: string;
  host: string;
  port: string;
  user: string;
  password: string;
  /** Only meaningful on edit: true means the password box was left blank. */
  passwordUnchanged: boolean;
  defaultSchema: string;
}

function toView(c: ConnectionConfig): ConnectionView {
  return {
    id: c.id,
    name: c.name,
    host: c.host,
    port: c.port,
    user: c.user,
    defaultSchema: c.defaultSchema ?? "",
  };
}

/**
 * Single webview panel that lists connections and hosts the add/edit form
 * with a Test Connection button. All persistence goes through ConnectionStore
 * (metadata in globalState, password in SecretStorage). The webview never
 * receives a stored password — only the transient one the user is typing.
 */
export class ConnectionManagerPanel {
  private static current: ConnectionManagerPanel | undefined;

  static show(
    context: vscode.ExtensionContext,
    store: ConnectionStore,
    db: DbManager,
    selectId?: string,
  ): void {
    if (ConnectionManagerPanel.current) {
      ConnectionManagerPanel.current.panel.reveal();
      if (selectId) {
        ConnectionManagerPanel.current.postList(selectId);
      }
      return;
    }
    ConnectionManagerPanel.current = new ConnectionManagerPanel(
      context,
      store,
      db,
      selectId ?? null,
    );
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: ConnectionStore,
    private readonly db: DbManager,
    private readonly initialSelectId: string | null,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      "mysqlWorkbench.manager",
      "MySQL Connections",
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
      (msg) => this.onMessage(msg as InboundMessage),
      undefined,
      this.disposables,
    );
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
    // Re-push the list if connections change from elsewhere (tree delete etc).
    this.disposables.push(store.onDidChange(() => this.postList()));
  }

  private post(message: OutboundMessage): void {
    void this.panel.webview.postMessage(message);
  }

  private postList(selectedId?: string | null): void {
    const connections = this.store.list().map(toView);
    const selected =
      selectedId !== undefined
        ? selectedId
        : (this.initialSelectId ??
          (connections.length > 0 ? connections[0].id : null));
    this.post({ type: "list", connections, selectedId: selected });
  }

  private async onMessage(msg: InboundMessage): Promise<void> {
    switch (msg.type) {
      case "ready":
        this.postList();
        return;
      case "select":
        return;
      case "test":
        await this.handleTest(msg.form);
        return;
      case "save":
        await this.handleSave(msg.form);
        return;
      case "delete":
        await this.handleDelete(msg.id);
        return;
    }
  }

  private parsePort(raw: string): number | undefined {
    const port = Number.parseInt(raw, 10);
    if (Number.isNaN(port) || port <= 0 || port > 65535) {
      return undefined;
    }
    return port;
  }

  private async resolvePassword(form: FormPayload): Promise<string> {
    if (form.passwordUnchanged && form.id) {
      return (await this.store.getPassword(form.id)) ?? "";
    }
    return form.password;
  }

  private async handleTest(form: FormPayload): Promise<void> {
    const port = this.parsePort(form.port);
    if (!form.host.trim() || port === undefined || !form.user.trim()) {
      this.post({
        type: "testResult",
        ok: false,
        message: "Host, a valid port (1–65535), and user are required.",
      });
      return;
    }
    try {
      const password = await this.resolvePassword(form);
      const { serverVersion } = await this.db.test(
        {
          name: form.name.trim() || "test",
          host: form.host.trim(),
          port,
          user: form.user.trim(),
          defaultSchema: form.defaultSchema.trim() || undefined,
        },
        password,
      );
      this.post({
        type: "testResult",
        ok: true,
        message: `Connected — MySQL ${serverVersion}`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.post({ type: "testResult", ok: false, message });
    }
  }

  private async handleSave(form: FormPayload): Promise<void> {
    const port = this.parsePort(form.port);
    if (!form.name.trim()) {
      this.post({
        type: "testResult",
        ok: false,
        message: "Connection name is required.",
      });
      return;
    }
    if (!form.host.trim() || port === undefined || !form.user.trim()) {
      this.post({
        type: "testResult",
        ok: false,
        message: "Host, a valid port (1–65535), and user are required.",
      });
      return;
    }

    const config = {
      name: form.name.trim(),
      host: form.host.trim(),
      port,
      user: form.user.trim(),
      defaultSchema: form.defaultSchema.trim() || undefined,
    };

    if (form.id) {
      // On edit, only overwrite the password when the user typed a new one.
      const password = form.passwordUnchanged ? undefined : form.password;
      await this.db.dispose(form.id);
      await this.store.update(form.id, config, password);
      this.post({ type: "saved", id: form.id });
    } else {
      const created = await this.store.add(config, form.password);
      this.post({ type: "saved", id: created.id });
      this.postList(created.id);
    }
  }

  private async handleDelete(id: string): Promise<void> {
    const conn = this.store.get(id);
    if (!conn) {
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      `Delete connection "${conn.name}"?`,
      { modal: true },
      "Delete",
    );
    if (confirm === "Delete") {
      await this.db.dispose(id);
      await this.store.remove(id);
      this.post({ type: "deleted" });
    }
  }

  private dispose(): void {
    ConnectionManagerPanel.current = undefined;
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
    this.panel.dispose();
  }

  private html(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "manager.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "manager.css"),
    );
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>MySQL Connections</title>
</head>
<body>
  <div id="layout">
    <aside id="sidebar">
      <div id="sidebar-head">
        <span>Connections</span>
        <button id="new-btn" title="New connection">
          <span class="plus">+</span> New
        </button>
      </div>
      <ul id="conn-list"></ul>
    </aside>
    <main id="form-pane">
      <form id="conn-form" autocomplete="off">
        <div class="card">
          <header class="card-head">
            <h1 id="form-title">Connection Details</h1>
            <p class="card-sub">
              Leave the default schema blank to browse every schema on the
              server.
            </p>
          </header>
          <div class="card-body">
            <input type="hidden" id="conn-id" />
            <label>Name<input id="f-name" type="text" placeholder="e.g. Local MySQL" /></label>
            <div class="row">
              <label class="grow">Host<input id="f-host" type="text" value="127.0.0.1" /></label>
              <label class="port">Port<input id="f-port" type="text" value="3306" /></label>
            </div>
            <label>User<input id="f-user" type="text" value="root" /></label>
            <label>Password<input id="f-password" type="password" /></label>
            <label>Default schema <span class="hint">(optional — blank browses all schemas)</span>
              <input id="f-schema" type="text" placeholder="leave blank for the whole server" />
            </label>
            <div id="status" class="status"></div>
          </div>
          <footer class="card-foot">
            <button type="button" id="test-btn" class="secondary">Test Connection</button>
            <span class="spacer"></span>
            <button type="button" id="delete-btn" class="danger">Delete</button>
            <button type="submit" id="save-btn" class="primary">Save</button>
          </footer>
        </div>
      </form>
    </main>
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
