'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const TARGET_TEMPLATES = {
  openapi: {
    id: 'openapi',
    name: 'OpenAPI / REST API -> MCP',
    description: 'Convert an OpenAPI 3.x / Swagger 2.0 JSON spec or REST endpoints into a typed stdio MCP server with auth env var support.'
  },
  cli: {
    id: 'cli',
    name: 'Local CLI Binary -> MCP',
    description: 'Wrap any local command-line tool (--help introspection or explicit subcommands) in a shell-injection-safe MCP server.'
  },
  'windows-app': {
    id: 'windows-app',
    name: 'Windows Desktop App -> MCP',
    description: 'Bridge a Windows desktop app without an official MCP (process lifecycle, window focus, controlled hotkeys, and optional COM automation).'
  },
  'custom-http': {
    id: 'custom-http',
    name: 'Custom HTTP / Webhook -> MCP',
    description: 'Create an MCP server from a custom list of HTTP endpoints or declarative tool definitions.'
  }
};

const WINDOWS_PRESETS = {
  'excel-com': {
    id: 'excel-com',
    appName: 'Microsoft Excel',
    processName: 'EXCEL',
    comProgId: 'Excel.Application',
    description: 'Read open Excel workbooks, sheet names, and cell ranges via Windows COM + window controls.'
  },
  'word-com': {
    id: 'word-com',
    appName: 'Microsoft Word',
    processName: 'WINWORD',
    comProgId: 'Word.Application',
    description: 'Inspect open Word documents and extract active document text via Windows COM + window controls.'
  },
  'vlc-http': {
    id: 'vlc-http',
    appName: 'VLC Media Player',
    processName: 'vlc',
    comProgId: null,
    description: 'Monitor and control VLC desktop playback and window state on Windows.'
  },
  'generic-desktop': {
    id: 'generic-desktop',
    appName: 'Generic Windows App',
    processName: 'notepad',
    comProgId: null,
    description: 'Process status, launch, window focus, and allowlisted hotkey bridge for any Windows executable.'
  }
};

function slugifyName(input, fallback = 'custom-mcp') {
  const slug = String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || fallback;
}

