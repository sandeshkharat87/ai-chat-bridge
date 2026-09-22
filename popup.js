const statusEl = document.getElementById("status");
const summaryBox = document.getElementById("summaryBox");
const copyBtn = document.getElementById("copyBtn");
const summarizeBtn = document.getElementById("summarizeBtn");
const exportBtn = document.getElementById("exportBtn");
const modelInput = document.getElementById("model");

function setStatus(text, isError) {
  statusEl.textContent = text || "";
  statusEl.classList.toggle("error", !!isError);
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Sends a message to the content script in `tabId`. If the content script
// hasn't been injected yet (classic cause: the tab was already open before
// the extension was loaded/reloaded, so the declarative content_scripts
// entry never ran on it) this injects it on the fly with
// chrome.scripting.executeScript and retries once, instead of surfacing
// "Could not establish connection. Receiving end does not exist."
async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (err) {
    const msg = String(err && err.message || err);
    if (!/Receiving end does not exist|Could not establish connection/i.test(msg)) {
      throw err;
    }
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    } catch (injectErr) {
      throw new Error(
        "Can't run on this page (" + String(injectErr.message || injectErr) + "). " +
        "Make sure you're on a claude.ai or chatgpt.com conversation tab."
      );
    }
    // Give the freshly-injected script a beat to register its listener.
    await new Promise((r) => setTimeout(r, 100));
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (retryErr) {
      throw new Error(
        "Still couldn't connect after injecting the script. Try refreshing the tab and clicking the extension icon again."
      );
    }
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "PROGRESS") setStatus(msg.text);
});

summarizeBtn.addEventListener("click", async () => {
  summarizeBtn.disabled = true;
  copyBtn.disabled = true;
  setStatus("Reading conversation (auto-scrolling to load it all)...");
  try {
    const tab = await getActiveTab();
    const scrape = await sendToTab(tab.id, { type: "SCRAPE_CONVERSATION" });
    if (!scrape || !scrape.ok) throw new Error("Could not read this page's conversation.");

    setStatus(`Summarizing with Ollama (${modelInput.value || "llama3"})...`);
    const result = await chrome.runtime.sendMessage({
      type: "OLLAMA_SUMMARIZE",
      model: modelInput.value.trim() || "llama3",
      text: scrape.text,
    });

    if (!result || !result.ok) {
      throw new Error(result?.error || "Ollama summarization failed.");
    }

    summaryBox.value = result.summary;
    copyBtn.disabled = false;
    setStatus("Done. Edit the handoff prompt below if needed, then copy it.");
  } catch (err) {
    setStatus(String(err.message || err), true);
  } finally {
    summarizeBtn.disabled = false;
  }
});

exportBtn.addEventListener("click", async () => {
  exportBtn.disabled = true;
  setStatus("Preparing PDF export (auto-scrolling full conversation)...");
  try {
    const tab = await getActiveTab();
    const result = await sendToTab(tab.id, { type: "BUILD_EXPORT_PAYLOAD" });
    if (!result || !result.ok) throw new Error(result?.error || "Could not build the export.");

    // The content script already saved the export data to chrome.storage.local
    // (avoids the extension-messaging size limit for large, image-heavy
    // payloads). Now open the export page via chrome.tabs.create — a
    // privileged extension API, not subject to popup-blocker gesture rules —
    // instead of window.open() from the content script, which used to open
    // a blank tab after the multi-second auto-scroll ate the click's gesture.
    await chrome.tabs.create({ url: chrome.runtime.getURL("export.html") });

    setStatus("Opened export tab — it will open the print dialog automatically.");
  } catch (err) {
    setStatus(String(err.message || err), true);
  } finally {
    exportBtn.disabled = false;
  }
});

copyBtn.addEventListener("click", async () => {
  await navigator.clipboard.writeText(summaryBox.value);
  setStatus("Copied handoff prompt to clipboard.");
});
