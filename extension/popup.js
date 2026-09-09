const status = document.getElementById("status");

function setStatus(text, kind) {
  status.textContent = text;
  status.className = kind || "";
}

document.getElementById("send-page").addEventListener("click", async () => {
  setStatus("sending…");
  const res = await chrome.runtime.sendMessage({ type: "agenteyes-popup-send-page" });
  if (res?.ok) {
    setStatus("sent ✓", "ok");
    setTimeout(() => window.close(), 500);
  } else {
    setStatus("failed — is the server running?", "err");
  }
});

document.getElementById("pick-element").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "agenteyes-popup-pick-element" });
  // Picker mode is now active on the page itself — nothing more to show here.
  window.close();
});

document.getElementById("add-watch").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "agenteyes-popup-add-watch" });
  // Picker is now live on the page; the popup must close for the click to land.
  window.close();
});

document.getElementById("scan-surface").addEventListener("click", async () => {
  setStatus("scanning\u2026");
  const res = await chrome.runtime.sendMessage({ type: "agenteyes-popup-scan-surface" });
  if (!res?.ok) {
    setStatus("failed — is the server running?", "err");
    return;
  }
  const s = res.stats || {};
  setStatus(`${s.actionsFound} actions, ${s.durationMs}ms${s.truncated ? " (truncated)" : ""}`, "ok");
});

document.getElementById("save-snapshot").addEventListener("click", async () => {
  const { suggestion } = await chrome.runtime.sendMessage({ type: "agenteyes-popup-suggest-name" });
  const name = window.prompt("Name this snapshot:", suggestion || "snapshot");
  if (!name) return;
  const version = window.prompt("Release version (optional):", "") || undefined;
  setStatus("scanning and saving\u2026");
  const res = await chrome.runtime.sendMessage({
    type: "agenteyes-popup-save-snapshot",
    name,
    release: version ? { version } : undefined
  });
  if (!res?.ok) {
    setStatus("failed — is the server running?", "err");
    return;
  }
  showSaved(res);
  const h = res.health || {};
  // Surface the qualities that decide whether a later diff is trustworthy,
  // while the user can still do something about it.
  const warn = h.positionalRate > 0.25 || h.ordinalRate > 0.3 || h.truncated;
  setStatus(
    `saved · ${h.actions} actions` +
      (warn ? ` · unstable ids ${Math.round((h.ordinalRate || 0) * 100)}%` : ""),
    warn ? "" : "ok"
  );
});

function showSaved(res) {
  const box = document.getElementById("saved");
  const path = document.getElementById("saved-path");
  if (!res.path) return;
  path.textContent = res.path;
  box.style.display = "block";

  const copy = async () => {
    await navigator.clipboard.writeText(res.path);
    setStatus("path copied", "ok");
  };
  path.onclick = copy;
  document.getElementById("saved-copy").onclick = copy;
  // Open the http URL rather than file://, which Chrome blocks from an
  // extension unless the user has granted file access.
  document.getElementById("saved-open").onclick = () => chrome.tabs.create({ url: res.url });
}

function renderWatchers(watchers) {
  const box = document.getElementById("watchers");
  const clear = document.getElementById("clear");
  box.innerHTML = "";
  if (!watchers || !watchers.length) {
    box.innerHTML = '<div class="empty">none yet</div>';
    clear.style.display = "none";
    return;
  }
  clear.style.display = "flex";
  for (const w of watchers) {
    const row = document.createElement("div");
    row.className = "w";

    const dot = document.createElement("span");
    // A dead dot means the selector no longer matches — the page re-rendered
    // that element away, so re-pick it.
    dot.className = "dot" + (w.alive ? "" : " dead");
    row.appendChild(dot);

    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = w.label;
    nm.title = w.selector;
    row.appendChild(nm);

    const ct = document.createElement("span");
    ct.className = "ct";
    ct.textContent = w.sent + (w.failed ? "/" + w.failed + "!" : "");
    row.appendChild(ct);

    const x = document.createElement("button");
    x.className = "x";
    x.textContent = "\u00d7";
    x.title = "remove";
    x.addEventListener("click", async () => {
      const res = await chrome.runtime.sendMessage({
        type: "agenteyes-popup-remove-watch",
        id: w.id
      });
      renderWatchers(res && res.watchers);
    });
    row.appendChild(x);

    box.appendChild(row);
  }
}

document.getElementById("clear").addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ type: "agenteyes-popup-clear-watch" });
  renderWatchers(res && res.watchers);
});

(async () => {
  const res = await chrome.runtime.sendMessage({ type: "agenteyes-popup-list-watch" });
  renderWatchers(res && res.watchers);
})();
