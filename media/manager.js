// Connection manager webview client. Sandboxed — talks to the host purely
// over postMessage. Holds a typed password only transiently while editing.
(function () {
  const vscode = acquireVsCodeApi();

  const listEl = document.getElementById("conn-list");
  const statusEl = document.getElementById("status");
  const form = document.getElementById("conn-form");

  const fId = document.getElementById("conn-id");
  const fName = document.getElementById("f-name");
  const fHost = document.getElementById("f-host");
  const fPort = document.getElementById("f-port");
  const fUser = document.getElementById("f-user");
  const fPassword = document.getElementById("f-password");
  const fSchema = document.getElementById("f-schema");

  const newBtn = document.getElementById("new-btn");
  const testBtn = document.getElementById("test-btn");
  const saveBtn = document.getElementById("save-btn");
  const deleteBtn = document.getElementById("delete-btn");

  let connections = [];
  let selectedId = null;
  // True while editing an existing connection and the password box is
  // untouched — signals the host to keep the stored secret.
  let passwordUntouched = false;

  function setStatus(text, kind) {
    statusEl.textContent = text || "";
    statusEl.className = "status" + (kind ? " " + kind : "");
  }

  function renderList() {
    listEl.innerHTML = "";
    connections.forEach(function (c) {
      const li = document.createElement("li");
      li.className = c.id === selectedId ? "selected" : "";
      li.dataset.id = c.id;

      const dot = document.createElement("span");
      dot.className = "conn-dot";

      const text = document.createElement("div");
      text.className = "conn-text";
      const name = document.createElement("div");
      name.className = "conn-name";
      name.textContent = c.name;
      const sub = document.createElement("div");
      sub.className = "conn-sub";
      sub.textContent = c.user + "@" + c.host + ":" + c.port;
      text.appendChild(name);
      text.appendChild(sub);

      li.appendChild(dot);
      li.appendChild(text);
      li.addEventListener("click", function () {
        selectConnection(c.id);
      });
      listEl.appendChild(li);
    });
  }

  function fillForm(c) {
    fId.value = c ? c.id : "";
    fName.value = c ? c.name : "";
    fHost.value = c ? c.host : "127.0.0.1";
    fPort.value = c ? String(c.port) : "3306";
    fUser.value = c ? c.user : "root";
    fPassword.value = "";
    fSchema.value = c ? c.defaultSchema : "";
    // Editing an existing row: password blank = keep stored secret.
    passwordUntouched = !!c;
    fPassword.placeholder = c ? "•••••••• (unchanged)" : "";
    deleteBtn.style.display = c ? "" : "none";
    saveBtn.textContent = c ? "Save" : "Create";
    const title = document.getElementById("form-title");
    if (title) {
      title.textContent = c ? "Edit Connection" : "New Connection";
    }
  }

  function selectConnection(id) {
    selectedId = id;
    const c = connections.find(function (x) {
      return x.id === id;
    });
    fillForm(c || null);
    renderList();
    setStatus("");
  }

  function startNew() {
    selectedId = null;
    fillForm(null);
    renderList();
    setStatus("");
    fName.focus();
  }

  function collectForm() {
    return {
      id: fId.value || null,
      name: fName.value,
      host: fHost.value,
      port: fPort.value,
      user: fUser.value,
      password: fPassword.value,
      passwordUnchanged: passwordUntouched && fPassword.value === "",
      defaultSchema: fSchema.value,
    };
  }

  fPassword.addEventListener("input", function () {
    passwordUntouched = false;
  });

  newBtn.addEventListener("click", startNew);

  testBtn.addEventListener("click", function () {
    setStatus("Testing…", "pending");
    vscode.postMessage({ type: "test", form: collectForm() });
  });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    setStatus("Saving…", "pending");
    vscode.postMessage({ type: "save", form: collectForm() });
  });

  deleteBtn.addEventListener("click", function () {
    if (fId.value) {
      vscode.postMessage({ type: "delete", id: fId.value });
    }
  });

  window.addEventListener("message", function (event) {
    const msg = event.data;
    if (msg.type === "list") {
      connections = msg.connections;
      selectedId = msg.selectedId;
      renderList();
      const c = connections.find(function (x) {
        return x.id === selectedId;
      });
      if (c) {
        fillForm(c);
      } else if (connections.length === 0) {
        startNew();
      }
      return;
    }
    if (msg.type === "testResult") {
      setStatus(msg.message, msg.ok ? "ok" : "error");
      return;
    }
    if (msg.type === "saved") {
      setStatus("Saved.", "ok");
      selectedId = msg.id;
      passwordUntouched = true;
      fPassword.value = "";
      return;
    }
    if (msg.type === "deleted") {
      setStatus("Deleted.", "ok");
      return;
    }
  });

  vscode.postMessage({ type: "ready" });
})();
