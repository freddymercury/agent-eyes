const BRIDGE_URL = "http://localhost:8765/context";

// ---- full page / selection capture (unchanged behavior) ----

function extractPageContent() {
  const selection = window.getSelection().toString().trim();
  const text = selection.length > 0 ? selection : document.body.innerText;
  return {
    title: document.title,
    url: location.href,
    usedSelection: selection.length > 0,
    text: text.slice(0, 200000)
  };
}

// ---- element picker: hover to highlight, click to capture ----
// Injected on demand. Talks back to the background script via
// chrome.runtime.sendMessage since executeScript can't return values
// from an interactive/async flow like this.

function startElementPicker(mode) {
  if (window.__agenteyesPickerActive) return;
  window.__agenteyesPickerActive = true;

  const overlay = document.createElement("div");
  overlay.style.cssText =
    "position:fixed;pointer-events:none;z-index:2147483647;" +
    "border:2px solid #4FD8C4;background:rgba(79,216,196,0.15);" +
    "display:none;box-sizing:border-box;";
  document.documentElement.appendChild(overlay);

  const label = document.createElement("div");
  label.style.cssText =
    "position:fixed;pointer-events:none;z-index:2147483647;" +
    "background:#12141A;color:#4FD8C4;font:11px monospace;" +
    "padding:2px 6px;border-radius:4px;display:none;white-space:nowrap;";
  document.documentElement.appendChild(label);

  let currentEl = null;

  function describeEl(el) {
    const cls =
      typeof el.className === "string" && el.className.trim()
        ? "." + el.className.trim().split(/\s+/).join(".")
        : "";
    const id = el.id ? "#" + el.id : "";
    return el.tagName.toLowerCase() + id + cls;
  }

  function onMove(e) {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === currentEl || el === overlay || el === label) return;
    currentEl = el;
    const r = el.getBoundingClientRect();
    overlay.style.display = "block";
    overlay.style.left = r.left + "px";
    overlay.style.top = r.top + "px";
    overlay.style.width = r.width + "px";
    overlay.style.height = r.height + "px";
    label.style.display = "block";
    label.style.left = r.left + "px";
    label.style.top = Math.max(0, r.top - 20) + "px";
    label.textContent = describeEl(el);
  }

  function cleanup() {
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
    label.remove();
    window.__agenteyesPickerActive = false;
  }

  function onClick(e) {
    e.preventDefault();
    e.stopPropagation();
    if (currentEl && mode === "watch") {
      // Register a repeating watcher instead of sending once. Ask for a label
      // so several watchers on the same page stay tellable apart.
      const suggested = describeEl(currentEl).slice(0, 40);
      const label = window.prompt("Label for this watcher:", suggested) || suggested;
      const added = window.__agentEyes && window.__agentEyes.add(currentEl, label);
      chrome.runtime.sendMessage({ type: "agenteyes-watcher-added", data: added });
      cleanup();
      return;
    }
    if (currentEl) {
      const attrs = {};
      for (const a of currentEl.attributes) attrs[a.name] = a.value;
      chrome.runtime.sendMessage({
        type: "agenteyes-element-picked",
        data: {
          title: document.title,
          url: location.href,
          elementPicked: true,
          tag: currentEl.tagName.toLowerCase(),
          attrs,
          text: (currentEl.innerText || "").slice(0, 20000),
          outerHTML: currentEl.outerHTML.slice(0, 20000)
        }
      });
    }
    cleanup();
  }

  function onKey(e) {
    if (e.key === "Escape") cleanup();
  }

  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKey, true);
}

// ---- watch kit: multiple named element watchers, each diffed independently ----
//
// Installed once per tab. Keeps a registry on window so it survives service
// worker eviction — the interval must live in the page, not the worker, since
// MV3 workers are evicted when idle and chrome.alarms floors at 30s.

