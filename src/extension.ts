import * as vscode from "vscode";
import { ConnectionStore } from "./connections";
import { DbManager } from "./db";
import {
  ConnectionNode,
  ConnectionTreeProvider,
  SchemaNode,
  TableNode,
} from "./tree";
import { ConnectionManagerPanel } from "./manager";
import { ConsolePanel } from "./console";
import { ResultsView, RESULTS_VIEW_ID } from "./results";

export function activate(context: vscode.ExtensionContext): void {
  const store = new ConnectionStore(context);
  const db = new DbManager(store);
  const tree = new ConnectionTreeProvider(store, db);
  const results = new ResultsView(context);

  // Backs the read-only DDL view. `SHOW CREATE TABLE` output is stashed here
  // keyed by the virtual document's URI path, then rendered via a
  // TextDocumentContentProvider so the tab is genuinely read-only (no dirty
  // "unsaved" state, unlike an untitled document).
  const ddlContents = new Map<string, string>();
  const DDL_SCHEME = "burrow-ddl";
  const ddlOnDidChange = new vscode.EventEmitter<vscode.Uri>();
  const ddlProvider: vscode.TextDocumentContentProvider = {
    onDidChange: ddlOnDidChange.event,
    provideTextDocumentContent(uri) {
      return ddlContents.get(uri.path) ?? "";
    },
  };

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("burrowDbClient.connections", tree),
    vscode.window.registerWebviewViewProvider(RESULTS_VIEW_ID, results, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.workspace.registerTextDocumentContentProvider(
      DDL_SCHEME,
      ddlProvider,
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("burrowDbClient.addConnection", () => {
      ConnectionManagerPanel.show(context, store, db);
    }),

    vscode.commands.registerCommand("burrowDbClient.manageConnections", () => {
      ConnectionManagerPanel.show(context, store, db);
    }),

    vscode.commands.registerCommand("burrowDbClient.refresh", () =>
      tree.refresh(),
    ),

    vscode.commands.registerCommand(
      "burrowDbClient.editConnection",
      (node?: ConnectionNode) => {
        ConnectionManagerPanel.show(context, store, db, node?.config.id);
      },
    ),

    vscode.commands.registerCommand(
      "burrowDbClient.deleteConnection",
      async (node?: ConnectionNode) => {
        if (!node) {
          return;
        }
        const confirm = await vscode.window.showWarningMessage(
          `Delete connection "${node.config.name}"?`,
          { modal: true },
          "Delete",
        );
        if (confirm === "Delete") {
          await db.dispose(node.config.id);
          await store.remove(node.config.id);
        }
      },
    ),

    vscode.commands.registerCommand(
      "burrowDbClient.openConsole",
      (node?: ConnectionNode | SchemaNode) => {
        if (!node) {
          return;
        }
        const schema = node instanceof SchemaNode ? node.schema : undefined;
        ConsolePanel.show(context, db, results, node.config, schema);
      },
    ),

    vscode.commands.registerCommand(
      "burrowDbClient.previewTable",
      (node?: TableNode) => {
        if (!node) {
          return;
        }
        const limit = vscode.workspace
          .getConfiguration("burrowDbClient")
          .get<number>("queryRowLimit", 500);
        const clause = limit && limit > 0 ? ` LIMIT ${limit}` : "";
        const panel = ConsolePanel.show(context, db, results, node.config);
        panel.run(
          `SELECT * FROM \`${node.schema}\`.\`${node.table}\`${clause};`,
        );
      },
    ),

    vscode.commands.registerCommand(
      "burrowDbClient.showCreateTable",
      async (node?: TableNode) => {
        if (!node) {
          return;
        }
        try {
          const ddl = await db.showCreate(
            node.config,
            node.schema,
            node.table,
          );
          // A stable, human-readable virtual path. The scheme routes it to the
          // read-only content provider; a trailing .sql gives SQL highlighting.
          const uri = vscode.Uri.parse(
            `${DDL_SCHEME}:/${node.schema}.${node.table}.sql`,
          );
          ddlContents.set(uri.path, ddl);
          // Nudge the provider in case this URI was opened earlier with stale
          // DDL (e.g. the table was altered since).
          ddlOnDidChange.fire(uri);
          const doc = await vscode.workspace.openTextDocument(uri);
          await vscode.languages.setTextDocumentLanguage(doc, "sql");
          await vscode.window.showTextDocument(doc, { preview: true });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(`Burrow DB Client: ${message}`);
        }
      },
    ),

    vscode.commands.registerCommand(
      "burrowDbClient.runActiveQuery",
      async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          void vscode.window.showInformationMessage("Open a .sql file to run.");
          return;
        }
        const sql = editor.selection.isEmpty
          ? editor.document.getText()
          : editor.document.getText(editor.selection);

        const connections = store.list();
        if (connections.length === 0) {
          void vscode.window.showInformationMessage(
            "Add a MySQL connection first.",
          );
          return;
        }
        const picked =
          connections.length === 1
            ? connections[0]
            : await vscode.window
                .showQuickPick(
                  connections.map((c) => ({ label: c.name, config: c })),
                  { placeHolder: "Run against which connection?" },
                )
                .then((p) => p?.config);
        if (!picked) {
          return;
        }
        ConsolePanel.show(context, db, results, picked).run(sql);
      },
    ),
  );

  context.subscriptions.push({
    dispose: () => {
      void db.disposeAll();
    },
  });
}

export function deactivate(): void {
  // Pools are torn down via the disposable registered in activate().
}
