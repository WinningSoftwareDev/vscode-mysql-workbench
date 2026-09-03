// Results panel webview client. Sandboxed — receives query results from the
// host over postMessage and renders a grid. No credentials, no DB access.
(function () {
  const gridEl = document.getElementById("grid");
  const metaEl = document.getElementById("meta");

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
      gridEl.innerHTML = "";
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
    gridEl.innerHTML = "<table>" + head + body + "</table>";
  }

  function setMeta(text, kind) {
    metaEl.textContent = text || "";
    metaEl.className = "meta" + (kind ? " " + kind : "");
  }

  window.addEventListener("message", function (event) {
    const msg = event.data;
    if (msg.type === "reset") {
      setMeta("Run a query to see results here.", "empty");
      gridEl.innerHTML = "";
      return;
    }
    if (msg.type === "running") {
      setMeta((msg.label ? msg.label + " — " : "") + "Running…", "pending");
      gridEl.innerHTML = "";
      return;
    }
    if (msg.type === "error") {
      setMeta((msg.label ? msg.label + " — " : "") + msg.message, "error");
      gridEl.innerHTML = "";
      return;
    }
    if (msg.type === "result") {
      const prefix = msg.label ? msg.label + " — " : "";
      if (typeof msg.result.affectedRows === "number") {
        setMeta(
          prefix + msg.result.affectedRows + " row(s) affected · " + msg.ms + " ms",
          "ok",
        );
        gridEl.innerHTML = "";
      } else {
        setMeta(
          prefix + msg.result.rows.length + " row(s) · " + msg.ms + " ms",
          "ok",
        );
        renderGrid(msg.result);
      }
    }
  });
})();
