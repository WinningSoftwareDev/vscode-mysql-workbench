# Changelog

All notable changes to this extension are documented here. This project adheres
to [Semantic Versioning](https://semver.org/).

## [0.4.0] - 2026-09-04

### Added

- **View a table's DDL.** Right-click a table (or view) in the tree and choose
  _Show CREATE Statement (DDL)_ to open its `SHOW CREATE TABLE` output in a
  read-only, SQL-highlighted editor tab.
- **Schema-aware autocomplete in the SQL console.** The Monaco console now
  suggests schemas, tables/views, and columns drawn from the live connection.
  Completions are context-aware: table names after `FROM` / `JOIN` /
  `INTO` / `UPDATE`, that schema's tables after `schema.`, a table's columns
  after `table.` / `alias.` (aliases and schema-qualified references are
  resolved from the statement), and the target table's columns inside an
  `INSERT INTO t (…)` column list. Table and column metadata is loaded lazily
  (schema and table names up front; columns on first use, then cached) across
  every schema on the connection.
- **Hover details in the SQL console.** Hovering a table shows its column list;
  hovering a column shows its type, nullability, and key.
- **Refresh schema for autocomplete.** A console command (_Burrow: Refresh
  Schema for Autocomplete_) re-pulls schema metadata when the database changes.

## [0.3.0] - 2026-09-03

### Added

- **SSL / TLS connections.** A connection can now use TLS: _Require_ (encrypt
  without verifying the server certificate — the fix for servers like Amazon
  RDS with `require_secure_transport = ON`) or _Verify CA_ (verify against a CA
  bundle referenced by path). Configured per-connection in the manager.

## [0.2.0] - 2026-09-03

### Added

- **Sortable, resizable results grid.** The results panel now uses a proper
  data grid: click a column header to sort (type-aware — numbers, dates, and
  strings sort correctly), and drag column borders to resize.
- **Export results to CSV / JSON.** Export buttons in the results panel open a
  preview of the current result set (respecting the active sort order) with
  **Copy to clipboard** and an optional **Save to file…** (native save dialog).

### Fixed

- **Multi-statement batches now execute.** A submission with more than one
  `;`-separated statement runs each sequentially, **stopping on the first
  error** (PHPStorm-style) and reporting which statement failed. Batches show
  an execution summary (statements run · rows affected · time) rather than a
  grid — intended for DDL/DML. A single statement still shows its grid.
- **Selection-aware run.** `Ctrl`/`Cmd`+`Enter` in the SQL console now runs the
  selected text when there is a selection, instead of always running the whole
  buffer.

## [0.1.0] - 2026-09-03

Initial release.

### Connections

- Connection **manager panel** — a connection list plus an add/edit form with a
  **Test Connection** button that verifies credentials (and the SSH tunnel, when
  enabled) without saving.
- Add, edit, and delete connections from the manager or the tree view.
- Passwords and SSH key passphrases are stored in the OS keychain via VS Code
  **SecretStorage** — never in `settings.json` or global state.

### Whole-server browsing

- One connection binds to the **whole server**, not a single database: leaving
  the default schema blank lists every schema. No per-schema connections and no
  connection-count limit.
- Lazy, cached tree: connection → schema → table → column, with a refresh
  action. System schemas (`information_schema`, `performance_schema`, `mysql`,
  `sys`) are hidden.
- Click a table to preview its rows (row limit configurable).

### SQL console + results

- **Monaco-based SQL editor** in the editor area (one per connection) with
  generic dark/light SQL syntax highlighting that follows the active theme's
  base. `Ctrl`/`Cmd`+`Enter` runs the buffer.
- **Results appear in a dedicated "SQL Results" tab in the bottom panel**, next
  to Terminal / Ports — the editor stays roomy and the most recent query
  populates the shared results grid.
- Run the active `.sql` file (or the current selection) against a chosen
  connection via the _Run Active SQL File / Selection_ command.

### SSH tunnelling

- Connect through a bastion / jump host. Auth is **private-key file +
  optional passphrase**; the key is referenced by path (never copied into
  storage) and the passphrase lives in SecretStorage.
- The MySQL host/port are interpreted as seen from the SSH host, and cross-schema
  queries continue to work through the tunnel.

### Security

- All database and SSH access runs on the extension host (Node) using `mysql2`
  and `ssh2`. Webviews are sandboxed and never receive credentials or a live
  connection — only serialisable result rows.
