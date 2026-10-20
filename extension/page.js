const api = globalThis.browser || globalThis.chrome;

const FILE_EXTENSIONS = new Set([
  "7z", "aac", "apk", "azw3", "bin", "bz2", "cbz", "cbr", "deb", "dmg",
  "doc", "docx", "epub", "exe", "flac", "gz", "img", "ipa", "iso", "m4a",
  "m4b", "mkv", "mov", "mp3", "mp4", "msi", "ogg", "pdf", "pkg", "ppt",
  "pptx", "rar", "rpm", "tar", "tgz", "torrent", "wav", "webm", "xls",
  "xlsx", "xz", "zip"
]);

let inspectLinks = false;
let paused = false;

function loadPrefs() {
  api.storage.local.get({ inspectLinks: false, paused: false }, (values) => {
    inspectLinks = !!values.inspectLinks;
    paused = !!values.paused;
  });
}

loadPrefs();
api.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.inspectLinks) inspectLinks = !!changes.inspectLinks.newValue;
  if (changes.paused) paused = !!changes.paused.newValue;
});

function absoluteUrl(href) {
  try {
    return new URL(href, location.href).href;
  } catch (error) {
    return "";
  }
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

function isCandidate(anchor, url) {
  if (!url) return false;
  if (url.startsWith("magnet:") || url.startsWith("ftp:")) return true;
  if (!/^https?:/i.test(url)) return false;
  if (anchor && anchor.hasAttribute("download")) return true;
  if (FILE_EXTENSIONS.has(extensionOf(url))) return true;
  return inspectLinks;
}

function shouldIgnoreClick(event) {
  if (paused) return true;
  if (event.defaultPrevented) return true;
  if (event.button !== 0) return true;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return true;
  return false;
}

function followNormally(anchor, url) {
  const target = anchor.getAttribute("target");
  if (target && target !== "_self") {
    window.open(url, target);
    return;
  }
  location.assign(url);
}

document.addEventListener("click", (event) => {
  if (shouldIgnoreClick(event)) return;
  const anchor = event.target && event.target.closest ? event.target.closest("a[href]") : null;
  if (!anchor) return;
  const url = absoluteUrl(anchor.getAttribute("href"));
  if (!isCandidate(anchor, url)) return;

  event.preventDefault();
  event.stopPropagation();

  api.runtime.sendMessage({
    type: "download-link",
    url,
    referrer: location.href,
    documentUrl: location.href,
    filename: anchor.getAttribute("download") || "",
    downloadAttr: anchor.hasAttribute("download"),
    caught: true
  }, (response) => {
    const failed = api.runtime.lastError || !response || !response.handled;
    if (failed) followNormally(anchor, url);
  });
}, true);

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "collect-links") return false;
  if (window.top !== window) return false;
  const links = [];
  const seen = new Set();
  for (const anchor of document.querySelectorAll("a[href]")) {
    const url = absoluteUrl(anchor.getAttribute("href"));
    if (!url || seen.has(url)) continue;
    if (!/^(https?|ftp|magnet):/i.test(url)) continue;
    seen.add(url);
    links.push(url);
  }
  sendResponse({ links, pageUrl: location.href });
  return false;
});