function sanitizeToolName(input, fallback = 'run_action') {
  let name = String(input || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
  if (!name || !/^[a-z]/.test(name)) {
    name = `${fallback}_${name}`.replace(/_+$/g, '');
  }
  return name.slice(0, 64);
}

function resolveRef(spec, schema, seen = new Set()) {
  if (!schema || typeof schema !== 'object') return { type: 'object' };
  if (schema.$ref && typeof schema.$ref === 'string') {
    if (seen.has(schema.$ref)) return { type: 'object' };
    seen.add(schema.$ref);
    const parts = schema.$ref.replace(/^#\//, '').split('/');
    let cur = spec;
    for (const p of parts) {
      cur = cur && typeof cur === 'object' ? cur[p] : undefined;
    }
    return cur ? resolveRef(spec, cur, seen) : { type: 'object' };
  }
  const out = {};
  if (schema.type) out.type = schema.type;
  if (schema.description) out.description = String(schema.description).slice(0, 140);
  if (Array.isArray(schema.enum)) out.enum = schema.enum.slice(0, 20);
  if (schema.properties && typeof schema.properties === 'object') {
    out.type = out.type || 'object';
    out.properties = {};
    for (const [k, v] of Object.entries(schema.properties).slice(0, 20)) {
      out.properties[k] = resolveRef(spec, v, new Set(seen));
    }
    if (Array.isArray(schema.required)) out.required = schema.required.slice(0, 20);
  }
  if (schema.items) {
    out.items = resolveRef(spec, schema.items, new Set(seen));
  }
  return Object.keys(out).length ? out : { type: 'string' };
}

function inspectOpenApiSpec({ spec, specPath, maxTools = 40 } = {}) {
  let parsed = spec;
  if (!parsed && specPath) {
    const resolved = path.resolve(specPath);
    if (!fs.existsSync(resolved)) throw new Error(`OpenAPI spec file not found: ${resolved}`);
    parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } else if (typeof parsed === 'string') {
    parsed = JSON.parse(parsed);
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.paths) {
    throw new Error('Invalid OpenAPI/Swagger JSON: missing "paths" object.');
  }

  const title = parsed.info?.title || 'API Service';
  const slug = slugifyName(title, 'api-mcp');
  let baseUrl = 'https://api.example.com';
  if (Array.isArray(parsed.servers) && parsed.servers[0]?.url) {
    baseUrl = String(parsed.servers[0].url).replace(/\/+$/, '');
  } else if (parsed.host) {
    const scheme = Array.isArray(parsed.schemes) && parsed.schemes[0] ? parsed.schemes[0] : 'https';
    const basePath = parsed.basePath || '';
    baseUrl = `${scheme}://${parsed.host}${basePath}`.replace(/\/+$/, '');
  }

  const tools = [];
  const usedNames = new Set();
  const methods = ['get', 'post', 'put', 'patch', 'delete'];

  for (const [routePath, pathItem] of Object.entries(parsed.paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    const sharedParams = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];
    for (const method of methods) {
      const op = pathItem[method];
      if (!op) continue;
      if (tools.length >= maxTools) break;

      const rawName = op.operationId || `${method}_${routePath.replace(/[{}]/g, '')}`;
      let toolName = sanitizeToolName(rawName, method);
      let suffix = 2;
      while (usedNames.has(toolName)) {
        toolName = sanitizeToolName(`${rawName}_${suffix++}`, method);
      }
      usedNames.add(toolName);

      const properties = {};
      const required = [];
      const pathParams = [];
      const queryParams = [];

      for (const param of [...sharedParams, ...(Array.isArray(op.parameters) ? op.parameters : [])]) {
        if (!param || !param.name) continue;
        const propName = String(param.name);
        const schema = resolveRef(parsed, param.schema || { type: param.type || 'string' });
        if (param.description && !schema.description) {
          schema.description = String(param.description).slice(0, 140);
        }
        properties[propName] = schema;
        if (param.required) required.push(propName);
        if (param.in === 'path') pathParams.push(propName);
        if (param.in === 'query') queryParams.push(propName);
      }

      let hasBody = false;
      const jsonBody = op.requestBody?.content?.['application/json']?.schema;
      if (jsonBody) {
        hasBody = true;
        properties.body = resolveRef(parsed, jsonBody);
        if (op.requestBody.required) required.push('body');
      }

      const desc = String(op.summary || op.description || `${method.toUpperCase()} ${routePath}`)
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 180);

      tools.push({
        name: toolName,
        description: desc,
        readOnly: method === 'get',
        handlerType: 'http',
        http: {
          method: method.toUpperCase(),
          path: routePath,
          pathParams,
          queryParams,
          hasBody
        },
        inputSchema: {
          type: 'object',
          properties,
          ...(required.length ? { required: [...new Set(required)] } : {}),
          additionalProperties: false
        }
      });
    }
  }

  return {
    name: `${slug}-mcp`,
    appName: title,
    targetType: 'openapi',
    description: String(parsed.info?.description || `MCP server generated from OpenAPI spec for ${title}.`).slice(0, 200),
    config: {
      baseUrl,
      authEnvVar: `${slug.toUpperCase().replace(/-/g, '_')}_TOKEN`,
      authHeader: 'Authorization',
      authPrefix: 'Bearer '
    },
    tools
  };
}

function parseHelpText(command, helpText) {
  const lines = String(helpText || '').split(/\r?\n/);
  const subcommands = [];
  const flags = [];
  const seenSub = new Set();
  const seenFlags = new Set();

  for (const line of lines) {
    const subMatch = line.match(/^\s{1,6}([a-z][a-z0-9_-]{1,28})\s{2,}(.+)$/);
    if (subMatch) {
      const cmd = subMatch[1];
      const desc = subMatch[2].trim();
      if (!['usage', 'options', 'commands', 'arguments', 'examples', 'help'].includes(cmd) && !seenSub.has(cmd)) {
        seenSub.add(cmd);
        subcommands.push({ name: cmd, description: desc.slice(0, 140) });
      }
      continue;
    }
    const flagMatch = line.match(/^\s{1,6}(?:-[a-zA-Z],\s*)?(--[a-z0-9][a-z0-9-]{1,30})(?:[=\s]+<[^>]+>|\s+[A-Z_]+)?\s{2,}(.+)$/);
    if (flagMatch) {
      const flag = flagMatch[1];
      const desc = flagMatch[2].trim();
      if (!seenFlags.has(flag)) {
        seenFlags.add(flag);
        flags.push({ flag, description: desc.slice(0, 140) });
      }
    }
  }

  const baseName = path.basename(command).replace(/\.(exe|cmd|bat)$/i, '');
  const slug = slugifyName(baseName, 'cli');
  const tools = [
    {
      name: sanitizeToolName(`${slug}_help`),
      description: `Show help output for ${baseName}.`,
      readOnly: true,
      handlerType: 'cli',
      cli: { fixedArgs: ['--help'], allowExtraArgs: false },
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    }
  ];

  for (const sub of subcommands.slice(0, 15)) {
    tools.push({
      name: sanitizeToolName(`${slug}_${sub.name}`),
      description: sub.description || `Run "${baseName} ${sub.name}".`,
      readOnly: /^(list|get|show|status|info|check|version|inspect|read)/i.test(sub.name),
      handlerType: 'cli',
      cli: { fixedArgs: [sub.name], allowExtraArgs: true },
      inputSchema: {
        type: 'object',
        properties: {
          args: {
            type: 'array',
            items: { type: 'string' },
            description: 'Additional CLI arguments passed safely without shell interpolation.'
          }
        },
        additionalProperties: false
      }
    });
  }

  if (tools.length === 1) {
    tools.push({
      name: sanitizeToolName(`${slug}_run`),
      description: `Execute ${baseName} with validated argument list (no shell interpolation).`,
      readOnly: false,
      handlerType: 'cli',
      cli: { fixedArgs: [], allowExtraArgs: true },
      inputSchema: {
        type: 'object',
        properties: {
          args: {
            type: 'array',
            items: { type: 'string' },
            description: 'Ordered CLI arguments.'
          }
        },
        additionalProperties: false
      }
    });
  }

  return {
    name: `${slug}-mcp`,
    appName: baseName,
    targetType: 'cli',
    description: `Zero-dependency MCP wrapper for the "${baseName}" CLI.`,
    config: {
      command,
      allowedFlags: flags.slice(0, 30).map((f) => f.flag),
      timeoutMs: 15000
    },
    discovered: { subcommands, flags },
    tools
  };
}

function inspectCliHelp({ command, helpArgs = ['--help'], helpText = null } = {}) {
  if (!command || typeof command !== 'string') {
    throw new Error('CLI command name or path is required.');
  }
  let output = helpText;
  if (output === null || output === undefined) {
    try {
      output = execFileSync(command, helpArgs, {
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 512 * 1024,
        windowsHide: true
      });
    } catch (err) {
      const combined = `${err.stdout || ''}\n${err.stderr || ''}`.trim();
      if (!combined) {
        throw new Error(`Failed to inspect CLI "${command}": ${err.message}`);
      }
      output = combined;
    }
  }
  return parseHelpText(command, output);
}

function inspectWindowsApps() {
  if (process.platform !== 'win32') {
    return { supported: false, platform: process.platform, apps: [] };
  }
  const psScript = [
    "$ProgressPreference = 'SilentlyContinue';",
    'Get-Process |',
    'Where-Object { $_.MainWindowTitle -and $_.MainWindowTitle.Trim().Length -gt 0 } |',
    'Select-Object ProcessName, Id, MainWindowTitle, Path |',
    'ConvertTo-Json -Compress'
  ].join(' ');
  const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
  const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    encoding: 'utf8',
    timeout: 6000,
    maxBuffer: 512 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  }).trim();
  if (!raw) return { supported: true, platform: 'win32', apps: [] };
  const parsed = JSON.parse(raw);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const seen = new Set();
  const apps = [];
  for (const row of rows) {
    if (!row || !row.ProcessName) continue;
    const key = `${row.ProcessName}::${row.MainWindowTitle}`;
    if (seen.has(key)) continue;
    seen.add(key);
    apps.push({
      processName: row.ProcessName,
      pid: row.Id,
      windowTitle: row.MainWindowTitle,
      executablePath: row.Path || null
    });
  }
  return { supported: true, platform: 'win32', apps };
}

