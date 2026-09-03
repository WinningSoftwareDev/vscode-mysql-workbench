# Changelog

All notable changes to this extension are documented here. This project adheres
to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Sortable, resizable results grid.** The results panel now uses a proper
  data grid: click a column header to sort (type-aware — numbers, dates, and
  strings sort correctly), and drag column borders to resize.
- **Export results to CSV / JSON.** Export buttons in the results panel open a
  preview of the current result set (respecting the active sort order) with
  **Copy to clipboard** and an optional **Save to file…** (native save dialog).

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
