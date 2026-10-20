const api = globalThis.browser || globalThis.chrome;

const HOST_PATH_MESSAGE = "native";
const FILE_EXTENSIONS = new Set([
  "7z", "aac", "apk", "azw3", "bin", "bz2", "cbz", "cbr", "deb", "dmg",
  "doc", "docx", "epub", "exe", "flac", "gz", "img", "ipa", "iso", "m4a",
  "m4b", "mkv", "mov", "mp3", "mp4", "msi", "ogg", "pdf", "pkg", "ppt",
  "pptx", "rar", "rpm", "tar", "tgz", "torrent", "wav", "webm", "xls",
  "xlsx", "xz", "zip"
]);

const state = {
  ready: null,
  connected: false,
  error: "",
  version: "",
  settings: null,
  strings: {
    dllink: "Download with FDM",
    dlall: "Download all with FDM",
    dlselected: "Download selected with FDM",
    dlvideo: "Download video with FDM",
    dlpage: "Download page with FDM"
  },
  nextId: 1,
  keyPressed: false,
  paused: false,
  inspectLinks: false
};

function prefs() {
  return new Promise((resolve) => {
    api.storage.local.get({ paused: false, inspectLinks: false }, resolve);
  });
}

function host(message) {
  return new Promise((resolve) => {
    try {
      const result = api.runtime.sendNativeMessage(HOST_PATH_MESSAGE, message, (response) => {
        if (api.runtime.lastError) {
          resolve({ error: api.runtime.lastError.message || "native messaging failed" });
          return;
        }
        resolve(response || { error: "empty response" });
      });
      if (result && typeof result.then === "function") {
        result.then(resolve).catch((error) => {
          resolve({ error: error && error.message ? error.message : String(error) });
        });
      }
    } catch (error) {
      resolve({ error: error && error.message ? error.message : String(error) });
    }
  });
}

function task(type, extra) {
  const message = Object.assign({ id: String(state.nextId++), type }, extra || {});
  return host(message);
}

async function connect() {
  const handshake = await task("handshake", {
    handshake: { api_version: "1", browser: "Safari" }
  });
  if (!handshake || handshake.error) {
    state.connected = false;
    state.error = (handshake && handshake.error) || "Free Download Manager did not answer.";
    state.version = "";
    return false;
  }
  state.connected = true;
  state.error = "";
  state.version = handshake.version || "";
  const [settings, strings] = await Promise.all([
    task("query_settings"),
    task("ui_strings")
  ]);
  if (settings && settings.settings) state.settings = settings.settings;
  if (strings && strings.strings) {
    state.strings = Object.assign(state.strings, strings.strings);
  }
  await rebuildMenus();
  updateBadge();
  return true;
}

function ensureConnected() {
  if (!state.ready) state.ready = connect();
  return state.ready;
}

function updateBadge() {
  const text = state.connected ? "" : "!";
  if (api.action && api.action.setBadgeText) {
    api.action.setBadgeText({ text });
    if (api.action.setBadgeBackgroundColor) {
      api.action.setBadgeBackgroundColor({ color: "#b42318" });
    }
  }
}

function monitor() {
  return (state.settings && state.settings.browser && state.settings.browser.monitor) || {};
}

function menuFlags() {
  const menu = (state.settings && state.settings.browser && state.settings.browser.menu) || {};
  const on = (value, fallback) => (value === undefined ? fallback : value !== "0");
  return {
    dllink: on(menu.dllink, true),
    dlall: on(menu.dlall, true),
    dlselected: on(menu.dlselected, true),
    dlvideo: on(menu.dlvideo, true),
    dlpage: on(menu.dlpage, false)
  };
}

function hostFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch (error) {
    return "";
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function skipHosts() {
  const raw = monitor().skipServers || "";
  return String(raw).trim().toLowerCase().split(/\s+/).filter(Boolean);
}

function urlSkipped(url) {
  if (monitor().skipServersEnabled === "0") return false;
  const hostName = hostFromUrl(url);
  if (!hostName) return false;
  return skipHosts().some((entry) => {
    const pattern = new RegExp("^(?:[\\w-]+\\.)*" + escapeRegExp(entry) + "$", "i");
    return pattern.test(hostName);
  });
}

function extensionOf(url) {
  try {
    const base = new URL(url).pathname.split("/").pop() || "";
    const match = base.match(/\.([A-Za-z0-9]{1,8})$/);
    return match ? match[1].toLowerCase() : "";
  } catch (error) {
    return "";
  }
}

function extensionSkipped(url) {
  const ext = extensionOf(url);
  if (!ext) return false;
  const skip = String(monitor().skipExtensions || "").toLowerCase();
  if (!skip) return false;
  return skip.split(/\s+/).some((item) => item === ext || item === "." + ext);
}

async function cookiesFor(url) {
  if (!api.cookies || !api.cookies.getAll) return "";
  try {
    const cookies = await api.cookies.getAll({ url });
    return (cookies || []).map((cookie) => cookie.name + "=" + cookie.value).join("; ");
  } catch (error) {
    return "";
  }
}

async function sendDownloads(urls, pageUrl, caught) {
  await ensureConnected();
  if (!state.connected) return { error: state.error || "not connected" };
  const downloads = [];
  for (const url of urls) {
    downloads.push({
      url,
      originalUrl: url,
      httpReferer: pageUrl || "",
      documentUrl: pageUrl || "",
      httpPostData: "",
      userAgent: navigator.userAgent,
      httpCookies: await cookiesFor(url)
    });
  }
  const create = { downloads };
  if (caught) {
    create.catchedDownloads = "1";
    create.waitResponse = "1";
  }
  return task("create_downloads", { create_downloads: create });
}

function accepted(response) {
  if (!response || response.error) return false;
  return response.result !== "0";
}

async function policyAllows(url) {
  const values = await prefs();
  state.paused = !!values.paused;
  state.inspectLinks = !!values.inspectLinks;
  if (state.paused) return false;
  if (state.keyPressed && monitor().skipIfKeyPressed !== "0") return false;
  if (urlSkipped(url) || extensionSkipped(url)) return false;
  return true;
}

async function maybeInspect(url) {
  if (FILE_EXTENSIONS.has(extensionOf(url))) return true;
  if (/^(magnet|ftp):/i.test(url)) return true;
  if (!state.inspectLinks) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(url, {
      method: "HEAD",
      credentials: "include",
      redirect: "follow",
      signal: controller.signal
    });
    const disposition = response.headers.get("content-disposition") || "";
    if (/attachment/i.test(disposition)) return true;
    const type = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!type || type.startsWith("text/html") || type.startsWith("application/xhtml")) return false;
    const shown = ["text/", "image/", "font/", "application/javascript", "text/javascript", "application/json", "application/xml"];
    if (shown.some((prefix) => type.startsWith(prefix))) return false;
    return true;
  } catch (error) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function downloadLink(message) {
  const url = message.url;
  if (!url) return { handled: false };
  await pollKey();
  if (!(await policyAllows(url))) return { handled: false };
  const direct = FILE_EXTENSIONS.has(extensionOf(url)) || /^(magnet|ftp):/i.test(url) || !!message.downloadAttr;
  if (message.caught && !direct && !(await maybeInspect(url))) return { handled: false };
  const response = await sendDownloads([url], message.referrer || message.documentUrl || "", !!message.caught);
  if (!accepted(response)) {
    notify(response && response.error ? response.error : "Free Download Manager did not accept this download.");
    return { handled: false, error: response && response.error };
  }
  return { handled: true };
}

function notify(message) {
  if (!api.notifications || !api.notifications.create) return;
  try {
    api.notifications.create({
      type: "basic",
      iconUrl: "icons/icon-128.png",
      title: "FDM for Safari",
      message
    });
  } catch (error) {
    console.log(message);
  }
}

