# Burrow DB Client (VS Code)

A 100% free database connection manager for VS Code.

Add MySQL/MariaDB connections, browse **every** schema and table in a
connection, and run SQL with the results in a dedicated panel — all inside the
editor. No artificial connection limits and no paid tier.

## Why

Existing extensions either force a single database per connection (so a
multi-schema server needs one connection per schema) or cap the number of free
connections. A connection is a row in your own editor storage and a socket to
your own server — there is nothing to meter. This extension treats a connection
as the **whole server**, the way a PHPStorm/DBeaver data source does.

## Features

- **Connection manager panel.** A connection list plus an add/edit form with a
  **Test Connection** button. Credentials are stored in the OS keychain via VS
  Code SecretStorage — never in `settings.json`.
- **Whole-server browsing.** Leave the default schema blank and one connection
  lists every schema → table → column. Cross-schema `JOIN`s work.
- **Monaco SQL editor + results panel.** The syntax-highlighted SQL editor
  opens in the editor area (one per connection); run with `Ctrl`/`Cmd`+`Enter`.
  Results render in a **SQL Results** tab in the bottom panel, next to Terminal
  / Ports — the last query wins the shared panel. The grid is **sortable and
  resizable**, and results **export to CSV / JSON** (preview, copy, or save).
- **Table preview.** Click a table in the tree to preview its rows.
- **SSH tunnelling.** Connect through a bastion / jump host: toggle _Connect
  through an SSH tunnel_ and supply the SSH host/user + a private-key file
  (path) and optional passphrase. The MySQL host/port are then interpreted as
  seen from the SSH host. The key stays on disk (only its path is stored); the
  passphrase goes in SecretStorage.

## Requirements

- VS Code **1.90.0** or newer.
- A reachable **MySQL** or **MariaDB** server (directly, or via an SSH host).

## Usage

1. Open the **Burrow DB Client** view in the Activity Bar.
2. Click **＋** (Add Connection) or the **gear** (Manage Connections) to open the
   manager panel. Fill in host, port, user, and password; leave _Default schema_
   blank to browse the whole server. Click **Test Connection** to verify, then
   **Save**.
   - To connect through a jump host, enable **Connect through an SSH tunnel** and
     provide the SSH host/user, private-key path, and passphrase (if any).
3. Expand the connection in the tree to browse schemas → tables → columns, or
   click a table to preview its rows.
4. Use **Open SQL Console** on a connection (or a schema) to open the editor,
   write SQL, and run it with `Ctrl`/`Cmd`+`Enter`. Results appear in the **SQL
   Results** panel. You can also run the active `.sql` file / selection via the
   _Run Active SQL File / Selection_ command.

## Commands

| Command                                           | Description                                                       |
| ------------------------------------------------- | ----------------------------------------------------------------- |
| Burrow DB Client: Add Connection                  | Open the manager to create a new connection.                      |
| Burrow DB Client: Manage Connections              | Open the connection manager panel.                                |
| Burrow DB Client: Edit Connection                 | Edit the selected connection.                                     |
| Burrow DB Client: Delete Connection               | Delete the selected connection.                                   |
| Burrow DB Client: Refresh                         | Reload the connection tree.                                       |
| Burrow DB Client: Open SQL Console                | Open a SQL editor bound to a connection (or schema).              |
| Burrow DB Client: Run Active SQL File / Selection | Run the active `.sql` editor (or selection) against a connection. |

## Settings

| Setting                         | Default | Description                                                           |
| ------------------------------- | ------- | --------------------------------------------------------------------- |
| `burrowDbClient.queryRowLimit`  | `500`   | `LIMIT` applied when previewing a table from the tree (`0` disables). |
| `burrowDbClient.connectTimeout` | `10000` | Connection / SSH handshake timeout in ms.                             |

## Security model

All database and SSH access runs on the extension host (Node), using `mysql2`
and `ssh2`. The webviews (SQL editor and results grid) are sandboxed: they
render UI and send "run this SQL" messages, but never see credentials or a live
connection — only serialisable result rows. Connection passwords and SSH key
passphrases live in SecretStorage; SSH private keys are referenced by path and
never copied into extension storage.

## Feedback & contributing

Burrow DB Client is free and actively developed, and **your feedback genuinely
shapes it** — especially in these early releases. If something is broken,
confusing, or missing, please say so:

- **🐛 Report a bug** or **💡 request a feature** on the
  [issue tracker](https://github.com/WinningSoftwareDev/vscode-mysql-workbench/issues).
  A good bug report includes: what you did, what you expected, what happened,
  your VS Code version, and the MySQL/MariaDB server version (and whether you
  were connecting over SSH).
- **⭐ Rate & review** on the Marketplace if it's useful to you — it helps other
  developers find it.
- **🔧 Pull requests welcome.** The repo is on
  [GitHub](https://github.com/WinningSoftwareDev/vscode-mysql-workbench); open an
  issue first for anything substantial so we can agree the approach.

Please **don't include real credentials, connection strings, or private keys**
in an issue — redact hosts and secrets before pasting logs or screenshots.

## Roadmap

The initial release is read-only. Planned: query history, row editing, DDL
view, and ER diagrams.

## License

MIT
