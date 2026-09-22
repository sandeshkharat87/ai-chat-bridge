// content.js
// Runs on claude.ai / chatgpt.com pages. Handles:
//   1) Finding + fully auto-scrolling the conversation container
//      (fix for: "on chatgpt its scrolling but not on claude")
//   2) Extracting text + code blocks + images for Ollama summarization
//   3) Building a clean, print-ready HTML page with clearly highlighted
//      code blocks and triggering window.print() -> "Save as PDF"
//      (fix for: "add codeblock to see code clearly while exporting pdf")
//
// No Anthropic/OpenAI API key is ever read or required here — summarization
// is done entirely by background.js talking to a local Ollama server.

(function () {
  // Elements that are almost always chrome, not conversation content —
  // excluded outright from consideration.
  const CHROME_RE = /\b(nav|sidebar|side-panel|side-nav|drawer|topbar|header|footer|breadcrumb)\b/i;

  function looksLikeChrome(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName;
    if (tag === "NAV" || tag === "ASIDE" || tag === "HEADER" || tag === "FOOTER") return true;
    const hay = [
      el.id || "",
      el.className || "",
      el.getAttribute("role") || "",
      el.getAttribute("aria-label") || "",
    ].join(" ");
    return CHROME_RE.test(hay);
  }

  function ownVisibleTextLength(el) {
    // Text contributed by this element, with any nav/sidebar/header/footer
    // descendants stripped out first, so a wrapper div that happens to
    // contain both the sidebar AND the conversation doesn't get credited
    // for the sidebar's text (which would otherwise make it look like the
    // "biggest" candidate and defeat the whole point of this walk).
    if (!el || !el.innerText) return 0;
    if (!el.querySelector) return el.innerText.length;
    let chromeLen = 0;
    const chromeDescendants = el.querySelectorAll("nav, aside, header, footer");
    for (const c of chromeDescendants) {
      // Only subtract top-level chrome nodes (skip ones nested inside
      // another already-counted chrome node) to avoid double subtraction.
      if (!c.parentElement || !c.parentElement.closest("nav, aside, header, footer")) {
        chromeLen += (c.innerText || "").length;
      }
    }
    return Math.max(0, el.innerText.length - chromeLen);
  }

  // Finds the actual conversation region by structural majority, not by
  // guessing class names (which broke on Claude's real DOM — it either
  // grabbed the sidebar or an almost-empty node). Starting at <body>,
  // descend into whichever single child holds a clear majority of the
  // page's real (chrome-excluded) text; stop once no single child
  // dominates anymore — that's the level where messages branch out as
  // siblings, i.e. the conversation container itself.
  function findContentRoot() {
    let node = document.body;
    for (let depth = 0; depth < 40; depth++) {
      const total = ownVisibleTextLength(node);
      if (total < 80) break;
      const children = Array.from(node.children || []).filter((c) => !looksLikeChrome(c));
      let majority = null;
      for (const c of children) {
        if (ownVisibleTextLength(c) >= total * 0.6) {
          majority = c;
          break;
        }
      }
      if (!majority) break;
      node = majority;
    }
    // Safety net: if we somehow landed on something with almost no text
    // (e.g. an unusual layout), fall back to the whole page rather than
    // exporting a blank page.
    if (ownVisibleTextLength(node) < 80) return document.body;
    return node;
  }

  // From a content root, walk UP to the nearest ancestor that actually
  // scrolls (the content root itself is often not the scrolling element —
  // some wrapper a few levels up is).
  function findScrollableAncestor(node) {
    let el = node;
    for (let i = 0; i < 8 && el; i++) {
      if (el.scrollHeight - el.clientHeight > 40) return el;
      el = el.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // Scrolls a container all the way to the top first (chat apps lazy-load
  // older messages as you scroll up), waiting for new content to stop
  // appearing, then returns it fully loaded and scrolled back down.
  async function autoScrollFullConversation(container, onProgress) {
    let lastHeight = -1;
    let stableRounds = 0;
    const maxRounds = 60;

    // 1) Walk to the top, repeatedly, waiting for lazy-loaded content.
    for (let i = 0; i < maxRounds; i++) {
      container.scrollTop = 0;
      window.scrollTo(0, 0);
      await sleep(350);
      const h = container.scrollHeight;
      onProgress && onProgress(`Loading older messages... (${h}px)`);
      if (h === lastHeight) {
        stableRounds++;
        if (stableRounds >= 3) break;
      } else {
        stableRounds = 0;
      }
      lastHeight = h;
    }

    // 2) Walk back down in steps so any elements that lazy-render on
    //    scroll-into-view (images, code highlighting) get triggered too.
    const step = Math.max(300, Math.floor(container.clientHeight * 0.8));
    let pos = 0;
    const total = container.scrollHeight;
    while (pos < total) {
      container.scrollTop = pos;
      window.scrollTo(0, pos);
      await sleep(120);
      pos += step;
      onProgress && onProgress(`Rendering conversation... (${Math.min(100, Math.round((pos / total) * 100))}%)`);
    }
    container.scrollTop = container.scrollHeight;
    await sleep(200);
    onProgress && onProgress("Done loading conversation.");
  }

  // Converts an <img> to a data: URL so the exported print page works
  // fully offline and doesn't lose images to cross-origin blocking.
  function imgToDataURL(img) {
    return new Promise((resolve) => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth || img.width || 300;
        canvas.height = img.naturalHeight || img.height || 150;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/png"));
      } catch (e) {
        // Cross-origin canvas taint or load failure — keep original src.
        resolve(img.src);
      }
    });
  }

  function extractPlainText(container) {
    // Used for the Ollama summarization prompt. innerText respects
    // visual line breaks and is good enough for a summary.
    return container.innerText.replace(/\n{3,}/g, "\n\n").trim();
  }

  // Builds the pieces needed for the export page (title/meta/body HTML).
  // Does NOT open any window — window.open() from a content script, run
  // after several seconds of async auto-scrolling, loses the original
  // click's "user gesture" and gets silently popup-blocked (this was the
  // cause of the blank PDF page). Instead we hand this payload back to
  // popup.js, which opens the export tab itself via chrome.tabs.create —
  // a privileged extension API call that isn't subject to popup blocking.
  async function buildExportPayload(container, pageTitle) {
    const clone = container.cloneNode(true);

    clone.querySelectorAll("script, style, iframe, button, textarea, input").forEach((el) => el.remove());

    const originalImgs = Array.from(container.querySelectorAll("img"));
    const cloneImgs = Array.from(clone.querySelectorAll("img"));
    for (let i = 0; i < cloneImgs.length; i++) {
      const src = originalImgs[i] ? await imgToDataURL(originalImgs[i]) : null;
      if (src) cloneImgs[i].setAttribute("src", src);
      cloneImgs[i].style.maxWidth = "100%";
    }

    clone.querySelectorAll("pre").forEach((pre) => {
      pre.classList.add("handoff-code-block");
      const codeEl = pre.querySelector("code");
      let lang = "";
      if (codeEl) {
        const m = (codeEl.className || "").match(/language-([a-zA-Z0-9+#]+)/);
        if (m) lang = m[1];
      }
      if (lang) {
        const label = document.createElement("div");
        label.className = "handoff-code-lang";
        label.textContent = lang;
        pre.prepend(label);
      }
    });

    return {
      title: pageTitle,
      metaLine: `Exported ${new Date().toLocaleString()} — ${location.href}`,
      bodyHtml: clone.innerHTML,
    };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "SCRAPE_CONVERSATION") {
      (async () => {
        try {
          const contentRoot = findContentRoot();
          const scrollTarget = findScrollableAncestor(contentRoot);
          await autoScrollFullConversation(scrollTarget, (p) => {
            chrome.runtime.sendMessage({ type: "PROGRESS", text: p });
          });
          const text = extractPlainText(contentRoot);
          sendResponse({ ok: true, text, title: document.title });
        } catch (err) {
          sendResponse({ ok: false, error: String(err && err.message || err) });
        }
      })();
      return true; // async
    }

    if (msg.type === "BUILD_EXPORT_PAYLOAD") {
      (async () => {
        try {
          const contentRoot = findContentRoot();
          const scrollTarget = findScrollableAncestor(contentRoot);
          await autoScrollFullConversation(scrollTarget, (p) => {
            chrome.runtime.sendMessage({ type: "PROGRESS", text: p });
          });
          const payload = await buildExportPayload(contentRoot, document.title || "Conversation export");
          if (!payload.bodyHtml || !payload.bodyHtml.trim()) {
            sendResponse({ ok: false, error: "Couldn't find any conversation content on this page to export." });
            return;
          }
          // Write straight to storage from here rather than returning the
          // (possibly multi-MB, image-heavy) payload through sendResponse —
          // extension message passing has a much smaller practical size
          // limit than storage.local, which is what caused blank exports.
          await chrome.storage.local.set({ handoffExportPayload: payload });
          sendResponse({ ok: true, bytes: JSON.stringify(payload).length });
        } catch (err) {
          sendResponse({ ok: false, error: String(err && err.message || err) });
        }
      })();
      return true; // async
    }
  });
})();
