import * as vscode from "vscode";
import * as mysql from "mysql2/promise";
import * as fs from "fs/promises";
import { ConnectionConfig, ConnectionStore, SslConfig } from "./connections";
import { SshTunnel } from "./tunnel";
import { splitStatements } from "./sqlsplit";

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  key: string;
}

export interface TableInfo {
  name: string;
  type: string;
}

export interface QueryResult {
  /** Column names, in select order. */
  fields: string[];
  /** Row objects keyed by column name. */
  rows: Record<string, unknown>[];
  /** Rows affected, for non-SELECT statements. */
  affectedRows?: number;
}

/**
 * Summary of a multi-statement batch. Batches don't return grids — they run
 * DDL/DML sequentially and stop on the first error.
 */
export interface BatchResult {
  isBatch: true;
  /** How many statements ran successfully. */
  statementsRun: number;
  /** Total statements in the batch. */
  statementsTotal: number;
  /** Sum of affected rows across the statements that ran. */
  rowsAffected: number;
  /** 1-based index of the statement that failed (absent on full success). */
  failedIndex?: number;
  /** Error message from the failed statement. */
  failedError?: string;
}

/**
 * Manages one connection pool per saved connection (and, for SSH-enabled
 * connections, the tunnel that pool runs through). All MySQL access happens
 * here, on the extension host — never in a webview.
 */
export class DbManager {
  private readonly pools = new Map<string, mysql.Pool>();
  private readonly tunnels = new Map<string, SshTunnel>();

  constructor(private readonly store: ConnectionStore) {}

  private connectTimeout(): number {
    return vscode.workspace
      .getConfiguration("burrowDbClient")
      .get<number>("connectTimeout", 10000);
  }

  /**
   * Map a connection's SSL config to mysql2's `ssl` option.
   * - disabled / absent → undefined (plaintext).
   * - require → encrypt but do not verify the server cert
   *   (`rejectUnauthorized: false`) — matches "just works" TLS clients.
   * - verify-ca → verify against the supplied CA bundle.
   */
  private async sslOptions(
    ssl: SslConfig | undefined,
  ): Promise<mysql.SslOptions | undefined> {
    if (!ssl || ssl.mode === "disabled") {
      return undefined;
    }
    if (ssl.mode === "require") {
      return { rejectUnauthorized: false };
    }
    // verify-ca
    if (!ssl.caPath) {
      throw new Error(
        "SSL mode is 'verify-ca' but no CA certificate path is set.",
      );
    }
    const ca = await fs.readFile(ssl.caPath, "utf8");
    return { ca, rejectUnauthorized: true };
  }

  private async pool(config: ConnectionConfig): Promise<mysql.Pool> {
    const existing = this.pools.get(config.id);
    if (existing) {
      return existing;
    }
    const password = await this.store.getPassword(config.id);
    const connectTimeout = this.connectTimeout();

    // For SSH connections, stand up the tunnel and point the pool at the
    // local forwarded port instead of the (unreachable) real host.
    let host = config.host;
    let port = config.port;
    if (config.ssh?.enabled) {
      const passphrase = config.ssh.hasPassphrase
        ? await this.store.getSshPassphrase(config.id)
        : undefined;
      const tunnel = await SshTunnel.create({
        sshHost: config.ssh.host,
        sshPort: config.ssh.port,
        sshUser: config.ssh.user,
        privateKeyPath: config.ssh.privateKeyPath,
        passphrase,
        destHost: config.host,
        destPort: config.port,
        readyTimeout: connectTimeout,
      });
      this.tunnels.set(config.id, tunnel);
      host = "127.0.0.1";
      port = tunnel.localPort;
    }

    const ssl = await this.sslOptions(config.ssl);

    const pool = mysql.createPool({
      host,
      port,
      user: config.user,
      password: password ?? "",
      // Deliberately NO `database`: bind to the server, not one schema, so
      // every schema is browsable and cross-schema JOINs work.
      database: config.defaultSchema || undefined,
      connectTimeout,
      waitForConnections: true,
      connectionLimit: 4,
      multipleStatements: false,
      dateStrings: true,
      ssl,
    });
    this.pools.set(config.id, pool);
    return pool;
  }

  /** Close and forget a connection's pool AND its tunnel (edit/delete). */
  async dispose(id: string): Promise<void> {
    const pool = this.pools.get(id);
    if (pool) {
      this.pools.delete(id);
      await pool.end();
    }
    const tunnel = this.tunnels.get(id);
    if (tunnel) {
      this.tunnels.delete(id);
      await tunnel.close();
    }
  }

  async disposeAll(): Promise<void> {
    const ids = new Set([...this.pools.keys(), ...this.tunnels.keys()]);
    await Promise.all([...ids].map((id) => this.dispose(id)));
  }