function buildWindowsAppBlueprint({
  appName,
  processName,
  executablePath = '',
  preset = null,
  comProgId = null,
  allowedHotkeys = ['^s', '^c', '^v', '{F5}']
} = {}) {
  const presetObj = preset && WINDOWS_PRESETS[preset] ? WINDOWS_PRESETS[preset] : null;
  const resolvedApp = appName || presetObj?.appName || processName || 'Desktop App';
  const resolvedProc = processName || presetObj?.processName || slugifyName(resolvedApp, 'app');
  const resolvedCom = comProgId !== undefined && comProgId !== null ? comProgId : (presetObj?.comProgId || null);
  const slug = slugifyName(resolvedApp, 'windows-app');
  const prefix = sanitizeToolName(slug, 'app');

  const tools = [
    {
      name: `${prefix}_status`,
      description: `Check whether ${resolvedApp} (${resolvedProc}) is running and inspect active window titles.`,
      readOnly: true,
      handlerType: 'windows-ps',
      windowsAction: 'status',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
      name: `${prefix}_launch`,
      description: `Launch ${resolvedApp} on Windows.`,
      readOnly: false,
      handlerType: 'windows-ps',
      windowsAction: 'launch',
      inputSchema: {
        type: 'object',
        properties: {
          arguments: { type: 'array', items: { type: 'string' }, description: 'Optional startup arguments or file path.' }
        },
        additionalProperties: false
      }
    },
    {
      name: `${prefix}_focus_window`,
      description: `Bring ${resolvedApp} window to the foreground.`,
      readOnly: false,
      handlerType: 'windows-ps',
      windowsAction: 'focus',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
      name: `${prefix}_send_hotkey`,
      description: `Focus ${resolvedApp} and send one allowlisted SendKeys hotkey.`,
      readOnly: false,
      handlerType: 'windows-ps',
      windowsAction: 'hotkey',
      inputSchema: {
        type: 'object',
        required: ['keys'],
        properties: {
          keys: {
            type: 'string',
            enum: allowedHotkeys,
            description: 'Allowlisted Windows SendKeys sequence.'
          }
        },
        additionalProperties: false
      }
    }
  ];

  if (resolvedCom === 'Excel.Application') {
    tools.push(
      {
        name: `${prefix}_list_workbooks`,
        description: 'List open Excel workbooks and worksheet names via Windows COM.',
        readOnly: true,
        handlerType: 'windows-com',
        windowsAction: 'excel-list',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }
      },
      {
        name: `${prefix}_read_range`,
        description: 'Read cell values from an open Excel workbook sheet and A1 range (e.g. "A1:D10").',
        readOnly: true,
        handlerType: 'windows-com',
        windowsAction: 'excel-read-range',
        inputSchema: {
          type: 'object',
          required: ['range'],
          properties: {
            workbook: { type: 'string', description: 'Optional workbook name (defaults to ActiveWorkbook).' },
            sheet: { type: 'string', description: 'Optional sheet name (defaults to ActiveSheet).' },
            range: { type: 'string', description: 'A1 notation range such as A1:C10.' }
          },
          additionalProperties: false
        }
      }
    );
  } else if (resolvedCom === 'Word.Application') {
    tools.push({
      name: `${prefix}_read_active_document`,
      description: 'Read the name and text excerpt of the active Microsoft Word document via Windows COM.',
      readOnly: true,
      handlerType: 'windows-com',
      windowsAction: 'word-read-active',
      inputSchema: {
        type: 'object',
        properties: {
          maxChars: { type: 'integer', description: 'Maximum characters to return (default 4000).' }
        },
        additionalProperties: false
      }
    });
  }

  return {
    name: `${slug}-mcp`,
    appName: resolvedApp,
    targetType: 'windows-app',
    description: presetObj?.description || `Windows desktop automation MCP server for ${resolvedApp}.`,
    config: {
      processName: resolvedProc,
      executablePath: executablePath || resolvedProc,
      comProgId: resolvedCom,
      allowedHotkeys,
      timeoutMs: 10000
    },
    tools
  };
}