function installWatchKit(bridgeUrl, intervalMs) {
  if (window.__agentEyes) return true;

  // A selector we can re-query every tick. Frameworks replace nodes on
  // re-render, so holding a raw element reference goes stale; the path
  // survives that, and we fall back to the original node if it doesn't match.
  function cssPath(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 12) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift(part + "#" + CSS.escape(node.id));
        break;
      }
      const parent = node.parentElement;
      if (parent) {
        const sibs = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (sibs.length > 1) part += ":nth-of-type(" + (sibs.indexOf(node) + 1) + ")";
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(" > ");
  }

  function hash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return h;
  }

  const registry = {
    bridgeUrl,
    intervalMs,
    nextId: 1,
    watchers: new Map(),

    add(el, label) {
      const id = "w" + registry.nextId++;
      const selector = cssPath(el);
      const w = {
        id,
        label: label || (el.tagName.toLowerCase() + (el.id ? "#" + el.id : "")),
        selector,
        el,
        last: null,
        sent: 0,
        failed: 0,
        // Monotonic per watcher, so a consumer can tell a genuine change from
        // an identical re-send after a restart.
        revision: 0,
        timer: null
      };
      w.timer = setInterval(() => registry.tick(id), registry.intervalMs);
      registry.watchers.set(id, w);
      registry.tick(id);
      return { id: w.id, label: w.label, selector: w.selector };
    },

    remove(id) {
      const w = registry.watchers.get(id);
      if (!w) return false;
      clearInterval(w.timer);
      registry.watchers.delete(id);
      // Tombstone, so consumers retire the watcher immediately instead of
      // waiting for it to look stale — those are different situations.
      registry.tombstone(w);
      return true;
    },

    tombstone(w) {
      try {
        fetch(registry.bridgeUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            watchId: w.id,
            label: w.label,
            removed: true,
            capturedAt: new Date().toISOString()
          })
        });
      } catch (err) {
        /* removal is best-effort; the watcher is already stopped */
      }
    },

    clear() {
      for (const id of Array.from(registry.watchers.keys())) registry.remove(id);
      return true;
    },

    list() {
      return Array.from(registry.watchers.values()).map((w) => ({
        id: w.id,
        label: w.label,
        selector: w.selector,
        sent: w.sent,
        failed: w.failed,
        alive: !!registry.resolve(w)
      }));
    },

    resolve(w) {
      let el = null;
      try {
        el = w.selector ? document.querySelector(w.selector) : null;
      } catch (err) {
        el = null;
      }
      if (!el && w.el && w.el.isConnected) el = w.el;
      return el;
    },

    async tick(id) {
      const w = registry.watchers.get(id);
      if (!w) return;
      const el = registry.resolve(w);
      if (!el) {
        // The element was re-rendered away. Report it once rather than going
        // quiet, which is indistinguishable from a page that just isn't changing.
        if (w.last !== null) {
          w.last = null;
          registry.report(w, "", false);
        }
        return;
      }
      const text = el.innerText || "";
      const h = hash(text);
      if (h === w.last) return;
      w.last = h;
      await registry.report(w, text, true);
    },

    async report(w, text, alive) {
      w.revision++;
      try {
        const res = await fetch(registry.bridgeUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: document.title,
            url: location.href,
            autoWatch: true,
            watchId: w.id,
            label: w.label,
            elementPicked: true,
            selector: w.selector,
            alive,
            revision: w.revision,
            text: text.slice(0, 200000),
            capturedAt: new Date().toISOString()
          })
        });
        res.ok ? w.sent++ : w.failed++;
      } catch (err) {
        w.failed++;
      }
    }
  };

  window.__agentEyes = registry;
  return true;
}

function watchKitCall(method, arg) {
  const r = window.__agentEyes;
  if (!r) return { ok: false, error: "watch kit not installed" };
  if (method === "list") return { ok: true, watchers: r.list() };
  if (method === "remove") return { ok: r.remove(arg), watchers: r.list() };
  if (method === "clear") return { ok: r.clear(), watchers: [] };
  return { ok: false, error: "unknown method " + method };
}

// ---- shared send + badge feedback ----

function flashBadge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 1200);
}

