'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { normalizeBlueprint } = require('./blueprints.cjs');

function renderGeneratedPackageJson(bp) {
  return JSON.stringify(
    {
      name: bp.name,
      version: '0.1.0',
      description: bp.description,
      main: 'bin/mcp-server.cjs',
      bin: {
        [bp.name]: './bin/mcp-server.cjs'
      },
      scripts: {
        check: 'node --check bin/mcp-server.cjs && node --check lib/tools.cjs && node --check tests/server.test.cjs',
        test: 'node --test tests/server.test.cjs'
      },
      keywords: ['mcp', 'model-context-protocol', bp.targetType, 'generated-by-mcp-studio'],
      license: 'MIT',
      engines: { node: '>=18.0.0' }
    },
    null,
    2
  ) + '\n';
}

function renderGeneratedServerCjs(bp) {
  return `#!/usr/bin/env node
'use strict';

const readline = require('node:readline');
const { TOOLS, executeTool } = require('../lib/tools.cjs');

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
}

function respondError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\\n');
}

async function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') return;

  if (msg.method === 'initialize') {
    return respond(msg.id, {
      protocolVersion: '2024-11-05',
      serverInfo: { name: ${JSON.stringify(bp.name)}, version: '0.1.0' },
      capabilities: { tools: {} }
    });
  }

  if (msg.method === 'notifications/initialized') return;

  if (msg.method === 'tools/list') {
    return respond(msg.id, {
      tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
    });
  }

  if (msg.method === 'tools/call') {
    const { name, arguments: args = {} } = msg.params || {};
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) {
      return respondError(msg.id, -32601, \`Unknown tool: \${name}\`);
    }
    try {
      const output = await executeTool(tool, args);
      return respond(msg.id, {
        content: [{ type: 'text', text: typeof output === 'string' ? output : JSON.stringify(output, null, 2) }]
      });
    } catch (err) {
      return respond(msg.id, {
        isError: true,
        content: [{ type: 'text', text: err.message }]
      });
    }
  }

  if (msg.id !== undefined) {
    respondError(msg.id, -32601, \`Method not found: \${msg.method}\`);
  }
}

if (require.main === module) {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const msg = JSON.parse(trimmed);
      handleMessage(msg).catch((err) => {
        if (msg && msg.id !== undefined) respondError(msg.id, -32603, err.message);
      });
    } catch {}
  });
}

module.exports = { handleMessage };
`;
}

