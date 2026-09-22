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

async function summarizeWithOllama(model, conversationText, mode) {
  const formats = {
    structured: `Create a structured handoff brief with exactly these headings:
CONTEXT
GOAL
CURRENT STATE
KEY DECISIONS
COMPLETED WORK
OPEN QUESTIONS
BLOCKERS OR RISKS
NEXT ACTIONS
CONTINUE PROMPT

Use concise bullets. Preserve concrete file names, commands, errors, and constraints. Do not invent missing facts.`,
    continue: `Create a continuation prompt for a new AI session. Start with a compact context summary, then state the current goal, completed work, unresolved issues, constraints, and the exact next action. Write it so another AI can continue immediately without asking for information already present.`,
    debug: `Create a debugging brief with these headings:
BUG
EXPECTED BEHAVIOR
OBSERVED BEHAVIOR
REPRODUCTION DETAILS
RELEVANT FILES AND CODE
LIKELY ROOT CAUSE
ATTEMPTS ALREADY MADE
NEXT DIAGNOSTIC STEP

Separate confirmed facts from hypotheses and preserve exact errors or commands when available.`
  };
  const format = formats[mode] || formats.structured;
  const prompt = `You are preparing a reliable knowledge handoff from an AI chat to a new session or model.
${format}

Rules:
- Base the output only on the conversation.
- Do not mention that you are an AI or that you were given a transcript.
- Keep useful technical details; remove greetings and repetition.
- If a section has no evidence, write "None identified".

Conversation:
---
${conversationText.slice(0, 12000)}
---`;

  return callOllama(model, prompt);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "OLLAMA_SUMMARIZE") {
    summarizeWithOllama(msg.model, msg.text, msg.mode)
      .then((summary) => sendResponse({ ok: true, summary }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true; // keep the message channel open for the async response
  }

  if (msg.type === "PROGRESS") {
    // Forward scrape/export progress to the popup, if it's open.
    chrome.runtime.sendMessage(msg).catch(() => {});
  }
});
