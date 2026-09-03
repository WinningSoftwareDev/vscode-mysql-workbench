# MySQL Workbench (VS Code)

Add MySQL connections, browse **every** schema and table in a connection, and
run SQL in a console with a results grid — all inside the editor. No artificial
connection limits and no paid tier.

## Why

Existing extensions either force a single database per connection (so a
multi-schema server needs one connection per schema) or cap the number of free
connections. A connection is a row in your own editor storage and a socket to
your own server — there is nothing to meter. This extension treats a connection
as the **whole server**, the way a PHPStorm/DBeaver data source does.

## Features

- **Add / edit / delete connections** in a dedicated manager panel — a
  connection list plus a form with a **Test Connection** button. Credentials
  are stored in the OS keychain via VS Code SecretStorage — never in
  `settings.json`.
- **Whole-server browsing.** Leave the database field blank and the connection
  lists every schema → table → column. Cross-schema `JOIN`s work.
- **SQL console + results grid.** The SQL editor (Monaco, syntax-highlighted)
  opens in the editor area, one per connection; run a statement (or the active
  `.sql` file / selection) with `Ctrl`/`Cmd`+`Enter`. Results appear in the
  **SQL Results** tab in the bottom panel, next to Terminal / Ports — the
  editor stays roomy and the last query wins the panel.
- **Table preview.** Click a table in the tree to preview its rows.
- **SSH tunnelling.** Connect through a bastion/jump host: toggle _Connect
  through an SSH tunnel_ and supply the SSH host/user + a private-key file
  (path) and optional passphrase. The MySQL host/port are then interpreted as
  seen from the SSH host. The key stays on disk (only its path is stored); the
  passphrase goes in SecretStorage.

## Usage

1. Open the **MySQL Workbench** view in the Activity Bar.
2. **Add Connection** — enter host, port, user, password. Leave _Default schema_
   blank to browse the whole server.
3. Expand the connection to browse schemas/tables/columns.
4. **Open SQL Console** from a connection (or run the active `.sql` file via the
   _Run Active SQL File / Selection_ command).

## Settings

| Setting                         | Default | Description                                                           |
| ------------------------------- | ------- | --------------------------------------------------------------------- |
| `mysqlWorkbench.queryRowLimit`  | `500`   | `LIMIT` applied when previewing a table from the tree (`0` disables). |
| `mysqlWorkbench.connectTimeout` | `10000` | Connection timeout in ms.                                             |

## Security model

All database access runs on the extension host (Node) using `mysql2`. The
webview is sandboxed: it renders the grid and sends "run this SQL" messages, but
never sees credentials or a live connection. Passwords live in SecretStorage.

## Roadmap

Read-only MVP first. Planned later: row editing, DDL view, CSV/JSON export,
query history, ER diagrams.

## License

MIT
