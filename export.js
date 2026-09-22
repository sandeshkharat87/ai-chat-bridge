// export.js
// Runs as a real extension page (chrome-extension://.../export.html), so
// window.print() here is never subject to popup-blocker gesture rules —
// that's specifically why the export flow now opens this page via
// chrome.tabs.create() instead of calling window.open() from the content
// script (which was getting silently blocked after the async auto-scroll,
// causing the blank PDF).

const STORAGE_KEY = "handoffExportPayload";

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

async function render() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const payload = data[STORAGE_KEY];

  if (!payload) {
    document.getElementById("content").textContent =
      "No conversation data was found. Close this tab and click 'Export PDF' from the extension popup again.";
    return;
  }

  document.getElementById("title").textContent = payload.title || "Conversation export";
  document.getElementById("meta").textContent = payload.metaLine || "";
  document.getElementById("content").innerHTML = payload.bodyHtml || "<em>(empty)</em>";
  document.getElementById("content").classList.remove("handoff-loading");

  // Clear it so a stale export can't accidentally get reused.
  chrome.storage.local.remove(STORAGE_KEY);

  // Let images/layout settle, then open the print dialog automatically.
  setTimeout(() => window.print(), 400);
}

document.getElementById("printNowBtn").addEventListener("click", () => window.print());

render();
