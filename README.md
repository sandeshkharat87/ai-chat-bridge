
<img width="1298" height="785" alt="Screenshot 2026-09-22 095657" src="https://github.com/user-attachments/assets/9880e466-176e-4421-ac2d-a75665b877d1" />



# AI Chat Handoff & Summarizer (Ollama)

Chrome extension that:
- Summarizes the current Claude/ChatGPT conversation **locally via Ollama** (no cloud API key, ever) and builds a "handoff prompt" you can paste into a new session or a different model.
- Exports the **full** conversation to PDF (via the browser print dialog) with **code blocks clearly highlighted**.

## 1. Install Ollama and pull a model
```bash
# https://ollama.com
ollama serve            # starts the local server on :11434
ollama pull llama3      # or any model you prefer
```
Ollama must be running (`ollama serve`) whenever you click "Summarize" — the model name in the popup must match a model you've pulled.

## 2. Load the extension in Chrome
1. Go to `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select this folder
4. Pin the extension for easy access

## 3. Use it
- Open a Claude or ChatGPT conversation tab.
- Click the extension icon.
- **Summarize with Ollama** — reads the whole conversation (auto-scrolling first, see fix below), sends it to your local Ollama model, and returns a summary + ready-to-paste handoff prompt. Edit it, then **Copy handoff prompt**.
- **Export PDF** — opens a clean, formatted copy of the whole thread in a new tab and triggers the print dialog; choose **Save as PDF**.

## Fixes included in this version

**1. "why is it asking for an Anthropic key" — removed entirely.**
`background.js` only ever calls `http://localhost:11434/api/generate` (your local Ollama server). There is no code path anywhere in this extension that reads, stores, or sends an Anthropic/OpenAI API key. `manifest.json`'s `host_permissions` only lists `localhost:11434` plus the chat sites themselves.

**2. "on chatgpt its scrolling but not on claude" — fixed with real auto-scroll.**
`content.js` -> `autoScrollFullConversation()`:
- Finds the actual scrolling container (not just `window`), since Claude's chat scrolls inside an inner `<div>` rather than the page itself.
- Repeatedly scrolls it to the top and waits for `scrollHeight` to stop growing, so lazy-loaded older messages get pulled in.
- Then walks back down in steps so anything that renders on scroll-into-view (images, code blocks) gets triggered before capture.
- Used before **both** summarization and PDF export, so neither one truncates the conversation.

**3. "add codeblock to see code clearly while exporting pdf" — done.**
When building the print/export page, every `<pre>` block is tagged `handoff-code-block` and given dedicated CSS: dark background, monospace font, rounded corners, horizontal scroll/wrap, a language label pulled from the page's own `language-xxx` class when present, and `page-break-inside: avoid` so blocks don't get cut across PDF pages. Inline `<code>` gets a light pill background so it stands out from normal prose too.

## "Could not establish connection. Receiving end does not exist."
This means the content script wasn't yet injected into that tab — the most common cause is that the tab was already open *before* you loaded (or reloaded) the extension, so Chrome never ran `content_scripts` on it. Two fixes are in place:
- **Immediate:** refresh the Claude/ChatGPT tab, then click the extension icon again.
- **Automatic going forward:** `popup.js` now catches exactly this error and injects `content.js` on demand via `chrome.scripting.executeScript`, then retries the message once, so you shouldn't normally need to refresh manually after this update.

## Export grabbed the sidebar, or was blank
Cause: the old code guessed at CSS selectors (`main`, `[class*="conversation"]`, etc.) to find the conversation container, and that guess didn't reliably match Claude's actual layout — sometimes landing on the sidebar, sometimes on something with almost no text.

Fix: `content.js`'s `findContentRoot()` no longer guesses class names at all. It starts at `<body>` and walks down: at each level, if exactly one child holds a clear majority (60%+) of the real, non-chrome text on the page, it steps into that child; it stops once no single child dominates anymore. That stopping point is, structurally, where the conversation branches into its individual messages — i.e. the real conversation container — regardless of what the site names its `<div>`s. `<nav>`, `<aside>`, `<header>`, `<footer>`, and anything whose class/id/role/aria-label mentions "sidebar", "nav", "drawer", etc. is excluded from consideration entirely, and their text doesn't count toward a wrapper's total either (so a top-level layout `<div>` that happens to contain both the sidebar and the conversation doesn't get mistaken for "biggest = best"). If this still can't find at least ~80 characters of real content, it falls back to the whole page rather than exporting nothing.

