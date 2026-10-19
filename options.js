/**
 * Zoowan — options page logic.
 */
(() => {
  const api = typeof browser !== 'undefined' ? browser : chrome;
  const $ = (id) => document.getElementById(id);

  const els = {
    baseUrl: $('baseUrl'),
    apiKey: $('apiKey'),
    model: $('model'),
    temperature: $('temperature'),
    maxTokens: $('maxTokens'),
    status: $('status')
  };

  const PRESETS = {
    lmstudio: { provider: 'openai', baseUrl: 'http://localhost:1234/v1' },
    ollama: { provider: 'openai', baseUrl: 'http://localhost:11434/v1' }
  };

  function setStatus(msg, kind) {
    els.status.textContent = msg || '';
    els.status.className = 'status' + (kind ? ' ' + kind : '');
  }

  function provider() {
    return document.querySelector('input[name="provider"]:checked').value;
  }

  /** Current form values — used both for saving and as overrides when testing. */
  function collectSettings() {
    return {
      provider: provider(),
      baseUrl: els.baseUrl.value.trim(),
      apiKey: els.apiKey.value.trim(),
      model: els.model.value.trim(),
      temperature: Number(els.temperature.value),
      maxTokens: Number(els.maxTokens.value)
    };
  }

  async function load() {
    const stored = await api.storage.local.get('lg_settings');
    const s = (stored && stored.lg_settings) || {};
    if (s.provider === 'anthropic') document.querySelector('input[name="provider"][value="anthropic"]').checked = true;
    els.baseUrl.value = s.baseUrl ?? '';
    els.apiKey.value = s.apiKey ?? '';
    els.model.value = s.model ?? '';
    els.temperature.value = s.temperature ?? 0.3;
    els.maxTokens.value = s.maxTokens ?? 1024;
  }

  async function save() {
    await api.storage.local.set({ lg_settings: collectSettings() });
    setStatus('Saved ✓', 'ok');
    setTimeout(() => setStatus('', ''), 2500);
  }

  async function loadModels() {
    setStatus('Loading model list…');
    try {
      const res = await api.runtime.sendMessage({ type: 'lg-list-models', settingsOverride: collectSettings() });
      if (!res || !res.ok) throw new Error((res && res.error) || 'No response from background.');
      const dl = $('modelList');
      dl.innerHTML = '';
      for (const id of res.models) {
        const opt = document.createElement('option');
        opt.value = id;
        dl.appendChild(opt);
      }
      if (!els.model.value && res.models.length) els.model.value = res.models[0];
      setStatus(res.models.length + ' model(s) found.', 'ok');
    } catch (err) {
      setStatus('Could not load models: ' + ((err && err.message) || err), 'err');
    }
  }

  async function testConnection() {
    setStatus('Testing connection…');
    try {
      const res = await api.runtime.sendMessage({ type: 'lg-test', settingsOverride: collectSettings() });
      if (!res || !res.ok) throw new Error((res && res.error) || 'No response from background.');
      setStatus('Connected ✓ — model replied: "' + res.text + '"', 'ok');
    } catch (err) {
      setStatus('Connection failed: ' + ((err && err.message) || err), 'err');
    }
  }

  document.querySelectorAll('.chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      const p = PRESETS[btn.dataset.preset];
      if (!p) return;
      document.querySelector('input[name="provider"][value="' + p.provider + '"]').checked = true;
      els.baseUrl.value = p.baseUrl;
      setStatus('Preset applied — press Save.', '');
    });
  });

  // ---------------------------------------------------------------- ignored URLs
  const elsIgnore = { url: $('ignoreUrl'), list: $('ignoreList') };

  async function getIgnored() {
    const stored = await api.storage.local.get('lg_ignoredUrls');
    return (stored && Array.isArray(stored.lg_ignoredUrls)) ? stored.lg_ignoredUrls.filter((x) => typeof x === 'string') : [];
  }

  function renderIgnored(list) {
    elsIgnore.list.innerHTML = '';
    for (const u of list) {
      const li = document.createElement('li');
      li.className = 'ignore-item';
      const code = document.createElement('code');
      code.textContent = u;
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'ignore-del';
      del.title = 'Stop ignoring this URL';
      del.textContent = '✕';
      del.addEventListener('click', async () => {
        const next = list.filter((x) => x !== u);
        await api.storage.local.set({ lg_ignoredUrls: next });
        renderIgnored(next);
      });
      li.appendChild(code);
      li.appendChild(del);
      elsIgnore.list.appendChild(li);
    }
  }

  async function addIgnore() {
    let v = elsIgnore.url.value.trim();
    if (!v) return;
    if (!/^https?:\/\//i.test(v)) v = 'https://' + v; // bare host → whole site
    const list = await getIgnored();
    if (list.includes(v)) { elsIgnore.url.value = ''; return; }
    list.push(v);
    await api.storage.local.set({ lg_ignoredUrls: list });
    elsIgnore.url.value = '';
    renderIgnored(list);
  }

  $('addIgnore').addEventListener('click', addIgnore);
  elsIgnore.url.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addIgnore(); }
  });

  getIgnored().then(renderIgnored).catch(() => {});

  $('saveBtn').addEventListener('click', save);
  $('loadModels').addEventListener('click', loadModels);
  $('testBtn').addEventListener('click', testConnection);

  load();
})();