function urlsInText(text) {
  if (!text) return [];
  const found = text.match(/((https?|ftp):\/\/[^\s<>"']+|magnet:\?[^\s<>"']+)/gi) || [];
  return [...new Set(found)];
}

async function currentTab() {
  const tabs = await api.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs[0];
}

async function rebuildMenus() {
  const flags = menuFlags();
  const strings = state.strings;
  await new Promise((resolve) => api.contextMenus.removeAll(resolve));
  const items = [];
  if (flags.dllink) {
    items.push({ id: "fdm-link", title: strings.dllink || "Download with FDM", contexts: ["link"] });
    items.push({ id: "fdm-image", title: strings.dllink || "Download with FDM", contexts: ["image"] });
  }
  if (flags.dlvideo) {
    items.push({ id: "fdm-video", title: strings.dlvideo || "Download video with FDM", contexts: ["video", "audio"] });
  }
  if (flags.dlselected) {
    items.push({ id: "fdm-selection", title: strings.dlselected || "Download selected with FDM", contexts: ["selection"] });
  }
  if (flags.dlall) {
    items.push({ id: "fdm-all", title: strings.dlall || "Download all with FDM", contexts: ["page"] });
  }
  if (flags.dlpage) {
    items.push({ id: "fdm-page", title: strings.dlpage || "Download page with FDM", contexts: ["page"] });
  }
  for (const item of items) api.contextMenus.create(item);
}

api.contextMenus.onClicked.addListener(async (info, tab) => {
  const pageUrl = (tab && tab.url) || info.pageUrl || "";
  if (info.menuItemId === "fdm-link" && info.linkUrl) {
    await downloadLink({ url: info.linkUrl, referrer: pageUrl, caught: false });
  } else if ((info.menuItemId === "fdm-image" || info.menuItemId === "fdm-video") && info.srcUrl) {
    await downloadLink({ url: info.srcUrl, referrer: pageUrl, caught: false });
  } else if (info.menuItemId === "fdm-selection") {
    const urls = urlsInText(info.selectionText);
    if (!urls.length) {
      notify("The selection does not contain a link.");
      return;
    }
    const response = await sendDownloads(urls, pageUrl, false);
    if (!accepted(response)) notify("Free Download Manager did not accept these links.");
  } else if (info.menuItemId === "fdm-page") {
    await downloadLink({ url: pageUrl, referrer: pageUrl, caught: false });
  } else if (info.menuItemId === "fdm-all" && tab) {
    let links = [];
    try {
      const collected = await api.tabs.sendMessage(tab.id, { type: "collect-links" });
      links = (collected && collected.links) || [];
    } catch (error) {
      links = [];
    }
    if (!links.length) {
      notify("No links were found on this page.");
      return;
    }
    const response = await sendDownloads(links, pageUrl, false);
    if (!accepted(response)) notify("Free Download Manager did not accept these links.");
  }
});

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return false;
  handleMessage(message, sender).then(sendResponse).catch((error) => {
    sendResponse({ handled: false, error: error.message || String(error) });
  });
  return true;
});

async function handleMessage(message, sender) {
  if (message.type === "download-link") return downloadLink(message);
  if (message.type === "get-status") return statusForPopup();
  if (message.type === "reconnect") {
    state.ready = null;
    await ensureConnected();
    return statusForPopup();
  }
  if (message.type === "toggle-skip-site") {
    await toggleSkipSite();
    return statusForPopup();
  }
  if (message.type === "download-page") {
    const tab = await currentTab();
    if (!tab || !tab.url) return { handled: false };
    return downloadLink({ url: tab.url, referrer: tab.url, caught: false });
  }
  return { handled: false };
}

async function statusForPopup() {
  await ensureConnected();
  const values = await prefs();
  const tab = await currentTab();
  const pageUrl = tab && /^https?:/i.test(tab.url || "") ? tab.url : "";
  return {
    connected: state.connected,
    error: state.error,
    version: state.version,
    paused: !!values.paused,
    inspectLinks: !!values.inspectLinks,
    pageUrl,
    pageSkipped: pageUrl ? urlSkipped(pageUrl) : false
  };
}

async function toggleSkipSite() {
  await ensureConnected();
  if (!state.settings) return;
  const tab = await currentTab();
  if (!tab || !tab.url) return;
  const hostName = hostFromUrl(tab.url);
  if (!hostName) return;
  const hosts = skipHosts();
  const exists = urlSkipped(tab.url);
  const next = exists ? hosts.filter((entry) => entry !== hostName) : hosts.concat([hostName]);
  state.settings.browser.monitor.skipServers = next.join(" ");
  state.settings.browser.monitor.skipServersEnabled = "1";
  const response = await task("post_settings", { post_settings: state.settings });
  if (response && response.error) {
    notify(response.error);
    return;
  }
  const refreshed = await task("query_settings");
  if (refreshed && refreshed.settings) state.settings = refreshed.settings;
}

async function pollKey() {
  if (!state.connected) return;
  if (monitor().skipIfKeyPressed === "0") {
    state.keyPressed = false;
    return;
  }
  const response = await task("key_state");
  if (response && !response.error) state.keyPressed = !!response.pressed;
}

api.runtime.onInstalled.addListener(() => {
  state.ready = null;
  ensureConnected();
});

ensureConnected();
