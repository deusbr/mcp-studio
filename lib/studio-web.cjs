'use strict';

const http = require('node:http');
const {
  TARGET_TEMPLATES,
  WINDOWS_PRESETS,
  inspectOpenApiSpec,
  inspectCliHelp,
  inspectWindowsApps,
  buildWindowsAppBlueprint
} = require('./blueprints.cjs');
const { probeMcpServer, callMcpTool, runGeneratedTests } = require('./prober.cjs');
const { installMcpServerToClients } = require('./installers.cjs');

const MAX_BODY_BYTES = 8 * 1024 * 1024;

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(JSON.stringify(data));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('Request body exceeds 8 MB limit.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(raw.trim() ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Invalid JSON request body.'));
      }
    });
    req.on('error', reject);
  });
}

function renderWebHtml() {
  const presetOptions = Object.values(WINDOWS_PRESETS)
    .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.appName)} (${escapeHtml(p.id)})</option>`)
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>MCP Studio — Build MCPs for Apps Without One</title>
<style>
  :root {
    --bg: #0b0e14; --panel: #131823; --panel-2: #1b2232; --border: #2a344b;
    --text: #edf2f8; --muted: #93a3be; --accent: #38bdf8; --ok: #10b981; --warn: #f59e0b;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background: var(--bg); color: var(--text); }
  header { padding: 14px 20px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; background: #0e131c; }
  header h1 { margin: 0; font-size: 16px; letter-spacing: 0.3px; }
  .layout { display: grid; grid-template-columns: 360px 1fr; min-height: calc(100vh - 52px); }
  aside { border-right: 1px solid var(--border); padding: 14px; background: var(--panel); display: flex; flex-direction: column; gap: 14px; overflow-y: auto; }
  main { padding: 18px; display: flex; flex-direction: column; gap: 16px; overflow-y: auto; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 14px; }
  .card h2, .card h3 { margin: 0 0 10px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.6px; color: var(--muted); }
  label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 4px; }
  input, select, textarea { width: 100%; background: var(--panel-2); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 8px; font-size: 12px; margin-bottom: 10px; font-family: inherit; }
  textarea { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
  button { background: var(--accent); color: #09101a; border: none; border-radius: 6px; padding: 8px 11px; font-weight: 600; font-size: 12px; cursor: pointer; }
  button.secondary { background: var(--panel-2); color: var(--text); border: 1px solid var(--border); }
  button.ok { background: var(--ok); color: #071912; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .tabs { display: flex; gap: 6px; margin-bottom: 10px; }
  .tab { flex: 1; text-align: center; padding: 6px; border-radius: 6px; background: var(--panel-2); border: 1px solid var(--border); font-size: 11px; cursor: pointer; color: var(--muted); }
  .tab.active { border-color: var(--accent); color: var(--text); font-weight: 600; }
  .proj-item { padding: 10px; border: 1px solid var(--border); border-radius: 8px; margin-bottom: 8px; cursor: pointer; background: var(--panel-2); }
  .proj-item.active { border-color: var(--accent); }
  .badge { display: inline-block; padding: 2px 7px; border-radius: 99px; font-size: 11px; background: #263147; color: var(--text); }
  .badge.ok { background: rgba(16,185,129,0.2); color: var(--ok); }
  .tool-card { background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px; padding: 10px; margin-bottom: 10px; }
  pre { white-space: pre-wrap; word-break: break-word; background: #090c12; padding: 10px; border-radius: 6px; border: 1px solid var(--border); font-size: 12px; margin: 6px 0; }
</style>
</head>
<body>
<header>
  <h1>MCP STUDIO <span class="badge">OpenAPI · CLI · Windows Desktop -> MCP</span></h1>
  <span id="statusText" style="color:var(--muted);font-size:12px;">Local Workbench Ready</span>
</header>
<div class="layout">
  <aside>
    <div class="card">
      <h3>Create MCP for Any App</h3>
      <div class="tabs">
        <div class="tab active" data-tab="openapi">OpenAPI</div>
        <div class="tab" data-tab="cli">CLI</div>
        <div class="tab" data-tab="windows">Windows App</div>
      </div>
      <div id="pane-openapi">
        <label>OpenAPI 3.x / Swagger JSON</label>
        <textarea id="openapiInput" rows="7" placeholder='{"openapi":"3.0.0","info":{"title":"My App"},...}'></textarea>
        <div class="row">
          <button id="buildOpenApiBtn" type="button">Generate MCP</button>
          <button id="sampleOpenApiBtn" class="secondary" type="button">Load Sample</button>
        </div>
      </div>
      <div id="pane-cli" style="display:none;">
        <label>CLI Command (e.g. git, node, docker)</label>
        <input id="cliCmdInput" placeholder="git" />
        <label>Help Flag</label>
        <input id="cliFlagInput" value="--help" />
        <button id="buildCliBtn" type="button">Inspect &amp; Generate MCP</button>
      </div>
      <div id="pane-windows" style="display:none;">
        <label>Preset or Custom App</label>
        <select id="winPresetSelect">${presetOptions}</select>
        <label>Custom App Name (optional)</label>
        <input id="winAppNameInput" placeholder="e.g. ERP Desktop" />
        <label>Process Name (optional, without .exe)</label>
        <input id="winProcInput" placeholder="e.g. notepad" />
        <div class="row">
          <button id="buildWinBtn" type="button">Generate Bridge</button>
          <button id="scanWinBtn" class="secondary" type="button">Scan Windows</button>
        </div>
        <div id="winScanList" style="margin-top:8px;font-size:11px;color:var(--muted);"></div>
      </div>
    </div>
    <div class="card" style="flex:1;overflow-y:auto;">
      <h3>Generated MCP Servers</h3>
      <div id="projectsList">No generated servers yet.</div>
    </div>
  </aside>
  <main id="mainStage">
    <div class="card">
      <h2>MCP Studio Workbench</h2>
      <p style="color:var(--muted);font-size:13px;">Choose OpenAPI, CLI, or Windows Desktop App on the left to scaffold a tested zero-dependency MCP server, inspect its token footprint, run live tool calls, and install it into Codex, Gemini CLI, or Claude.</p>
    </div>
  </main>
</div>
<script>
const state = { projects: [], activeSlug: null, tab: 'openapi' };
function esc(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
async function api(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
  state.tab = t.dataset.tab;
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === state.tab));
  ['openapi', 'cli', 'windows'].forEach((id) => {
    document.getElementById('pane-' + id).style.display = id === state.tab ? 'block' : 'none';
  });
}));
async function refresh() {
  const data = await api('/api/projects');
  state.projects = data.projects || [];
  if (!state.activeSlug && state.projects.length) state.activeSlug = state.projects[0].slug;
  renderSidebar();
  renderMain();
}
function renderSidebar() {
  const el = document.getElementById('projectsList');
  if (!state.projects.length) { el.innerHTML = '<div style="color:var(--muted);font-size:12px;">No generated servers yet.</div>'; return; }
  el.innerHTML = state.projects.map((p) =>
    '<div class="proj-item ' + (p.slug === state.activeSlug ? 'active' : '') + '" data-slug="' + esc(p.slug) + '">' +
    '<div style="font-size:13px;font-weight:600;">' + esc(p.slug) + '</div>' +
    '<div class="row" style="margin-top:4px;"><span class="badge">' + esc(p.targetType) + '</span><span class="badge">' + p.toolCount + ' tools</span>' +
    (p.lastTest?.passed ? '<span class="badge ok">tests pass</span>' : '') + '</div></div>'
  ).join('');
  el.querySelectorAll('.proj-item').forEach((n) => n.addEventListener('click', () => {
    state.activeSlug = n.dataset.slug;
    renderSidebar();
    renderMain();
  }));
}
function renderMain() {
  const main = document.getElementById('mainStage');
  const p = state.projects.find((x) => x.slug === state.activeSlug);
  if (!p) return;
  const toolsHtml = (p.blueprint?.tools || []).map((t) =>
    '<div class="tool-card">' +
      '<div class="row"><strong>' + esc(t.name) + '</strong><span class="badge">' + (t.readOnly ? 'read-only' : 'action') + '</span></div>' +
      '<div style="color:var(--muted);font-size:12px;margin:4px 0;">' + esc(t.description) + '</div>' +
      '<label>Arguments JSON</label>' +
      '<textarea class="tool-args" data-tool="' + esc(t.name) + '" rows="2">{}</textarea>' +
      '<button class="secondary run-tool-btn" data-tool="' + esc(t.name) + '" type="button">Call Tool Live</button>' +
      '<pre id="out-' + esc(t.name) + '" style="display:none;"></pre>' +
    '</div>'
  ).join('');
  main.innerHTML =
    '<div class="card">' +
      '<div class="row" style="justify-content:space-between;">' +
        '<div><h2 style="margin-bottom:4px;">' + esc(p.appName) + ' (' + esc(p.slug) + ')</h2><div style="color:var(--muted);font-size:12px;">' + esc(p.outputDir) + '</div></div>' +
        '<div class="row">' +
          '<button id="probeBtn" type="button">Probe Handshake</button>' +
          '<button id="testBtn" class="secondary" type="button">Run Tests</button>' +
          '<button id="installBtn" class="ok" type="button">Install to Clients</button>' +
        '</div>' +
      '</div>' +
      '<pre id="actionResult" style="margin-top:10px;">' + esc(JSON.stringify({ lastProbe: p.lastProbe ? { toolCount: p.lastProbe.toolCount, estimatedSchemaTokens: p.lastProbe.estimatedSchemaTokens, latencyMs: p.lastProbe.latencyMs } : null, lastTest: p.lastTest }, null, 2)) + '</pre>' +
    '</div>' +
    '<div class="card"><h2>Generated Tools (' + (p.blueprint?.tools?.length || 0) + ')</h2>' + toolsHtml + '</div>';

  document.getElementById('probeBtn').addEventListener('click', async () => {
    const res = await api('/api/projects/' + encodeURIComponent(p.slug) + '/probe', { method: 'POST' });
    document.getElementById('actionResult').textContent = JSON.stringify(res, null, 2);
    await refresh();
  });
  document.getElementById('testBtn').addEventListener('click', async () => {
    const res = await api('/api/projects/' + encodeURIComponent(p.slug) + '/test', { method: 'POST' });
    document.getElementById('actionResult').textContent = JSON.stringify(res, null, 2);
    await refresh();
  });
  document.getElementById('installBtn').addEventListener('click', async () => {
    const res = await api('/api/projects/' + encodeURIComponent(p.slug) + '/install', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    document.getElementById('actionResult').textContent = JSON.stringify(res, null, 2);
  });
  main.querySelectorAll('.run-tool-btn').forEach((btn) => btn.addEventListener('click', async () => {
    const toolName = btn.dataset.tool;
    const argsTxt = main.querySelector('.tool-args[data-tool="' + toolName + '"]').value;
    const outEl = document.getElementById('out-' + toolName);
    outEl.style.display = 'block';
    outEl.textContent = 'Running...';
    try {
      const res = await api('/api/projects/' + encodeURIComponent(p.slug) + '/call', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ toolName, arguments: JSON.parse(argsTxt || '{}') })
      });
      outEl.textContent = JSON.stringify(res, null, 2);
    } catch (e) {
      outEl.textContent = e.message;
    }
  }));
}
document.getElementById('sampleOpenApiBtn').addEventListener('click', () => {
  document.getElementById('openapiInput').value = JSON.stringify({
    openapi: '3.0.0',
    info: { title: 'Internal Inventory API', version: '1.0.0' },
    servers: [{ url: 'https://httpbin.org' }],
    paths: {
      '/get': { get: { operationId: 'getInventoryStatus', summary: 'Fetch live inventory status' } },
      '/post': { post: { operationId: 'createInventoryItem', summary: 'Create inventory item', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { sku: { type: 'string' }, qty: { type: 'integer' } }, required: ['sku'] } } } } } }
    }
  }, null, 2);
});
document.getElementById('buildOpenApiBtn').addEventListener('click', async () => {
  const res = await api('/api/generate/openapi', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ spec: document.getElementById('openapiInput').value }) });
  state.activeSlug = res.project.slug;
  await refresh();
});
document.getElementById('buildCliBtn').addEventListener('click', async () => {
  const res = await api('/api/generate/cli', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command: document.getElementById('cliCmdInput').value, helpArgs: [document.getElementById('cliFlagInput').value || '--help'] }) });
  state.activeSlug = res.project.slug;
  await refresh();
});
document.getElementById('scanWinBtn').addEventListener('click', async () => {
  const res = await api('/api/inspect/windows');
  document.getElementById('winScanList').innerHTML = (res.apps || []).slice(0, 8).map((a) => '<div>• <strong>' + esc(a.processName) + '</strong>: ' + esc(a.windowTitle) + '</div>').join('') || 'No GUI windows found.';
});
document.getElementById('buildWinBtn').addEventListener('click', async () => {
  const res = await api('/api/generate/windows-app', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ preset: document.getElementById('winPresetSelect').value, appName: document.getElementById('winAppNameInput').value || undefined, processName: document.getElementById('winProcInput').value || undefined })
  });
  state.activeSlug = res.project.slug;
  await refresh();
});
refresh().catch((e) => { document.getElementById('statusText').textContent = e.message; });
</script>
</body>
</html>`;
}

