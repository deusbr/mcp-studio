#!/usr/bin/env node
'use strict';

const {
  TARGET_TEMPLATES,
  WINDOWS_PRESETS,
  inspectOpenApiSpec,
  inspectCliHelp,
  inspectWindowsApps,
  buildWindowsAppBlueprint
} = require('../lib/blueprints.cjs');
const { probeMcpServer, runGeneratedTests } = require('../lib/prober.cjs');
const { StudioStore, defaultStudioHome } = require('../lib/store.cjs');
const { createStudioWebServer } = require('../lib/studio-web.cjs');
const { installStudioClients, checkStudioStatus, installMcpServerToClients } = require('../lib/installers.cjs');

function parseArgs(argv) {
  const [cmd = 'help', ...rest] = argv;
  const opts = { cmd, port: 4325, clients: null };
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === '--port' && rest[i + 1]) opts.port = Number(rest[++i]) || 4325;
    else if (a === '--clients' && rest[i + 1]) opts.clients = rest[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--spec' && rest[i + 1]) opts.spec = rest[++i];
    else if (a === '--command' && rest[i + 1]) opts.command = rest[++i];
    else if (a === '--preset' && rest[i + 1]) opts.preset = rest[++i];
    else if (a === '--app' && rest[i + 1]) opts.app = rest[++i];
    else if (a === '--process' && rest[i + 1]) opts.process = rest[++i];
    else if (a === '--out' && rest[i + 1]) opts.out = rest[++i];
    else if (a === '--slug' && rest[i + 1]) opts.slug = rest[++i];
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const store = new StudioStore(defaultStudioHome());

  if (opts.cmd === 'help' || opts.cmd === '--help' || opts.cmd === '-h') {
    console.log('Usage: mcp-studio <web|mcp|install|status|templates|scan-windows|from-openapi|from-cli|from-windows|test|install-generated>');
    return;
  }
  if (opts.cmd === 'mcp') {
    require('./mcp-server.cjs');
    return;
  }
  if (opts.cmd === 'status') {
    console.log(JSON.stringify(checkStudioStatus(), null, 2));
    return;
  }
  if (opts.cmd === 'install') {
    console.log(JSON.stringify(installStudioClients({ clientIds: opts.clients }), null, 2));
    return;
  }
  if (opts.cmd === 'templates') {
    console.log(JSON.stringify({ templates: Object.values(TARGET_TEMPLATES), windowsPresets: Object.values(WINDOWS_PRESETS) }, null, 2));
    return;
  }
  if (opts.cmd === 'scan-windows') {
    console.log(JSON.stringify(inspectWindowsApps(), null, 2));
    return;
  }
  if (opts.cmd === 'from-openapi') {
    const bp = inspectOpenApiSpec({ specPath: opts.spec });
    console.log(JSON.stringify(store.createProject(bp, { outputDir: opts.out }), null, 2));
    return;
  }
  if (opts.cmd === 'from-cli') {
    const bp = inspectCliHelp({ command: opts.command });
    console.log(JSON.stringify(store.createProject(bp, { outputDir: opts.out }), null, 2));
    return;
  }
  if (opts.cmd === 'from-windows') {
    const bp = buildWindowsAppBlueprint({ preset: opts.preset, appName: opts.app, processName: opts.process });
    console.log(JSON.stringify(store.createProject(bp, { outputDir: opts.out }), null, 2));
    return;
  }
  if (opts.cmd === 'test') {
    const project = store.getProject(opts.slug);
    const test = await runGeneratedTests(project.outputDir);
    const probe = await probeMcpServer({ serverPath: project.serverPath });
    console.log(JSON.stringify({ test, probe }, null, 2));
    return;
  }
  if (opts.cmd === 'install-generated') {
    const project = store.getProject(opts.slug);
    console.log(JSON.stringify(installMcpServerToClients({ serverName: project.slug, mcpServerScript: project.serverPath, clientIds: opts.clients }), null, 2));
    return;
  }
  if (opts.cmd === 'web') {
    const web = createStudioWebServer({ store, port: opts.port });
    const info = await web.listen();
    console.log(`MCP Studio Web Workbench running at ${info.url} (home: ${store.studioHome})`);
    return;
  }

  throw new Error(`Unknown command: ${opts.cmd}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
