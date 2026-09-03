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
  sshEnabled: boolean;
  sshHost: string;
  sshPort: number;
  sshUser: string;
  sshPrivateKeyPath: string;
  sshHasPassphrase: boolean;
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
  sshEnabled: boolean;
  sshHost: string;
  sshPort: string;
  sshUser: string;
  sshPrivateKeyPath: string;
  sshPassphrase: string;
  /** On edit: true means the passphrase box was left blank (keep stored). */
  sshPassphraseUnchanged: boolean;
}

function toView(c: ConnectionConfig): ConnectionView {
  return {
    id: c.id,
    name: c.name,
    host: c.host,
    port: c.port,
    user: c.user,
    defaultSchema: c.defaultSchema ?? "",
    sshEnabled: c.ssh?.enabled ?? false,
    sshHost: c.ssh?.host ?? "",
    sshPort: c.ssh?.port ?? 22,
    sshUser: c.ssh?.user ?? "",
    sshPrivateKeyPath: c.ssh?.privateKeyPath ?? "",
    sshHasPassphrase: c.ssh?.hasPassphrase ?? false,
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

  /** Resolve the SSH passphrase to send to test(): typed value, or the stored
   * one when editing and the box was left blank. */
  private async resolveSshPassphrase(
    form: FormPayload,
  ): Promise<string | undefined> {
    if (!form.sshEnabled) {
      return undefined;
    }
    if (form.sshPassphraseUnchanged && form.id) {
      return (await this.store.getSshPassphrase(form.id)) ?? undefined;
    }
    return form.sshPassphrase || undefined;
  }

  /** Build the persisted SshConfig (no secrets) from the form, or undefined. */
  private buildSsh(form: FormPayload):
    | {
        enabled: boolean;
        host: string;
        port: number;
        user: string;
        privateKeyPath: string;
        hasPassphrase: boolean;
      }
    | undefined {
    if (!form.sshEnabled) {
      return undefined;
    }
    const sshPort = Number.parseInt(form.sshPort, 10);
    const hasPassphrase =
      (form.sshPassphraseUnchanged && !!form.id) || !!form.sshPassphrase;
    return {
      enabled: true,
      host: form.sshHost.trim(),
      port:
        Number.isNaN(sshPort) || sshPort <= 0 || sshPort > 65535 ? 22 : sshPort,
      user: form.sshUser.trim(),
      privateKeyPath: form.sshPrivateKeyPath.trim(),
      hasPassphrase,
    };
  }

  /** Returns an error string if SSH is enabled but incomplete, else null. */
  private validateSsh(form: FormPayload): string | null {
    if (!form.sshEnabled) {
      return null;
    }
    if (!form.sshHost.trim()) {
      return "SSH host is required.";
    }
    if (!form.sshUser.trim()) {
      return "SSH user is required.";
    }
    if (!form.sshPrivateKeyPath.trim()) {
      return "SSH private key path is required.";
    }
    return null;
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
    const sshError = this.validateSsh(form);
    if (sshError) {
      this.post({ type: "testResult", ok: false, message: sshError });
      return;
    }
    try {
      const password = await this.resolvePassword(form);
      const sshPassphrase = await this.resolveSshPassphrase(form);
      const { serverVersion } = await this.db.test(
        {
          name: form.name.trim() || "test",
          host: form.host.trim(),
          port,
          user: form.user.trim(),
          defaultSchema: form.defaultSchema.trim() || undefined,
          ssh: this.buildSsh(form),
        },
        password,
        sshPassphrase,
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
    const sshError = this.validateSsh(form);
    if (sshError) {
      this.post({ type: "testResult", ok: false, message: sshError });
      return;
    }

    const config = {
      name: form.name.trim(),
      host: form.host.trim(),
      port,
      user: form.user.trim(),
      defaultSchema: form.defaultSchema.trim() || undefined,
      ssh: this.buildSsh(form),
    };

    // Persist a new passphrase only when the user typed one.
    const sshPassphrase =
      form.sshEnabled && !form.sshPassphraseUnchanged
        ? form.sshPassphrase
        : undefined;

    if (form.id) {
      // On edit, only overwrite the password when the user typed a new one.
      const password = form.passwordUnchanged ? undefined : form.password;
      await this.db.dispose(form.id);
      await this.store.update(form.id, config, password, sshPassphrase);
      this.post({ type: "saved", id: form.id });
    } else {
      const created = await this.store.add(
        config,
        form.password,
        sshPassphrase,
      );
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

            <div class="ssh-section">
              <label class="toggle">
                <input id="f-ssh-enabled" type="checkbox" />
                <span>Connect through an SSH tunnel</span>
              </label>
              <div id="ssh-fields" class="ssh-fields" hidden>
                <p class="hint ssh-note">
                  The MySQL host/port above are interpreted as seen FROM the SSH
                  host (often 127.0.0.1:3306 on the bastion).
                </p>
                <div class="row">
                  <label class="grow">SSH host<input id="f-ssh-host" type="text" placeholder="bastion.example.com" /></label>
                  <label class="port">SSH port<input id="f-ssh-port" type="text" value="22" /></label>
                </div>
                <label>SSH user<input id="f-ssh-user" type="text" /></label>
                <label>Private key path
                  <input id="f-ssh-key" type="text" placeholder="~/.ssh/id_ed25519 or /abs/path/to/key" />
                </label>
                <label>Key passphrase <span class="hint">(if the key is encrypted)</span>
                  <input id="f-ssh-passphrase" type="password" />
                </label>
              </div>
            </div>

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