function normalizeBlueprint(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Blueprint must be a JSON object.');
  }
  const appName = String(raw.appName || raw.name || 'Custom App').trim();
  const targetType = TARGET_TEMPLATES[raw.targetType] ? raw.targetType : 'custom-http';
  const name = slugifyName(raw.name || `${appName}-mcp`, 'custom-mcp');
  const description = String(raw.description || `MCP server for ${appName}.`).trim();
  const tools = Array.isArray(raw.tools) ? raw.tools : [];
  if (tools.length === 0) {
    throw new Error('Blueprint must include at least one tool definition.');
  }

  const normalizedTools = tools.map((t, idx) => ({
    name: sanitizeToolName(t.name, `tool_${idx + 1}`),
    description: String(t.description || `Execute ${t.name || 'action'}.`).trim().slice(0, 220),
    readOnly: Boolean(t.readOnly),
    handlerType: t.handlerType || (targetType === 'cli' ? 'cli' : targetType === 'windows-app' ? 'windows-ps' : 'http'),
    http: t.http || undefined,
    cli: t.cli || undefined,
    windowsAction: t.windowsAction || undefined,
    inputSchema: t.inputSchema && typeof t.inputSchema === 'object'
      ? t.inputSchema
      : { type: 'object', properties: {}, additionalProperties: false }
  }));

  return {
    name,
    appName,
    targetType,
    description,
    config: raw.config && typeof raw.config === 'object' ? raw.config : {},
    tools: normalizedTools
  };
}

module.exports = {
  TARGET_TEMPLATES,
  WINDOWS_PRESETS,
  slugifyName,
  sanitizeToolName,
  inspectOpenApiSpec,
  parseHelpText,
  inspectCliHelp,
  inspectWindowsApps,
  buildWindowsAppBlueprint,
  normalizeBlueprint
};