function renderGeneratedToolsCjs(bp) {
  return `'use strict';

const { execFile } = require('node:child_process');

const SERVER_CONFIG = ${JSON.stringify(bp.config, null, 2)};
const TOOLS = ${JSON.stringify(bp.tools, null, 2)};

function runExecFile(cmd, args, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1024 * 1024, shell: false, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        return reject(new Error(\`\${err.message}\${stderr ? ': ' + stderr.trim() : ''}\`));
      }
      resolve({ exitCode: 0, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() });
    });
  });
}

function runPowerShell(script, timeoutMs = 10000) {
  if (process.platform !== 'win32') {
    throw new Error(\`Windows desktop automation requires win32 (current platform: \${process.platform}).\`);
  }
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return runExecFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], timeoutMs);
}

function psSingleQuote(value) {
  return "'" + String(value ?? '').replace(/'/g, "''") + "'";
}

async function runHttpTool(tool, args = {}) {
  const httpSpec = tool.http || {};
  const baseUrl = (process.env.MCP_BASE_URL || SERVER_CONFIG.baseUrl || '').replace(/\\/+$/, '');
  if (!baseUrl) throw new Error('Missing baseUrl in SERVER_CONFIG or MCP_BASE_URL.');

  let route = httpSpec.path || '/';
  for (const paramName of httpSpec.pathParams || []) {
    if (args[paramName] === undefined || args[paramName] === null || args[paramName] === '') {
      throw new Error(\`Missing required path parameter: \${paramName}\`);
    }
    route = route.replace(\`{\${paramName}}\`, encodeURIComponent(String(args[paramName])));
  }

  const url = new URL(\`\${baseUrl}\${route.startsWith('/') ? route : '/' + route}\`);
  for (const qName of httpSpec.queryParams || []) {
    if (args[qName] !== undefined && args[qName] !== null) {
      url.searchParams.set(qName, String(args[qName]));
    }
  }

  const headers = { accept: 'application/json' };
  const authEnv = SERVER_CONFIG.authEnvVar;
  if (authEnv && process.env[authEnv]) {
    const headerName = SERVER_CONFIG.authHeader || 'Authorization';
    const prefix = SERVER_CONFIG.authPrefix ?? 'Bearer ';
    headers[headerName] = \`\${prefix}\${process.env[authEnv]}\`;
  }

  const init = {
    method: httpSpec.method || 'GET',
    headers,
    signal: AbortSignal.timeout(SERVER_CONFIG.timeoutMs || 15000)
  };

  if (httpSpec.hasBody && args.body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(args.body);
  }

  const res = await fetch(url, init);
  const raw = await res.text();
  let parsed = raw;
  try { parsed = raw ? JSON.parse(raw) : null; } catch {}
  if (!res.ok) {
    throw new Error(\`HTTP \${res.status}: \${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}\`);
  }
  return { status: res.status, data: parsed };
}

async function runCliTool(tool, args = {}) {
  const command = SERVER_CONFIG.command;
  if (!command) throw new Error('Missing CLI command in SERVER_CONFIG.');
  const cliSpec = tool.cli || {};
  const finalArgs = [...(cliSpec.fixedArgs || [])];
  if (cliSpec.allowExtraArgs && Array.isArray(args.args)) {
    for (const item of args.args) {
      finalArgs.push(String(item));
    }
  }
  return runExecFile(command, finalArgs, SERVER_CONFIG.timeoutMs || 15000);
}

async function runWindowsTool(tool, args = {}) {
  const proc = SERVER_CONFIG.processName;
  const exe = SERVER_CONFIG.executablePath || proc;
  const timeout = SERVER_CONFIG.timeoutMs || 10000;
  const action = tool.windowsAction;

  if (action === 'status') {
    const script = \`Get-Process -Name \${psSingleQuote(proc)} -ErrorAction SilentlyContinue | Select-Object ProcessName,Id,MainWindowTitle,WorkingSet64 | ConvertTo-Json -Compress\`;
    const res = await runPowerShell(script, timeout);
    return { running: Boolean(res.stdout), processes: res.stdout ? JSON.parse(res.stdout) : [] };
  }

  if (action === 'launch') {
    const extra = Array.isArray(args.arguments) && args.arguments.length
      ? ' -ArgumentList @(' + args.arguments.map((a) => psSingleQuote(a)).join(',') + ')'
      : '';
    await runPowerShell(\`Start-Process -FilePath \${psSingleQuote(exe)}\${extra}\`, timeout);
    return { launched: true, target: exe };
  }

  if (action === 'focus') {
    const script = [
      'Add-Type -MemberDefinition "[DllImport(\\"user32.dll\\")] public static extern bool SetForegroundWindow(IntPtr hWnd);" -Name Win32Focus -Namespace MCP;',
      \`$p = Get-Process -Name \${psSingleQuote(proc)} -ErrorAction Stop | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1;\`,
      'if (-not $p) { throw "No active window found." }',
      '[MCP.Win32Focus]::SetForegroundWindow($p.MainWindowHandle) | Out-Null;',
      '@{ focused = $true; pid = $p.Id; title = $p.MainWindowTitle } | ConvertTo-Json -Compress'
    ].join(' ');
    const res = await runPowerShell(script, timeout);
    return JSON.parse(res.stdout || '{"focused":true}');
  }

  if (action === 'hotkey') {
    const allowed = Array.isArray(SERVER_CONFIG.allowedHotkeys) ? SERVER_CONFIG.allowedHotkeys : [];
    if (!allowed.includes(args.keys)) {
      throw new Error(\`Hotkey not in allowlist: \${args.keys}\`);
    }
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms;',
      'Add-Type -MemberDefinition "[DllImport(\\"user32.dll\\")] public static extern bool SetForegroundWindow(IntPtr hWnd);" -Name Win32Keys -Namespace MCP;',
      \`$p = Get-Process -Name \${psSingleQuote(proc)} -ErrorAction Stop | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1;\`,
      'if (-not $p) { throw "No active window found." }',
      '[MCP.Win32Keys]::SetForegroundWindow($p.MainWindowHandle) | Out-Null;',
      'Start-Sleep -Milliseconds 150;',
      \`[System.Windows.Forms.SendKeys]::SendWait(\${psSingleQuote(args.keys)});\`,
      \`@{ sent = \${psSingleQuote(args.keys)} } | ConvertTo-Json -Compress\`
    ].join(' ');
    const res = await runPowerShell(script, timeout);
    return JSON.parse(res.stdout || '{"sent":true}');
  }

  if (action === 'excel-list') {
    const script = [
      '$excel = [Runtime.InteropServices.Marshal]::GetActiveObject("Excel.Application");',
      '$out = @(); foreach ($wb in $excel.Workbooks) { $sheets = @(); foreach ($ws in $wb.Worksheets) { $sheets += $ws.Name }; $out += @{ name = $wb.Name; sheets = $sheets } };',
      '$out | ConvertTo-Json -Depth 4 -Compress'
    ].join(' ');
    const res = await runPowerShell(script, timeout);
    return { workbooks: res.stdout ? JSON.parse(res.stdout) : [] };
  }

  if (action === 'excel-read-range') {
    const range = String(args.range || '').trim();
    if (!/^[A-Za-z]{1,3}\\d{1,6}(:[A-Za-z]{1,3}\\d{1,6})?$/.test(range)) {
      throw new Error('Invalid A1 range format.');
    }
    const wbLookup = args.workbook ? \`$excel.Workbooks.Item(\${psSingleQuote(args.workbook)})\` : '$excel.ActiveWorkbook';
    const wsLookup = args.sheet ? \`$wb.Worksheets.Item(\${psSingleQuote(args.sheet)})\` : '$wb.ActiveSheet';
    const script = [
      '$excel = [Runtime.InteropServices.Marshal]::GetActiveObject("Excel.Application");',
      \`$wb = \${wbLookup}; $ws = \${wsLookup}; $val = $ws.Range(\${psSingleQuote(range)}).Value2;\`,
      '$val | ConvertTo-Json -Depth 4 -Compress'
    ].join(' ');
    const res = await runPowerShell(script, timeout);
    return { range, values: res.stdout ? JSON.parse(res.stdout) : null };
  }

  if (action === 'word-read-active') {
    const maxChars = Math.max(100, Math.min(20000, Number(args.maxChars) || 4000));
    const script = [
      '$word = [Runtime.InteropServices.Marshal]::GetActiveObject("Word.Application");',
      '$doc = $word.ActiveDocument; $txt = $doc.Content.Text;',
      \`if ($txt.Length -gt \${maxChars}) { $txt = $txt.Substring(0, \${maxChars}) }\`,
      '@{ name = $doc.Name; text = $txt } | ConvertTo-Json -Compress'
    ].join(' ');
    const res = await runPowerShell(script, timeout);
    return JSON.parse(res.stdout || '{}');
  }

  throw new Error(\`Unsupported Windows action: \${action}\`);
}

async function executeTool(tool, args = {}) {
  switch (tool.handlerType) {
    case 'http':
      return runHttpTool(tool, args);
    case 'cli':
      return runCliTool(tool, args);
    case 'windows-ps':
    case 'windows-com':
      return runWindowsTool(tool, args);
    default:
      return { ok: true, tool: tool.name, receivedArgs: args };
  }
}

module.exports = {
  SERVER_CONFIG,
  TOOLS,
  executeTool
};
`;
}