Scrolling and content-capture are now handled separately: `findScrollableAncestor()` walks *up* from that content root to find whichever ancestor actually scrolls (since the content container itself often isn't the scrolling element), while the actual text/HTML capture still comes from the content root itself — so scrolling the right thing and capturing the right thing no longer have to be the same element.

## PDF export was blank
Two compounding causes, both fixed:
1. The export used to call `window.open()` from the content script *after* several seconds of auto-scrolling, so Chrome's popup blocker silently opened an empty tab instead of the real content. Fixed previously by opening the export page via `chrome.tabs.create()` instead.
2. **New fix:** the built export HTML (with embedded base64 images) could be large enough to hit `chrome.storage.local`'s default 5MB quota, or exceed practical extension-message size when passed back through `sendResponse`, causing a silent failure that left the export tab empty. Fixed by (a) adding the `unlimitedStorage` permission, and (b) having `content.js` write the payload straight into `chrome.storage.local` itself, instead of round-tripping it through `sendResponse` first.

`content.js` also now reports a real error (e.g. "couldn't find any conversation content") instead of silently returning nothing if scraping fails, so a failed export shows a message in the popup instead of just quietly opening a blank tab.

## Ollama: "Failed to fetch"
This is a lower-level error than a 403 — the request never reached any server at all. `background.js` now tries both `http://127.0.0.1:11434` and `http://localhost:11434` automatically, since on some Windows setups `localhost` resolves to IPv6 (`::1`) while Ollama only listens on IPv4, which otherwise causes exactly this error with no useful status code.

If it still fails after that, check:
- **Is Ollama actually running right now?** Open `http://127.0.0.1:11434` in a normal browser tab — it should say "Ollama is running". If not, relaunch it.
- If you recently quit Ollama to change `OLLAMA_ORIGINS`, make sure you relaunched it afterward (closing a terminal window running `ollama serve` doesn't stop a background/tray instance, and vice versa).
- Windows Firewall / antivirus occasionally blocks local ports for specific apps — check it isn't blocking `ollama.exe`.

## Ollama returns 403 ("origin not allowed")
Ollama's server rejects requests whose `Origin` header isn't in its allow-list, and `chrome-extension://...` isn't included by default — this is unrelated to whether `ollama serve` is running (in your case it already was, running as a background service, which is why manually running `ollama serve` again failed with "address already in use").

Fix (Windows):
1. Fully quit Ollama — right-click its system tray icon → **Quit Ollama** (or End Task on `ollama app.exe` / `ollama.exe` in Task Manager). Just closing the window isn't enough; the background service needs to actually stop.
2. Set a system environment variable: Start menu → search **"Environment Variables"** → **Edit environment variables for your account** → **New...** → Name: `OLLAMA_ORIGINS`, Value: `chrome-extension://*` (or, more restrictively, `chrome-extension://<your-extension-id>` — find the ID on `chrome://extensions` with Developer mode on).
3. Relaunch Ollama (or open a terminal and run `ollama serve`) so it picks up the new variable.
4. Try **Summarize with Ollama** again.

(Mac/Linux equivalent: `export OLLAMA_ORIGINS="chrome-extension://*"` before starting `ollama serve`, or set it in your shell profile / systemd unit if Ollama runs as a service.)

## Notes / known limits
- DOM selectors for "find the conversation container" use a few common patterns plus a fallback; if a site redesigns its layout, you may need to tweak `CONTAINER_CANDIDATES` in `content.js`.
- If a chat app *virtualizes* very long threads (removing far-offscreen messages from the DOM entirely, not just visually), the auto-scroll-to-top approach still works because it forces those messages back into the DOM before capture — but on very long threads this can take a few seconds. The status line in the popup shows live progress.
- Ollama summarization currently truncates conversation text to ~12,000 characters per request to keep it fast on local models — bump the `slice(0, 12000)` in `background.js` if you want more context and your model/hardware can handle it.
- Swapping to a different provider later: replace the `fetch` in `background.js`'s `summarizeWithOllama()` with your new provider's call — everything else (scraping, PDF export) is provider-agnostic.
