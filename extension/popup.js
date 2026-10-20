const api = globalThis.browser || globalThis.chrome;

const statusEl = document.getElementById("status");
const pausedEl = document.getElementById("paused");
const inspectEl = document.getElementById("inspect");
const skipEl = document.getElementById("skip");
const pageEl = document.getElementById("page");
const retryEl = document.getElementById("retry");

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = kind || "";
}

function refresh() {
  api.runtime.sendMessage({ type: "get-status" }, (status) => {
    if (api.runtime.lastError || !status) {
      setStatus("The extension background is not running.", "bad");
      return;
    }
    pausedEl.checked = !!status.paused;
    inspectEl.checked = !!status.inspectLinks;
    skipEl.textContent = status.pageSkipped ? "Catch this site again" : "Don’t catch this site";
    skipEl.disabled = !status.connected || !status.pageUrl;
    pageEl.disabled = !status.connected || !status.pageUrl;
    if (status.connected) {
      setStatus("Connected to Free Download Manager " + (status.version || ""), "ok");
    } else {
      setStatus(status.error || "Free Download Manager is not connected.", "bad");
    }
  });
}

pausedEl.addEventListener("change", () => {
  api.storage.local.set({ paused: pausedEl.checked });
});

inspectEl.addEventListener("change", () => {
  api.storage.local.set({ inspectLinks: inspectEl.checked });
});

skipEl.addEventListener("click", () => {
  skipEl.disabled = true;
  api.runtime.sendMessage({ type: "toggle-skip-site" }, refresh);
});

pageEl.addEventListener("click", () => {
  pageEl.disabled = true;
  api.runtime.sendMessage({ type: "download-page" }, () => window.close());
});

retryEl.addEventListener("click", () => {
  setStatus("Reconnecting…");
  api.runtime.sendMessage({ type: "reconnect" }, refresh);
});

refresh();
