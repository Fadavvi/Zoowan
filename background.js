/**
 * Zoowan — background event page.
 * Handles LLM requests from content scripts and settings/test calls from the options page.
 */
(() => {
  const api = typeof browser !== 'undefined' ? browser : chrome;

  const DEFAULTS = {
    provider: 'openai', // 'openai' | 'anthropic'
    baseUrl: 'http://localhost:1234/v1',
    apiKey: '',
    model: '',
    temperature: 0.3,
    maxTokens: 1024
  };

  const pendingAborts = new Map(); // reqId -> AbortController

  async function getSettings() {
    const stored = await api.storage.local.get('lg_settings');
    return Object.assign({}, DEFAULTS, (stored && stored.lg_settings) || {});
  }

  function normalizeBase(url) {
    const u = String(url || '').trim().replace(/\/+$/, '');
    if (!u) throw new Error('Base URL is not set. Open Zoowan settings.');
    return u;
  }

  /** Strip code fences / outer quotes that models sometimes add despite instructions. */
  function cleanLLMText(raw) {
    let t = String(raw || '').trim();
    const fence = t.match(/^```[a-zA-Z0-9_-]*\s*\n([\s\S]*)\n?```\s*$/);
    if (fence) t = fence[1].trim();
    if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
      const inner = t.slice(1, -1).trim();
      if (inner.length >= 2) t = inner;
    }
    return t;
  }

  async function callLLM(settings, messages, signal) {
    const base = normalizeBase(settings.baseUrl);
    const temperature = Number(settings.temperature ?? 0.3);
    const maxTokens = Math.max(16, Number(settings.maxTokens) || 1024);
    let url, headers, body;

    if (settings.provider === 'anthropic') {
      // Anthropic-compatible API: POST {base}/messages with x-api-key + anthropic-version.
      url = base + '/messages';
      headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
      if (settings.apiKey) headers['x-api-key'] = settings.apiKey;
      const systemMsg = messages.find((m) => m.role === 'system');
      body = {
        model: settings.model,
        max_tokens: maxTokens,
        temperature,
        messages: messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content }))
      };
      if (systemMsg && systemMsg.content) body.system = systemMsg.content;
    } else {
      // OpenAI-compatible API: POST {base}/chat/completions.
      url = base + '/chat/completions';
      headers = { 'content-type': 'application/json' };
      if (settings.apiKey) headers['Authorization'] = 'Bearer ' + settings.apiKey;
      body = { model: settings.model, messages, temperature, max_tokens: maxTokens };
    }

    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 300); } catch (_) {}
      throw new Error('HTTP ' + res.status + (detail ? ' — ' + detail : ''));
    }
    const data = await res.json();

    let text;
    if (settings.provider === 'anthropic') {
      text = Array.isArray(data.content)
        ? data.content.filter((b) => b && b.type === 'text').map((b) => b.text).join('')
        : '';
    } else {
      text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    }
    const cleaned = cleanLLMText(text);
    if (!cleaned) throw new Error('The model returned an empty response.');
    return cleaned;
  }

  async function listModels(settings) {
    const base = normalizeBase(settings.baseUrl);
    // Most OpenAI-compatible servers (LM Studio, Ollama /v1, vLLM, LiteLLM…) expose GET /models.
    // Many Anthropic-compatible proxies do too; if not, we surface a helpful error.
    const headers = {};
    if (settings.apiKey) {
      if (settings.provider === 'anthropic') headers['x-api-key'] = settings.apiKey;
      else headers['Authorization'] = 'Bearer ' + settings.apiKey;
    }
    const res = await fetch(base + '/models', { headers });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' — this server may not expose a /models endpoint.');
    const data = await res.json();
    const items = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
    return items.map((m) => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean);
  }

  /** Shared request runner: settings + abort handling for any message-driven LLM call. */
  async function runLLMRequest(reqId, buildMessages) {
    const settings = await getSettings();
    if (!settings.model) {
      // Some local servers ignore the model field; warn but proceed.
      console.warn('[Zoowan] No model configured — sending empty model name.');
    }
    const controller = new AbortController();
    pendingAborts.set(reqId, controller);
    try {
      return await callLLM(settings, buildMessages(), controller.signal);
    } finally {
      pendingAborts.delete(reqId);
    }
  }

  api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      try {
        switch (msg && msg.type) {
          case 'lg-llm': {
            const text = await runLLMRequest(msg.reqId, () => lgBuildMessages(msg.action, msg.text));
            sendResponse({ ok: true, text });
            break;
          }
          case 'lg-llm-custom': {
            const text = await runLLMRequest(
              msg.reqId,
              () => lgBuildCustomMessages(msg.prompt, msg.text, !!msg.clean)
            );
            sendResponse({ ok: true, text });
            break;
          }
          case 'lg-abort': {
            const c = pendingAborts.get(msg.reqId);
            if (c) { c.abort(); pendingAborts.delete(msg.reqId); }
            sendResponse({ ok: true });
            break;
          }
          case 'lg-list-models': {
            // Allow the options page to test unsaved form values via settingsOverride.
            const settings = Object.assign({}, await getSettings(), msg.settingsOverride || {});
            sendResponse({ ok: true, models: await listModels(settings) });
            break;
          }
          case 'lg-test': {
            const settings = Object.assign({}, await getSettings(), msg.settingsOverride || {});
            const text = await callLLM(
              settings,
              [
                { role: 'system', content: 'You are a connection test. Reply with exactly: OK' },
                { role: 'user', content: 'ping' }
              ],
              undefined
            );
            sendResponse({ ok: true, text });
            break;
          }
          default:
            sendResponse({ ok: false, error: 'Unknown message type' });
        }
      } catch (err) {
        const aborted = err && err.name === 'AbortError';
        sendResponse({ ok: false, error: aborted ? 'Cancelled.' : (err && err.message || String(err)) });
      }
    })();
    return true; // keep the channel open for the async response
  });
})();
