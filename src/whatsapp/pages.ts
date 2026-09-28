import { html, raw } from 'hono/html'

const style = raw(`<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { max-width: 480px; margin: 10vh auto; padding: 0 16px; line-height: 1.45; }
  h1 { font-size: 1.2rem; }
  .card { border: 1px solid #8884; border-radius: 8px; padding: 12px 16px; margin: 16px 0; }
  .ok { color: #2e7d32; } .warn { color: #c62828; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; margin: 8px 0 0; font-size: .9rem; }
  dt { opacity: .7; } dd { margin: 0; overflow-wrap: anywhere; }
  button { margin: 8px 8px 0 0; padding: 8px 14px; font-size: 1rem; cursor: pointer; }
  button:disabled { cursor: default; opacity: .6; }
  #msg { min-height: 1.2em; font-size: .9rem; }
  .muted { opacity: .7; font-size: .9rem; }
  h2 { font-size: 1.05rem; margin-top: 32px; }
  input[type=range] { width: 100%; margin: 8px 0 0; }
  .ticks { display: flex; justify-content: space-between; font-size: .8rem; opacity: .7; }
  input[type=search] { width: 100%; box-sizing: border-box; padding: 8px; font-size: 1rem; }
  ul.list { list-style: none; padding: 0; margin: 8px 0 0; }
  ul.list li { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 0; border-top: 1px solid #8883; }
  ul.list li button { margin: 0; padding: 4px 10px; font-size: .85rem; }
</style>`)

