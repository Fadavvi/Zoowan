# Zoowan 🪶

A Grammarly-style writing assistant for Firefox, powered by **your local LLMs**.
Works with any **OpenAI-compatible** API (LM Studio, Ollama `/v1`, vLLM, LiteLLM, …) or any **Anthropic-compatible** API (`/messages` endpoint).

Select text in any editable area of a web page and a floating toolbar appears:

| Action | What it does |
|---|---|
| 🔄 Rephrase | Same meaning, different wording |
| 🎩 Make it formal | Professional/business register |
| 😎 Make it informal | Casual, friendly tone |
| ✅ Correct mistakes | Grammar / spelling / punctuation fixes (minimal changes) |
| ✂️ Shorten | Condense without losing key information |
| ✍️ Custom | Your own prompt — type any instruction, it's applied to the selection (last prompt is remembered) |

Click an action → the selected text is sent to your local model with a dedicated prompt → the answer appears in the popup (editable before you commit) → **Accept** replaces the selection, or **Copy / Dismiss**.

Everything runs locally except the HTTP call to your LLM server — no cloud, no account.

## Install (temporary)

1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on…**
3. Pick this folder (`local-grammarly`) or `manifest.json` inside it
4. Restarting Firefox removes a temporary add-on — for permanent install, package the folder as an `.xpi` (it's just a zip) and load it via *Install Add-on From File* with `about:config → xpinstall.signatures.enabled = true`.

## Configure

Open the Zoowan options page (right-click the Zoowan icon in the browser toolbar → **Settings**):

- **Provider** — OpenAI-compatible or Anthropic-compatible
- **Base URL**
  - LM Studio: `http://localhost:1234/v1`
  - Ollama: `http://localhost:11434/v1` (Ollama exposes an OpenAI-compatible endpoint)
  - vLLM / LiteLLM: your server's `/v1` base
  - Anthropic-compatible proxy: the base that serves `/messages`
- **API key** — optional for local servers (LM Studio accepts any value; Ollama wants `ollama`)
- **Model** — use **Load models** to pull the list from your server, or type it manually
- **Temperature / Max tokens** — defaults are tuned for editing tasks (0.3 / 1024)

Use **Test connection** to verify everything before saving.

## How it works

```
content.js (per frame)          background.js (event page)
─────────────────────           ────────────────────────────
detect selection in             lgBuildMessages(action, text)
input/textarea/contenteditable  → provider-specific request:
show Shadow-DOM toolbar         OpenAI: POST {base}/chat/completions
on action click ──────────────► Anthropic: POST {base}/messages
render result ◄──────────────── parse + clean response (fences/quotes)
Accept → execCommand(insertText)  (undo-friendly), with setRangeText fallbacks
```

- The popup lives in a **Shadow DOM** with adopted stylesheets, so page CSS/CSP can't break it.
- Replacements use `document.execCommand('insertText')` first to keep native undo (`Ctrl+Z`) working; falls back to `setRangeText` / direct node insertion and dispatches an `input` event so frameworks notice the change.
- Requests can be cancelled (⏹) via `AbortController`.

## Prompts

Each action has a system prompt plus shared rules that force clean, replaceable output:

> Respond with ONLY the final text. Do not wrap it in quotes or code blocks… Do not add explanations, labels, prefixes… Preserve the original language of the input text.

The user message wraps your selection in `"""` delimiters after a short instruction (e.g. *"Proofread and fix this text:"*). See [`actions.js`](actions.js) — edit it to tweak prompts or add actions (add an entry to `LG_ACTIONS` + its key to `LG_ACTION_ORDER`).

**Custom prompts** are sent verbatim as an `Instruction:` block followed by the selection inside `"""` delimiters. With *Clean output* enabled (default), the shared no-commentary rules apply so the answer can replace the selection directly; uncheck it when you want a full explanation instead.

## Limitations

- Works on **any text selection** (2+ characters). Inside `<input>` / `<textarea>` / `[contenteditable]` the replacement is undo-friendly (`Ctrl+Z`); in read-only page text Zoowan splices a text node into the DOM instead.
- Rich-text editors with their own state (CodeMirror, ProseMirror/TipTap, Slate, Lexical) may not always sync the replacement into their internal model — plain contenteditable and native form fields work best.
- `host_permissions: <all_urls>` is requested so background fetches to your local server are never blocked by CORS; tighten it in `manifest.json` if you prefer (e.g. `"http://localhost/*"`).

## Files

```
manifest.json    MV3 manifest (Firefox)
actions.js       shared action definitions + prompts
background.js    LLM client (OpenAI/Anthropic), model listing, test connection
content.js       selection detection + Shadow-DOM popup UI + replacement logic
options.html/css/js   settings page
icons/           extension icons
```
