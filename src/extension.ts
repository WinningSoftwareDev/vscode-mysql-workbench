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

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("burrowDbClient.connections", tree),
    vscode.window.registerWebviewViewProvider(RESULTS_VIEW_ID, results, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
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
