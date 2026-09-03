import * as vscode from "vscode";
import { ConnectionStore } from "./connections";
import { DbManager } from "./db";
import {
  ConnectionNode,
  ConnectionTreeProvider,
  SchemaNode,
  TableNode,
} from "./tree";
import { promptConnection } from "./prompt";
import { ConsolePanel } from "./console";

export function activate(context: vscode.ExtensionContext): void {
  const store = new ConnectionStore(context);
  const db = new DbManager(store);
  const tree = new ConnectionTreeProvider(store, db);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("mysqlWorkbench.connections", tree),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "mysqlWorkbench.addConnection",
      async () => {
        const result = await promptConnection();
        if (result) {
          await store.add(result.config, result.password);
        }
      },
    ),

    vscode.commands.registerCommand("mysqlWorkbench.refresh", () =>
      tree.refresh(),
    ),

    vscode.commands.registerCommand(
      "mysqlWorkbench.editConnection",
      async (node?: ConnectionNode) => {
        if (!node) {
          return;
        }
        const result = await promptConnection(node.config);
        if (result) {
          await db.dispose(node.config.id);
          await store.update(node.config.id, result.config, result.password);
        }
      },
    ),

    vscode.commands.registerCommand(
      "mysqlWorkbench.deleteConnection",
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
      "mysqlWorkbench.openConsole",
      (node?: ConnectionNode | SchemaNode) => {
        if (!node) {
          return;
        }
        const schema = node instanceof SchemaNode ? node.schema : undefined;
        ConsolePanel.show(context, db, node.config, schema);
      },
    ),

    vscode.commands.registerCommand(
      "mysqlWorkbench.previewTable",
      (node?: TableNode) => {
        if (!node) {
          return;
        }
        const limit = vscode.workspace
          .getConfiguration("mysqlWorkbench")
          .get<number>("queryRowLimit", 500);
        const clause = limit && limit > 0 ? ` LIMIT ${limit}` : "";
        const panel = ConsolePanel.show(context, db, node.config);
        panel.run(
          `SELECT * FROM \`${node.schema}\`.\`${node.table}\`${clause};`,
        );
      },
    ),

    vscode.commands.registerCommand(
      "mysqlWorkbench.runActiveQuery",
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
        ConsolePanel.show(context, db, picked).run(sql);
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