  async listSchemas(config: ConnectionConfig): Promise<string[]> {
    const pool = await this.pool(config);
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT schema_name AS name
         FROM information_schema.schemata
        WHERE schema_name NOT IN
              ('information_schema','performance_schema','mysql','sys')
        ORDER BY schema_name`,
    );
    return rows.map((r) => String(r.name));
  }

  async listTables(
    config: ConnectionConfig,
    schema: string,
  ): Promise<TableInfo[]> {
    const pool = await this.pool(config);
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT table_name AS name, table_type AS type
         FROM information_schema.tables
        WHERE table_schema = ?
        ORDER BY table_name`,
      [schema],
    );
    return rows.map((r) => ({ name: String(r.name), type: String(r.type) }));
  }

  async listColumns(
    config: ConnectionConfig,
    schema: string,
    table: string,
  ): Promise<ColumnInfo[]> {
    const pool = await this.pool(config);
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT column_name  AS name,
              column_type  AS type,
              is_nullable  AS nullable,
              column_key   AS \`key\`
         FROM information_schema.columns
        WHERE table_schema = ? AND table_name = ?
        ORDER BY ordinal_position`,
      [schema, table],
    );
    return rows.map((r) => ({
      name: String(r.name),
      type: String(r.type),
      nullable: String(r.nullable).toUpperCase() === "YES",
      key: String(r.key ?? ""),
    }));
  }

  /**
   * Validate connection details WITHOUT persisting anything. When an SSH
   * config is supplied it stands up a throwaway tunnel, connects through it,
   * runs `SELECT 1`, then tears everything down. Throws on failure so the
   * caller can surface the driver's / SSH client's message.
   */
  async test(
    config: Omit<ConnectionConfig, "id">,
    password: string,
    sshPassphrase?: string,
  ): Promise<{ serverVersion: string }> {
    const connectTimeout = this.connectTimeout();

    let host = config.host;
    let port = config.port;
    let tunnel: SshTunnel | undefined;
    if (config.ssh?.enabled) {
      tunnel = await SshTunnel.create({
        sshHost: config.ssh.host,
        sshPort: config.ssh.port,
        sshUser: config.ssh.user,
        privateKeyPath: config.ssh.privateKeyPath,
        passphrase: sshPassphrase,
        destHost: config.host,
        destPort: config.port,
        readyTimeout: connectTimeout,
      });
      host = "127.0.0.1";
      port = tunnel.localPort;
    }

    try {
      const ssl = await this.sslOptions(config.ssl);
      const conn = await mysql.createConnection({
        host,
        port,
        user: config.user,
        password,
        database: config.defaultSchema || undefined,
        connectTimeout,
        multipleStatements: false,
        ssl,
      });
      try {
        await conn.query("SELECT 1");
        const [rows] = await conn.query<mysql.RowDataPacket[]>(
          "SELECT VERSION() AS version",
        );
        const version = rows.length > 0 ? String(rows[0].version) : "unknown";
        return { serverVersion: version };
      } finally {
        await conn.end();
      }
    } finally {
      if (tunnel) {
        await tunnel.close();
      }
    }
  }

  /** Run arbitrary SQL. Errors are thrown; the caller surfaces them. */
  async query(config: ConnectionConfig, sql: string): Promise<QueryResult> {
    const pool = await this.pool(config);
    const [result, fields] = await pool.query(sql);

    if (Array.isArray(result)) {
      const rows = result as mysql.RowDataPacket[];
      const fieldNames = (fields ?? []).map((f) => f.name);
      // Fall back to keys of the first row if the driver gave no field list.
      const names =
        fieldNames.length > 0
          ? fieldNames
          : rows.length > 0
            ? Object.keys(rows[0])
            : [];
      return { fields: names, rows: rows as Record<string, unknown>[] };
    }

    const header = result as mysql.ResultSetHeader;
    return { fields: [], rows: [], affectedRows: header.affectedRows };
  }

  /**
   * Execute a console submission. A single statement returns a
   * {@link QueryResult} (grid / affected rows). Multiple statements run
   * sequentially, STOP on the first error, and return a {@link BatchResult}
   * summary rather than any grid — batches are for DDL/DML, not viewing rows.
   */
  async run(
    config: ConnectionConfig,
    sql: string,
  ): Promise<QueryResult | BatchResult> {
    const statements = splitStatements(sql);
    if (statements.length <= 1) {
      // Zero statements (comment-only) still goes through query() harmlessly.
      return this.query(config, statements[0] ?? sql);
    }

    let rowsAffected = 0;
    for (let index = 0; index < statements.length; index++) {
      try {
        const r = await this.query(config, statements[index]);
        if (typeof r.affectedRows === "number") {
          rowsAffected += r.affectedRows;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isBatch: true,
          statementsRun: index, // number that succeeded before this one
          statementsTotal: statements.length,
          rowsAffected,
          failedIndex: index + 1, // 1-based for display
          failedError: message,
        };
      }
    }
    return {
      isBatch: true,
      statementsRun: statements.length,
      statementsTotal: statements.length,
      rowsAffected,
    };
  }
}
