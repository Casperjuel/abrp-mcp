/**
 * OAuth login page. Renders an HTML form where the user pastes their ABRP
 * credentials; on submit the server validates the API key and issues an
 * authorization code. The OAuth protocol params ride along as hidden fields.
 */

export interface LoginFields {
  client_id: string;
  redirect_uri: string;
  state: string;
  code_challenge: string;
  code_challenge_method: string;
  scope: string;
  response_type: string;
}

export interface LoginPageOptions {
  fields: LoginFields;
  /** Pre-fill values when re-showing the form after an error. */
  values?: { api_key?: string; session?: string; tlm_token?: string; user_token?: string };
  error?: string;
}

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderLoginPage({ fields, values = {}, error }: LoginPageOptions): string {
  const hidden = Object.entries(fields)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v ?? "")}" />`)
    .join("\n      ");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Connect ABRP MCP</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      margin: 0; min-height: 100dvh; display: grid; place-items: center;
      background: #0b1220; color: #e7ecf3; padding: 24px;
    }
    .card {
      width: 100%; max-width: 460px; background: #131c2e; border: 1px solid #243049;
      border-radius: 16px; padding: 28px; box-shadow: 0 20px 60px rgba(0,0,0,.35);
    }
    h1 { font-size: 20px; margin: 0 0 4px; }
    p.sub { margin: 0 0 20px; color: #9fb0c8; font-size: 13px; }
    label { display: block; font-weight: 600; font-size: 13px; margin: 16px 0 6px; }
    .hint { font-weight: 400; color: #8295b0; }
    input[type=text], input[type=password] {
      width: 100%; padding: 11px 12px; border-radius: 10px; border: 1px solid #2c3a57;
      background: #0e1626; color: #e7ecf3; font-size: 14px;
    }
    input:focus { outline: 2px solid #3b82f6; border-color: transparent; }
    details { margin-top: 16px; border-top: 1px solid #243049; padding-top: 12px; }
    summary { cursor: pointer; color: #9fb0c8; font-size: 13px; font-weight: 600; }
    button {
      margin-top: 22px; width: 100%; padding: 12px; border: 0; border-radius: 10px;
      background: #3b82f6; color: #fff; font-size: 15px; font-weight: 600; cursor: pointer;
    }
    button:hover { background: #2f6fe0; }
    .error {
      background: #3a1622; border: 1px solid #6b2336; color: #ffc7d1;
      padding: 10px 12px; border-radius: 10px; font-size: 13px; margin-bottom: 16px;
    }
    a { color: #7fb0ff; }
    .foot { margin-top: 18px; font-size: 12px; color: #8295b0; text-align: center; }
  </style>
</head>
<body>
  <form class="card" method="post" action="/authorize">
    <h1>Connect to ABRP</h1>
    <p class="sub">Authorize this MCP server with your A Better Route Planner / Iternio API credentials. Nothing is stored server-side — your key is sealed into the access token.</p>
    ${error ? `<div class="error">${esc(error)}</div>` : ""}
    ${hidden}

    <label for="api_key">ABRP Planning API key <span class="hint">(required)</span></label>
    <input id="api_key" name="api_key" type="password" autocomplete="off" spellcheck="false"
      value="${esc(values.api_key ?? "")}" placeholder="X-API-KEY — request one from contact@iternio.com" />

    <details>
      <summary>Optional: session &amp; telemetry tokens</summary>
      <label for="session">ABRP user session <span class="hint">(X-ABRP-SESSION — for listing your vehicles)</span></label>
      <input id="session" name="session" type="password" autocomplete="off" spellcheck="false"
        value="${esc(values.session ?? "")}" placeholder="optional" />

      <label for="user_token">ABRP user token <span class="hint">(for v1 live telemetry /tlm/send)</span></label>
      <input id="user_token" name="user_token" type="password" autocomplete="off" spellcheck="false"
        value="${esc(values.user_token ?? "")}" placeholder="optional — from ABRP app → Settings → Live Data" />

      <label for="tlm_token">Telemetry token <span class="hint">(X-TLM-TOKEN — v2 telemetry)</span></label>
      <input id="tlm_token" name="tlm_token" type="password" autocomplete="off" spellcheck="false"
        value="${esc(values.tlm_token ?? "")}" placeholder="optional" />
    </details>

    <button type="submit">Authorize</button>
    <p class="foot">Unofficial · not affiliated with Iternio · <a href="https://www.iternio.com/api" target="_blank" rel="noreferrer">about the API</a></p>
  </form>
</body>
</html>`;
}
