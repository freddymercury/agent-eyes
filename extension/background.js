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

function startElementPicker() {
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

// ---- wiring ----

chrome.commands.onCommand.addListener((command) => {
  if (command === "send-page") sendCurrentTab();
  if (command === "pick-element") activatePicker();
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
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === "agenteyes-send-page") sendCurrentTab(tab.id);
  if (info.menuItemId === "agenteyes-pick-element") activatePicker(tab.id);
});