function renderGeneratedTestCjs(bp) {
  return `'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const SERVER_PATH = path.resolve(__dirname, '..', 'bin', 'mcp-server.cjs');

function rpcCall(messages) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      const lines = buf.split('\\n');
      buf = lines.pop();
      for (const l of lines) {
        if (l.trim()) out.push(JSON.parse(l));
      }
    });
    child.on('error', reject);
    child.on('close', () => resolve(out));
    for (const msg of messages) {
      child.stdin.write(JSON.stringify(msg) + '\\n');
    }
    child.stdin.end();
  });
}

test(${JSON.stringify(`${bp.name}: initialize and tools/list over stdio`)}, async () => {
  const responses = await rpcCall([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }
  ]);

  assert.equal(responses.length, 2);
  assert.equal(responses[0].result.serverInfo.name, ${JSON.stringify(bp.name)});
  assert.ok(Array.isArray(responses[1].result.tools));
  assert.equal(responses[1].result.tools.length, ${bp.tools.length});
});
`;
}

function renderGeneratedReadme(bp) {
  const toolRows = bp.tools
    .map((t) => `| \`${t.name}\` | ${t.readOnly ? 'Read' : 'Write/Action'} | ${t.description.replace(/\|/g, '\\|')} |`)
    .join('\n');

  const envHint = bp.config?.authEnvVar
    ? `\n## Authentication\n\nSet \`${bp.config.authEnvVar}\` in the MCP server \`env\` block if the API requires authentication.\n`
    : '';

  return `# ${bp.name}

> ${bp.description}

Generated with [MCP Studio](https://github.com/deusbr/mcp-studio) (\`${bp.targetType}\` bridge for **${bp.appName}**).

## Tools (${bp.tools.length})

| Tool | Mode | Description |
| :--- | :--- | :--- |
${toolRows}
${envHint}
## Quick Verification

\`\`\`bash
npm run check
npm test
\`\`\`

## Client Configuration

### Codex (\`~/.codex/config.toml\`)

\`\`\`toml
[mcp_servers.${bp.name}]
command = "node"
args = ["/ABS/PATH/TO/${bp.name}/bin/mcp-server.cjs"]
\`\`\`

### Gemini CLI / Claude Code / Claude Desktop

\`\`\`json
{
  "mcpServers": {
    "${bp.name}": {
      "command": "node",
      "args": ["/ABS/PATH/TO/${bp.name}/bin/mcp-server.cjs"]
    }
  }
}
\`\`\`

## License

MIT
`;
}