function createStudioWebServer({ store, port = 4325 } = {}) {
  const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = parsedUrl.pathname;

    try {
      if (req.method === 'GET' && pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(renderWebHtml());
        return;
      }

      if (req.method === 'GET' && pathname === '/api/health') {
        sendJson(res, 200, { ok: true, studioHome: store.studioHome, projectCount: store.listProjects().length });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/templates') {
        sendJson(res, 200, { templates: Object.values(TARGET_TEMPLATES), windowsPresets: Object.values(WINDOWS_PRESETS) });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/inspect/windows') {
        sendJson(res, 200, inspectWindowsApps());
        return;
      }

      if (req.method === 'GET' && pathname === '/api/projects') {
        sendJson(res, 200, { projects: store.listProjects() });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/generate/openapi') {
        const body = await readJsonBody(req);
        const bp = inspectOpenApiSpec({ spec: body.spec, specPath: body.specPath, maxTools: body.maxTools });
        const project = store.createProject(bp, { outputDir: body.outputDir });
        sendJson(res, 201, { project });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/generate/cli') {
        const body = await readJsonBody(req);
        const bp = inspectCliHelp({ command: body.command, helpArgs: body.helpArgs, helpText: body.helpText });
        const project = store.createProject(bp, { outputDir: body.outputDir });
        sendJson(res, 201, { project });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/generate/windows-app') {
        const body = await readJsonBody(req);
        const bp = buildWindowsAppBlueprint(body);
        const project = store.createProject(bp, { outputDir: body.outputDir });
        sendJson(res, 201, { project });
        return;
      }

      const projMatch = pathname.match(/^\/api\/projects\/([a-z0-9][a-z0-9_-]{1,63})(?:\/(.*))?$/);
      if (projMatch) {
        const slug = projMatch[1];
        const sub = projMatch[2] || '';
        const project = store.getProject(slug);

        if (req.method === 'GET' && !sub) {
          sendJson(res, 200, { project });
          return;
        }
        if (req.method === 'POST' && sub === 'probe') {
          const probe = await probeMcpServer({ serverPath: project.serverPath });
          const updated = store.updateProject(slug, { lastProbe: probe });
          sendJson(res, 200, { probe, project: updated });
          return;
        }
        if (req.method === 'POST' && sub === 'test') {
          const testResult = await runGeneratedTests(project.outputDir);
          const updated = store.updateProject(slug, { lastTest: testResult });
          sendJson(res, 200, { test: testResult, project: updated });
          return;
        }
        if (req.method === 'POST' && sub === 'call') {
          const body = await readJsonBody(req);
          const callRes = await callMcpTool({
            serverPath: project.serverPath,
            toolName: body.toolName,
            arguments: body.arguments || {}
          });
          sendJson(res, 200, callRes);
          return;
        }
        if (req.method === 'POST' && sub === 'install') {
          const body = await readJsonBody(req);
          const results = installMcpServerToClients({
            serverName: project.slug,
            mcpServerScript: project.serverPath,
            clientIds: body.clients || null
          });
          sendJson(res, 200, { results });
          return;
        }
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      const status = /not found/i.test(err.message) ? 404 : /invalid|missing|required/i.test(err.message) ? 400 : 500;
      sendJson(res, status, { error: err.message });
    }
  });

  return {
    server,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          const addr = server.address();
          resolve({ port: addr.port, url: `http://127.0.0.1:${addr.port}` });
        });
      }),
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

module.exports = {
  createStudioWebServer
};
