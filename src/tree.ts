import * as vscode from "vscode";
import { ConnectionConfig, ConnectionStore } from "./connections";
import { DbManager } from "./db";

type Node = ConnectionNode | SchemaNode | TableNode | ColumnNode;

export class ConnectionNode extends vscode.TreeItem {
  readonly kind = "connection" as const;
  constructor(public readonly config: ConnectionConfig) {
    super(config.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = "mysqlConnection";
    this.description = `${config.user}@${config.host}:${config.port}`;
    this.iconPath = new vscode.ThemeIcon("database");
    this.tooltip = this.description;
  }
}

export class SchemaNode extends vscode.TreeItem {
  readonly kind = "schema" as const;
  constructor(
    public readonly config: ConnectionConfig,
    public readonly schema: string,
  ) {
    super(schema, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = "mysqlSchema";
    this.iconPath = new vscode.ThemeIcon("symbol-namespace");
  }
}

export class TableNode extends vscode.TreeItem {
  readonly kind = "table" as const;
  constructor(
    public readonly config: ConnectionConfig,
    public readonly schema: string,
    public readonly table: string,
    isView: boolean,
  ) {
    super(table, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = "mysqlTable";
    this.iconPath = new vscode.ThemeIcon(isView ? "eye" : "table");
    // Click a table to preview its rows in the results grid.
    this.command = {
      command: "burrowDbClient.previewTable",
      title: "Preview Rows",
      arguments: [this],
    };
  }
}

export class ColumnNode extends vscode.TreeItem {
  readonly kind = "column" as const;
  constructor(name: string, type: string, nullable: boolean, key: string) {
    super(name, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "mysqlColumn";
    const flags = [type, nullable ? "NULL" : "NOT NULL", key]
      .filter(Boolean)
      .join(" · ");
    this.description = flags;
    this.iconPath = new vscode.ThemeIcon(
      key === "PRI" ? "key" : "symbol-field",
    );
  }
}

export class ConnectionTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    Node | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private readonly store: ConnectionStore,
    private readonly db: DbManager,
  ) {
    store.onDidChange(() => this.refresh());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: Node): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: Node): Promise<Node[]> {
    try {
      if (!element) {
        return this.store.list().map((c) => new ConnectionNode(c));
      }
      if (element.kind === "connection") {
        const schemas = await this.db.listSchemas(element.config);
        return schemas.map((s) => new SchemaNode(element.config, s));
      }
      if (element.kind === "schema") {
        const tables = await this.db.listTables(element.config, element.schema);
        return tables.map(
          (t) =>
            new TableNode(
              element.config,
              element.schema,
              t.name,
              t.type.toUpperCase().includes("VIEW"),
            ),
        );
      }
      if (element.kind === "table") {
        const cols = await this.db.listColumns(
          element.config,
          element.schema,
          element.table,
        );
        return cols.map(
          (c) => new ColumnNode(c.name, c.type, c.nullable, c.key),
        );
      }
      return [];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Burrow DB Client: ${message}`);
      return [];
    }
  }
}
