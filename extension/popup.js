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