function renderGeneratedCiYml() {
  return `name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

permissions:
  contents: read

jobs:
  test:
    runs-on: \${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest, macos-latest]
        node-version: ['18', '20', '22', '24']
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: \${{ matrix.node-version }}
      - run: npm run check
      - run: npm test
`;
}

function generateMcpProject(rawBlueprint, outputDir, { overwrite = true } = {}) {
  const bp = normalizeBlueprint(rawBlueprint);
  const targetDir = path.resolve(outputDir);
  if (fs.existsSync(targetDir) && !overwrite) {
    throw new Error(`Target directory already exists: ${targetDir}`);
  }

  const files = {
    'package.json': renderGeneratedPackageJson(bp),
    'bin/mcp-server.cjs': renderGeneratedServerCjs(bp),
    'lib/tools.cjs': renderGeneratedToolsCjs(bp),
    'tests/server.test.cjs': renderGeneratedTestCjs(bp),
    'README.md': renderGeneratedReadme(bp),
    '.gitignore': 'node_modules/\n.env\n*.log\n',
    '.github/workflows/ci.yml': renderGeneratedCiYml(),
    'LICENSE': 'MIT License\n\nCopyright (c) 2026\n'
  };

  for (const [relPath, content] of Object.entries(files)) {
    const abs = path.join(targetDir, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, { encoding: 'utf8' });
    if (relPath.endsWith('.cjs') && relPath.startsWith('bin/')) {
      try { fs.chmodSync(abs, 0o755); } catch {}
    }
  }

  return {
    blueprint: bp,
    outputDir: targetDir,
    files: Object.keys(files)
  };
}

module.exports = {
  generateMcpProject
};