async function postToBridge(payload) {
  try {
    const res = await fetch(BRIDGE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    flashBadge(res.ok ? "\u2713" : "!", res.ok ? "#4FD8C4" : "#E5484D");
    return { ok: res.ok };
  } catch (err) {
    // Most common cause: the local server isn't running.
    console.error("AgentEyes: failed to send —", err);
    flashBadge("!", "#E5484D");
    return { ok: false, error: String(err) };
  }
}

async function sendCurrentTab(tabId) {
  const tab = tabId
    ? { id: tabId }
    : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!tab || !tab.id) {
    flashBadge("!", "#E5484D");
    return { ok: false };
  }

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: extractPageContent
  });

  return postToBridge({ ...result, capturedAt: new Date().toISOString() });
}

async function activatePicker(tabId) {
  const tab = tabId
    ? { id: tabId }
    : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!tab || !tab.id) {
    flashBadge("!", "#E5484D");
    return;
  }

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: startElementPicker
  });
}

const WATCH_INTERVAL_MS = 5000;

async function resolveTab(tabId) {
  const tab = tabId
    ? { id: tabId }
    : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  return tab && tab.id ? tab : null;
}

async function ensureKit(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: installWatchKit,
    args: [BRIDGE_URL, WATCH_INTERVAL_MS]
  });
}

/** Start the picker in "watch" mode: the clicked element becomes a watcher. */
async function addWatchTarget(tabId) {
  const tab = await resolveTab(tabId);
  if (!tab) return { ok: false };
  await ensureKit(tab.id);
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: startElementPicker,
    args: ["watch"]
  });
  return { ok: true };
}

async function watchKit(tabId, method, arg) {
  const tab = await resolveTab(tabId);
  if (!tab) return { ok: false, watchers: [] };
  await ensureKit(tab.id);
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: watchKitCall,
    args: [method, arg ?? null]
  });
  const n = result && result.watchers ? result.watchers.length : 0;
  chrome.action.setBadgeText({ text: n ? String(n) : "" });
  chrome.action.setBadgeBackgroundColor({ color: "#4FD8C4" });
  return result || { ok: false, watchers: [] };
}

// ---- wiring ----

chrome.commands.onCommand.addListener((command) => {
  if (command === "send-page") sendCurrentTab();
  if (command === "pick-element") activatePicker();
  if (command === "toggle-watch") addWatchTarget();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "agenteyes-element-picked") {
    postToBridge({ ...message.data, capturedAt: new Date().toISOString() });
    return; // no response expected here — sender is the content script
  }

  if (message?.type === "agenteyes-popup-send-page") {
    sendCurrentTab().then((result) => sendResponse(result));
    return true; // keep the message channel open for the async response
  }

  if (message?.type === "agenteyes-watcher-added") {
    chrome.action.setBadgeText({ text: "\u25CF" });
    chrome.action.setBadgeBackgroundColor({ color: "#4FD8C4" });
    return;
  }

  if (message?.type === "agenteyes-popup-add-watch") {
    addWatchTarget().then((result) => sendResponse(result));
    return true;
  }

  if (message?.type === "agenteyes-popup-list-watch") {
    watchKit(null, "list").then((result) => sendResponse(result));
    return true;
  }

  if (message?.type === "agenteyes-popup-remove-watch") {
    watchKit(null, "remove", message.id).then((result) => sendResponse(result));
    return true;
  }

  if (message?.type === "agenteyes-popup-clear-watch") {
    watchKit(null, "clear").then((result) => sendResponse(result));
    return true;
  }

  if (message?.type === "agenteyes-popup-pick-element") {
    activatePicker().then(() => sendResponse({ ok: true }));
    return true;
  }
});

// Right-click menu — same two actions, available wherever your cursor is.
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "agenteyes-send-page",
    title: "AgentEyes: send this page",
    contexts: ["all"]
  });
  chrome.contextMenus.create({
    id: "agenteyes-pick-element",
    title: "AgentEyes: pick an element\u2026",
    contexts: ["all"]
  });
  chrome.contextMenus.create({
    id: "agenteyes-toggle-watch",
    title: "AgentEyes: watch this element\u2026",
    contexts: ["all"]
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === "agenteyes-send-page") sendCurrentTab(tab.id);
  if (info.menuItemId === "agenteyes-pick-element") activatePicker(tab.id);
  if (info.menuItemId === "agenteyes-toggle-watch") addWatchTarget(tab.id);
});
