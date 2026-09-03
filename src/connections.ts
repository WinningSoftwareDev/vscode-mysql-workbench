import * as vscode from "vscode";
import { randomUUID } from "crypto";

/**
 * Connection metadata persisted in globalState. The password is NEVER stored
 * here — it lives in SecretStorage keyed by {@link secretKey}.
 */
export interface ConnectionConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  /**
   * Optional default schema. Deliberately optional: a connection with no
   * database selected sees EVERY schema on the server, which is the whole
   * point of this extension.
   */
  defaultSchema?: string;
}

const STORAGE_KEY = "mysqlWorkbench.connections";

function secretKey(id: string): string {
  return `mysqlWorkbench.password.${id}`;
}

/**
 * Owns the list of saved connections. Metadata is in globalState (syncs are
 * off — see keys); the password is in the OS keychain via SecretStorage.
 */
export class ConnectionStore {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  list(): ConnectionConfig[] {
    return this.context.globalState.get<ConnectionConfig[]>(STORAGE_KEY, []);
  }

  get(id: string): ConnectionConfig | undefined {
    return this.list().find((c) => c.id === id);
  }

  async add(
    config: Omit<ConnectionConfig, "id">,
    password: string,
  ): Promise<ConnectionConfig> {
    const created: ConnectionConfig = { ...config, id: randomUUID() };
    const next = [...this.list(), created];
    await this.context.globalState.update(STORAGE_KEY, next);
    await this.context.secrets.store(secretKey(created.id), password);
    this._onDidChange.fire();
    return created;
  }

  async update(
    id: string,
    config: Omit<ConnectionConfig, "id">,
    password?: string,
  ): Promise<void> {
    const next = this.list().map((c) => (c.id === id ? { ...config, id } : c));
    await this.context.globalState.update(STORAGE_KEY, next);
    if (password !== undefined && password !== "") {
      await this.context.secrets.store(secretKey(id), password);
    }
    this._onDidChange.fire();
  }

  async remove(id: string): Promise<void> {
    const next = this.list().filter((c) => c.id !== id);
    await this.context.globalState.update(STORAGE_KEY, next);
    await this.context.secrets.delete(secretKey(id));
    this._onDidChange.fire();
  }

  async getPassword(id: string): Promise<string | undefined> {
    return this.context.secrets.get(secretKey(id));
  }
}