// Port of villalubri's VincularMeta.tsx: Facebook JS SDK + Embedded Signup (Coexistence).
const script = raw(`<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const say = (text, bad) => { $('msg').textContent = text || ''; $('msg').className = bad ? 'warn' : ''; };
  const fmt = (d) => d ? new Date(d).toLocaleString('es') : '—';
  let meta = null;
  let signup = {};
  let busy = false;

  async function api(path, body) {
    const res = await fetch('/whatsapp/api/' + path, body === undefined
      ? { credentials: 'same-origin' }
      : { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { location.href = '/login?next=/whatsapp'; throw new Error('Sesión expirada'); }
    if (!res.ok) throw new Error(data.message || 'Error HTTP ' + res.status);
    return data;
  }

  function setBusy(value) {
    busy = value;
    document.querySelectorAll('button').forEach((b) => { b.disabled = value || (b.id === 'connect' && !window.FB); });
  }

  async function load() {
    const s = await api('status');
    $('unlinked').hidden = s.linked;
    $('linked').hidden = !s.linked;
    $('connect').textContent = s.linked ? 'Volver a conectar' : 'Conectar con Meta';
    if (!s.linked) return;
    const ok = s.status === 'linked';
    $('state').textContent = ok ? '✓ Número vinculado' : '⚠ Meta rechazó la conexión';
    $('state').className = ok ? 'ok' : 'warn';
    $('number').textContent = s.displayPhoneNumber || s.phoneNumberId;
    $('waba').textContent = s.wabaId;
    $('since').textContent = fmt(s.linkedAt);
    $('sync').textContent = s.historySyncRequestedAt ? fmt(s.historySyncRequestedAt) : 'pendiente';
    $('error').textContent = s.lastError || '';
    $('error-row').hidden = !s.lastError;
  }

  // Meta posts the WABA and phone number ids from the popup before FB.login's callback fires.
  window.addEventListener('message', (e) => {
    if (e.origin !== 'https://www.facebook.com' && e.origin !== 'https://web.facebook.com') return;
    let p;
    try { p = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch { return; }
    if (!p || p.type !== 'WA_EMBEDDED_SIGNUP') return;
    if (['FINISH', 'FINISH_ONLY_WABA', 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING'].includes(p.event)) {
      signup = { wabaId: p.data && p.data.waba_id, phoneNumberId: p.data && p.data.phone_number_id, event: p.event };
    } else if (p.event === 'CANCEL') {
      say('Conexión cancelada' + (p.data && p.data.current_step ? ' en el paso ' + p.data.current_step : ''), true);
    } else if (p.event === 'ERROR') {
      say('Meta reportó un error: ' + ((p.data && p.data.error_message) || 'desconocido'), true);
    }
  });

  function connect() {
    signup = {};
    say('Completa los pasos en la ventana de Meta…');
    window.FB.login((r) => {
      const code = r && r.authResponse && r.authResponse.code;
      if (!code) { say('No se completó la conexión con Meta', true); return; }
      if (!signup.wabaId || !signup.phoneNumberId) { say('Meta no devolvió la cuenta de WhatsApp. Vuelve a intentarlo.', true); return; }
      // The code expires in ~30 seconds: send it right away.
      setBusy(true);
      say('Vinculando…');
      api('link', { code, ...signup })
        .then((d) => { say('Número vinculado' + (d.displayPhoneNumber ? ': ' + d.displayPhoneNumber : '') + '. Sincronización de historial solicitada.'); return load(); })
        .catch((err) => say(err.message, true))
        .finally(() => setBusy(false));
    }, {
      config_id: meta.configId,
      response_type: 'code',
      override_default_response_type: true,
      extras: { setup: {}, featureType: 'whatsapp_business_app_onboarding', sessionInfoVersion: '3', version: 'v4' },
    });
  }

  async function action(path, confirmText, done) {
    if (confirmText && !confirm(confirmText)) return;
    setBusy(true);
    try { await api(path, {}); say(done); await load(); } catch (err) { say(err.message, true); } finally { setBusy(false); }
  }

  // --- Privacy: retention slider and excluded chats --------------------------
  let retention = 12;
  const day = (d) => new Date(d).toLocaleDateString('es');
  const cutoffFor = (months) => { const d = new Date(); d.setMonth(d.getMonth() - months); return d; };
  const showRetention = (months) => {
    $('ret-value').textContent = months + ' meses';
    $('ret-note').textContent = 'Se conservan los mensajes desde el ' + day(cutoffFor(months)) + '. Los anteriores se borran cada día.';
  };

  function li(label, sub, buttonText, onClick) {
    const item = document.createElement('li');
    const text = document.createElement('span');
    text.textContent = label;
    if (sub) { const small = document.createElement('span'); small.className = 'muted'; small.textContent = ' ' + sub; text.appendChild(small); }
    const button = document.createElement('button');
    button.textContent = buttonText;
    button.onclick = onClick;
    item.append(text, button);
    return item;
  }

  async function loadPrivacy() {
    const p = await api('privacy');
    retention = p.retentionMonths;
    $('retention').value = String(retention);
    showRetention(retention);
    $('ret-last').textContent = p.lastPurgeAt ? 'Última limpieza: ' + fmt(p.lastPurgeAt) : '';
    const list = $('excluded');
    list.replaceChildren(...p.excluded.map((x) =>
      li(x.label || '+' + x.waId, x.label ? '+' + x.waId : '', 'Quitar exclusión', () => include(x.waId))));
    $('excluded-empty').hidden = p.excluded.length > 0;
  }

  $('retention').oninput = (e) => showRetention(Number(e.target.value));
  $('retention').onchange = async (e) => {
    const months = Number(e.target.value);
    if (months < retention && !confirm('Se borrarán de forma permanente los mensajes anteriores al ' + day(cutoffFor(months)) + '. ¿Continuar?')) {
      e.target.value = String(retention); showRetention(retention); return;
    }
    setBusy(true);
    try {
      const r = await api('privacy/retention', { months });
      say('Retención: ' + months + ' meses' + (r.deletedMessages ? '. Se borraron ' + r.deletedMessages + ' mensajes.' : '.'));
      await loadPrivacy();
    } catch (err) { say(err.message, true); e.target.value = String(retention); showRetention(retention); }
    finally { setBusy(false); }
  };

  async function exclude(waId, name) {
    if (!confirm('Se borrarán todos los mensajes de ' + name + ' y no se guardarán los nuevos. La IA no podrá leerlos. ¿Continuar?')) return;
    setBusy(true);
    try {
      const r = await api('privacy/exclude', { waId });
      say(name + ' excluido. Mensajes borrados: ' + r.deletedMessages + '.');
      $('search').value = ''; $('results').replaceChildren();
      await loadPrivacy();
    } catch (err) { say(err.message, true); } finally { setBusy(false); }
  }

  async function include(waId) {
    setBusy(true);
    try { await api('privacy/include', { waId }); say('Exclusión quitada. Solo se guardarán los mensajes nuevos.'); await loadPrivacy(); }
    catch (err) { say(err.message, true); } finally { setBusy(false); }
  }

  let searchTimer;
  $('search').oninput = (e) => {
    clearTimeout(searchTimer);
    const q = e.target.value.trim();
    searchTimer = setTimeout(async () => {
      if (q.length < 2) { $('results').replaceChildren(); return; }
      try {
        const r = await api('privacy/contacts?q=' + encodeURIComponent(q));
        const items = r.contacts.map((x) => li(x.name, '+' + x.waId, 'Excluir', () => exclude(x.waId, x.name)));
        const digits = q.replace(/\\D/g, '');
        if (digits.length >= 6 && !r.contacts.some((x) => x.waId === digits)) {
          items.push(li('+' + digits, '(número)', 'Excluir', () => exclude(digits, '+' + digits)));
        }
        $('results').replaceChildren(...items);
      } catch (err) { say(err.message, true); }
    }, 250);
  };

  $('connect').onclick = connect;
  $('unlink').onclick = () => action('unlink', '¿Desvincular el número? El archivo de mensajes se conserva.', 'Número desvinculado');
  $('resync').onclick = () => action('sync', null, 'Sincronización solicitada');

  (async () => {
    try {
      await loadPrivacy();
      meta = await api('meta');
      await load();
      if (!meta.ready) { $('not-ready').hidden = false; setBusy(false); $('connect').disabled = true; return; }
      window.fbAsyncInit = () => {
        window.FB.init({ appId: meta.appId, autoLogAppEvents: true, xfbml: false, version: meta.graphVersion });
        setBusy(false);
      };
      const s = document.createElement('script');
      s.id = 'facebook-jssdk';
      s.src = 'https://connect.facebook.net/en_US/sdk.js';
      s.async = true; s.defer = true; s.crossOrigin = 'anonymous';
      s.onerror = () => say('No se pudo cargar el SDK de Facebook (¿bloqueador de anuncios?)', true);
      document.body.appendChild(s);
    } catch (err) { say(err.message, true); }
  })();
})();
</script>`)

