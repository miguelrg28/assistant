import { html, raw } from 'hono/html'
import { AUTH_BASE_PATH } from './auth.js'

const style = raw(`<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { max-width: 360px; margin: 12vh auto; padding: 0 16px; }
  h1 { font-size: 1.2rem; }
  label { display: block; margin: 12px 0 4px; font-size: .9rem; }
  input { width: 100%; box-sizing: border-box; padding: 8px; font-size: 1rem; }
  button { margin-top: 16px; padding: 8px 14px; font-size: 1rem; cursor: pointer; }
  .row { display: flex; gap: 8px; }
  #error { color: #c62828; min-height: 1.2em; font-size: .9rem; }
</style>`)

// Posts the signed OAuth query the provider put on this page's URL, then follows the redirect it returns.
// Outside the OAuth flow (/login?next=/whatsapp) it signs in and goes back to that same-origin path.
const flowScript = raw(`<script>
  async function post(path, body) {
    const back = new URLSearchParams(location.search).get('next');
    const local = back && /^\\/(?![\\/\\\\])/.test(back) ? back : null;
    const res = await fetch('${AUTH_BASE_PATH}' + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(local ? body : { ...body, oauth_query: location.search.slice(1) }),
    });
    const data = await res.json().catch(() => ({}));
    const next = local || data.url || data.redirect_uri;
    if (res.ok && next) { location.href = next; return; }
    document.getElementById('error').textContent = data.message || data.error_description || 'Something went wrong';
  }
</script>`)

export const loginPage = () => html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>Sign in · WhatsApp MCP</title>
    ${style}
  </head>
  <body>
    <h1>Sign in to your WhatsApp archive</h1>
    <form id="f">
      <label for="email">Email</label>
      <input id="email" type="email" autocomplete="username" required />
      <label for="password">Password</label>
      <input id="password" type="password" autocomplete="current-password" required />
      <button type="submit">Sign in</button>
      <p id="error" role="alert"></p>
    </form>
    ${flowScript}
    <script>
      document.getElementById('f').addEventListener('submit', (e) => {
        e.preventDefault();
        post('/sign-in/email', {
          email: document.getElementById('email').value,
          password: document.getElementById('password').value,
        });
      });
    </script>
  </body>
</html>`

export const consentPage = (clientName: string) => html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>Authorize · WhatsApp MCP</title>
    ${style}
  </head>
  <body>
    <h1>Allow <strong>${clientName}</strong> to read your WhatsApp archive?</h1>
    <p>It gets read-only access to your stored chats. It cannot send messages.</p>
    <div class="row">
      <button id="allow">Allow</button>
      <button id="deny">Deny</button>
    </div>
    <p id="error" role="alert"></p>
    ${flowScript}
    <script>
      document.getElementById('allow').onclick = () => post('/oauth2/consent', { accept: true });
      document.getElementById('deny').onclick = () => post('/oauth2/consent', { accept: false });
    </script>
  </body>
</html>`
