// background.js
// Only talks to a LOCAL Ollama server (http://localhost:11434). Nothing
// here ever requests or uses an Anthropic/OpenAI API key — that earlier
// prompt was coming from a different code path and has been removed.
// Swap OLLAMA_URL / the fetch below later if you move to a cloud provider.

// Windows sometimes resolves "localhost" to IPv6 (::1) while Ollama only
// listens on IPv4 127.0.0.1 (or vice versa) — that mismatch surfaces as a
// generic, unhelpful "Failed to fetch" with no useful status code. Try
// both hosts before giving up.
const OLLAMA_HOSTS = ["http://127.0.0.1:11434", "http://localhost:11434"];

async function callOllama(model, prompt) {
  let lastErr = null;
  for (const host of OLLAMA_HOSTS) {
    try {
      const res = await fetch(`${host}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: model || "llama3", prompt, stream: false }),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        if (res.status === 403) {
          throw new Error(
            `Ollama blocked this request (403 — origin not allowed). Ollama's server rejects requests ` +
            `from chrome-extension:// origins by default. Fix: quit Ollama fully (tray icon > Quit, or ` +
            `Task Manager), set a system environment variable OLLAMA_ORIGINS=chrome-extension://* ` +
            `(Windows: search "Environment Variables" > Edit environment variables for your account > New), ` +
            `then restart Ollama. See README.md > "Ollama returns 403" for exact steps.`
          );
        }
        throw new Error(`Ollama request failed (${res.status}) at ${host}. ${errText}`);
      }
      const data = await res.json();
      return data.response || "";
    } catch (err) {
      // A thrown Error with a real status message (403 case above) should
      // stop the loop and surface immediately, not get swallowed by the
      // next host attempt.
      if (err && err.message && err.message.includes("403")) throw err;
      lastErr = err;
      // "Failed to fetch" / TypeError means we couldn't even connect —
      // worth trying the other host before giving up.
    }
  }
  throw new Error(
    `Could not reach Ollama at 127.0.0.1 or localhost:11434 ("${String(lastErr && lastErr.message || lastErr)}"). ` +
    `Checklist: (1) Is Ollama actually running right now? Check the system tray, or open ` +
    `http://127.0.0.1:11434 in a normal browser tab — it should say "Ollama is running". ` +
    `(2) If you just restarted it to set OLLAMA_ORIGINS, make sure it fully relaunched (not just the ` +
    `terminal window closed). (3) Check Windows Firewall isn't blocking it. See README.md > ` +
    `"Ollama: Failed to fetch" for more.`
  );
}

async function summarizeWithOllama(model, conversationText) {
  const prompt = `You are helping a user hand off an AI chat conversation to a new session (possibly with a different model). Read the conversation below and produce:
1. A concise summary (5-10 bullet points) of what was discussed and decided.
2. Any open tasks / unresolved questions.
3. A short "handoff prompt" the user can paste into a brand new chat to continue seamlessly, written in second person ("We were working on...").

Conversation:
---
${conversationText.slice(0, 12000)}
---`;

  return callOllama(model, prompt);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "OLLAMA_SUMMARIZE") {
    summarizeWithOllama(msg.model, msg.text)
      .then((summary) => sendResponse({ ok: true, summary }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true; // keep the message channel open for the async response
  }

  if (msg.type === "PROGRESS") {
    // Forward scrape/export progress to the popup, if it's open.
    chrome.runtime.sendMessage(msg).catch(() => {});
  }
});
