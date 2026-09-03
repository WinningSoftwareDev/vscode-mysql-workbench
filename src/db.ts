import * as vscode from "vscode";
import * as mysql from "mysql2/promise";
import { ConnectionConfig, ConnectionStore } from "./connections";

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
 * Manages one connection pool per saved connection. All MySQL access happens
 * here, on the extension host — never in a webview.
 */
export class DbManager {
  private readonly pools = new Map<string, mysql.Pool>();

  constructor(private readonly store: ConnectionStore) {}

  private async pool(config: ConnectionConfig): Promise<mysql.Pool> {
    const existing = this.pools.get(config.id);
    if (existing) {
      return existing;
    }
    const password = await this.store.getPassword(config.id);
    const connectTimeout = vscode.workspace
      .getConfiguration("mysqlWorkbench")
      .get<number>("connectTimeout", 10000);

    const pool = mysql.createPool({
      host: config.host,
      port: config.port,
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
    });
    this.pools.set(config.id, pool);
    return pool;
  }

  /** Close and forget a connection's pool (e.g. on edit/delete). */
  async dispose(id: string): Promise<void> {
    const pool = this.pools.get(id);
    if (pool) {
      this.pools.delete(id);
      await pool.end();
    }
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.pools.keys()].map((id) => this.dispose(id)));
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
}
