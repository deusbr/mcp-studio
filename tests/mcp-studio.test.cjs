'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const {
  inspectOpenApiSpec,
  parseHelpText,
  buildWindowsAppBlueprint,
  StudioStore,
  probeMcpServer,
  callMcpTool,
  runGeneratedTests,
  installMcpServerToClients,
  createStudioWebServer
} = require('../index.cjs');

test('OpenAPI spec generates tested MCP server and executes live HTTP tool over stdio', async (t) => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-studio-openapi-'));
  t.after(() => fs.rmSync(tmpHome, { recursive: true, force: true }));

  const mockApi = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/items/42?verbose=true') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: '42', ok: true, auth: req.headers.authorization || null }));
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise((resolve) => mockApi.listen(0, '127.0.0.1', resolve));
  t.after(() => mockApi.close());
  const port = mockApi.address().port;

  const spec = {
    openapi: '3.0.0',
    info: { title: 'Widget Service', version: '1.0.0' },
    servers: [{ url: `http://127.0.0.1:${port}` }],
    paths: {
      '/items/{id}': {
        get: {
          operationId: 'getWidgetById',
          summary: 'Fetch widget by ID',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'verbose', in: 'query', required: false, schema: { type: 'boolean' } }
          ]
        }
      }
    }
  };

  const bp = inspectOpenApiSpec({ spec });
  assert.equal(bp.name, 'widget-service-mcp');
  assert.equal(bp.tools.length, 1);
  assert.equal(bp.tools[0].name, 'get_widget_by_id');

  const store = new StudioStore(tmpHome);
  const project = store.createProject(bp);
  assert.ok(fs.existsSync(project.serverPath));

  const testRes = await runGeneratedTests(project.outputDir);
  assert.equal(testRes.passed, true, testRes.stderr);

  const probe = await probeMcpServer({ serverPath: project.serverPath });
  assert.equal(probe.ok, true);
  assert.equal(probe.toolCount, 1);
  assert.ok(probe.estimatedSchemaTokens > 10);

  const call = await callMcpTool({
    serverPath: project.serverPath,
    toolName: 'get_widget_by_id',
    arguments: { id: '42', verbose: true }
  });
  assert.equal(call.ok, true);
  const parsed = JSON.parse(call.result.content[0].text);
  assert.equal(parsed.status, 200);
  assert.equal(parsed.data.id, '42');
});

test('CLI help parser builds safe node wrapper MCP and executes live command', async (t) => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-studio-cli-'));
  t.after(() => fs.rmSync(tmpHome, { recursive: true, force: true }));

  const sampleHelp = `Usage: node [options]
Options:
  -v, --version   print Node.js version
  -e, --eval      evaluate script

Commands:
  check           syntax check script
`;
  const bp = parseHelpText(process.execPath, sampleHelp);
  assert.equal(bp.targetType, 'cli');
  assert.ok(bp.tools.some((tool) => tool.cli.fixedArgs[0] === '--help'));

  const store = new StudioStore(tmpHome);
  const project = store.createProject({ ...bp, name: 'node-cli-mcp' });
  const helpTool = project.blueprint.tools.find((tool) => tool.cli.fixedArgs[0] === '--help');

  const call = await callMcpTool({
    serverPath: project.serverPath,
    toolName: helpTool.name,
    arguments: {}
  });
  assert.equal(call.ok, true);
  const out = JSON.parse(call.result.content[0].text);
  assert.equal(out.exitCode, 0);
  assert.match(out.stdout, /Usage:/i);
});

test('Windows app preset generates valid MCP server and atomic client installer works', async (t) => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-studio-win-'));
  t.after(() => fs.rmSync(tmpHome, { recursive: true, force: true }));

  const bp = buildWindowsAppBlueprint({ preset: 'excel-com' });
  assert.equal(bp.targetType, 'windows-app');
  assert.ok(bp.tools.some((tool) => tool.windowsAction === 'excel-list'));
  assert.ok(bp.tools.some((tool) => tool.windowsAction === 'excel-read-range'));

  const store = new StudioStore(tmpHome);
  const project = store.createProject(bp);
  const testRes = await runGeneratedTests(project.outputDir);
  assert.equal(testRes.passed, true);

  const codexToml = path.join(tmpHome, 'codex-config.toml');
  const geminiJson = path.join(tmpHome, 'gemini-settings.json');
  const results = installMcpServerToClients({
    serverName: project.slug,
    mcpServerScript: project.serverPath,
    targets: [
      { id: 'codex', name: 'Codex', format: 'toml', configPath: codexToml, skillDir: null },
      { id: 'gemini', name: 'Gemini CLI', format: 'json', configPath: geminiJson, skillDir: null }
    ]
  });

  assert.equal(results.every((r) => r.mcpInstalled), true);
  assert.match(fs.readFileSync(codexToml, 'utf8'), /\[mcp_servers\.microsoft-excel-mcp\]/);
  const parsedGemini = JSON.parse(fs.readFileSync(geminiJson, 'utf8'));
  assert.equal(parsedGemini.mcpServers['microsoft-excel-mcp'].args[0], project.serverPath);
});

test('Local Web Studio serves UI and generates/probes projects via HTTP API', async (t) => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-studio-web-'));
  t.after(() => fs.rmSync(tmpHome, { recursive: true, force: true }));

  const store = new StudioStore(tmpHome);
  const web = createStudioWebServer({ store, port: 0 });
  const info = await web.listen();
  t.after(() => web.close());

  const homeRes = await fetch(info.url);
  assert.equal(homeRes.status, 200);
  assert.match(await homeRes.text(), /MCP STUDIO/);

  const genRes = await fetch(`${info.url}/api/generate/windows-app`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ preset: 'word-com' })
  });
  assert.equal(genRes.status, 201);
  const { project } = await genRes.json();

  const probeRes = await fetch(`${info.url}/api/projects/${project.slug}/probe`, { method: 'POST' });
  assert.equal(probeRes.status, 200);
  const probeData = await probeRes.json();
  assert.equal(probeData.probe.ok, true);
  assert.equal(probeData.probe.toolCount, project.toolCount);
});