export const whatsappPage = () => html`<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>WhatsApp · WhatsApp MCP</title>
    ${style}
  </head>
  <body>
    <h1>Conexión con WhatsApp</h1>
    <p class="muted">
      Vincula tu número de WhatsApp Business (Coexistence) para archivar tus chats. La app del teléfono sigue
      funcionando y este servicio nunca envía mensajes.
    </p>
    <p id="not-ready" class="warn" hidden>
      Falta configurar META_APP_ID, META_CONFIG_ID y WHATSAPP_TOKEN_KEY en el servidor.
    </p>
    <div id="unlinked" class="card" hidden>
      <strong>Sin conectar</strong>
      <p class="muted">Se abrirá una ventana de Meta para elegir tu cuenta y confirmar el número.</p>
    </div>
    <div id="linked" class="card" hidden>
      <strong id="state"></strong>
      <dl>
        <dt>Número</dt><dd id="number"></dd>
        <dt>WABA</dt><dd id="waba"></dd>
        <dt>Vinculado</dt><dd id="since"></dd>
        <dt>Historial</dt><dd id="sync"></dd>
        <dt id="error-row">Error</dt><dd id="error" class="warn"></dd>
      </dl>
      <button id="resync" disabled>Reintentar sincronización</button>
      <button id="unlink" disabled>Desvincular</button>
    </div>
    <button id="connect" disabled>Conectar con Meta</button>
    <p id="msg" role="status" aria-live="polite"></p>

    <h2>Privacidad</h2>
    <div class="card">
      <label for="retention"><strong>Conservar mensajes:</strong> <span id="ret-value"></span></label>
      <input id="retention" type="range" min="3" max="12" step="3" value="12" list="ret-ticks" />
      <datalist id="ret-ticks"><option value="3"></option><option value="6"></option><option value="9"></option><option value="12"></option></datalist>
      <div class="ticks"><span>3</span><span>6</span><span>9</span><span>12</span></div>
      <p id="ret-note" class="muted"></p>
      <p id="ret-last" class="muted"></p>
    </div>
    <div class="card">
      <strong>Chats excluidos</strong>
      <p class="muted">
        Sus mensajes se borran, los nuevos no se guardan y la IA nunca puede leerlos. Al quitar la exclusión solo se
        guardan los mensajes que lleguen después.
      </p>
      <input id="search" type="search" placeholder="Buscar contacto o escribir número" autocomplete="off" />
      <ul id="results" class="list"></ul>
      <p id="excluded-empty" class="muted">No hay chats excluidos.</p>
      <ul id="excluded" class="list"></ul>
    </div>
    ${script}
  </body>
</html>`
