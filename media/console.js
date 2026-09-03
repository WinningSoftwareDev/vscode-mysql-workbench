// Webview client. Runs in the sandboxed webview — no Node, no credentials.
// Talks to the extension host purely over postMessage.
(function () {
  const vscode = acquireVsCodeApi();
  const editor = document.getElementById("editor");
  const grid = document.getElementById("grid");
  const meta = document.getElementById("meta");
  const status = document.getElementById("status");

  // Restore the last query so a hidden/re-shown panel keeps its text.
  const prev = vscode.getState();
  if (prev && typeof prev.sql === "string") {
    editor.value = prev.sql;
  }

  function run() {
    const sql = editor.value;
    vscode.setState({ sql });
    vscode.postMessage({ type: "run", sql });
  }

  editor.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      run();
    }
  });

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderCell(value) {
    if (value === null || value === undefined) {
      return '<span class="null">NULL</span>';
    }
    if (typeof value === "object") {
      return escapeHtml(JSON.stringify(value));
    }
    return escapeHtml(value);
  }

  function renderGrid(result) {
    if (!result.fields.length) {
      grid.innerHTML = "";
      return;
    }
    const head =
      "<thead><tr>" +
      result.fields.map((f) => "<th>" + escapeHtml(f) + "</th>").join("") +
      "</tr></thead>";
    const body =
      "<tbody>" +
      result.rows
        .map(function (row) {
          return (
            "<tr>" +
            result.fields
              .map((f) => "<td>" + renderCell(row[f]) + "</td>")
              .join("") +
            "</tr>"
          );
        })
        .join("") +
      "</tbody>";
    grid.innerHTML = "<table>" + head + body + "</table>";
  }

  window.addEventListener("message", function (event) {
    const msg = event.data;
    if (msg.type === "running") {
      status.textContent = "Running…";
      meta.textContent = "";
      grid.innerHTML = "";
      return;
    }
    if (msg.type === "error") {
      status.textContent = "Error";
      meta.innerHTML = '<span class="error">' + escapeHtml(msg.message) + "</span>";
      grid.innerHTML = "";
      return;
    }
    if (msg.type === "result") {
      status.textContent = "Ready";
      if (typeof msg.result.affectedRows === "number") {
        meta.textContent =
          msg.result.affectedRows + " row(s) affected · " + msg.ms + " ms";
        grid.innerHTML = "";
      } else {
        meta.textContent =
          msg.result.rows.length + " row(s) · " + msg.ms + " ms";
        renderGrid(msg.result);
      }
    }
  });
})();
