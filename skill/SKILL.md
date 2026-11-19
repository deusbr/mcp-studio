---
name: mcp-studio
description: Build, probe, test, and install zero-dependency MCP servers for applications that lack an official MCP (OpenAPI/REST APIs, local CLIs, custom HTTP webhooks, and Windows desktop apps).
---

# MCP Studio — Build MCPs for Apps Without One

Use this workflow whenever the user wants an MCP server for an app, API, CLI, or Windows desktop program that does not have an existing MCP.

## Workflow

1. **Discover the target (`studio_list_templates` + target inspector)**
   - **REST / OpenAPI / Swagger:** call `studio_inspect_openapi` with `specPath` or `specJson`.
   - **Local CLI binary:** call `studio_inspect_cli` with `command` (runs `--help` safely without shell interpolation).
   - **Windows desktop app:** call `studio_inspect_windows_apps` to inspect running processes/windows, or use a preset (`excel-com`, `word-com`, `vlc-http`, `generic-desktop`).
2. **Generate the MCP server (`studio_create_project`)**
   - Produces a standalone zero-dependency Node.js >= 18 repo with `package.json`, `bin/mcp-server.cjs`, `lib/tools.cjs`, `tests/server.test.cjs`, `README.md`, `LICENSE`, and GitHub Actions CI.
   - Keep tool count lean (<= 40 tools) and descriptions concise to avoid context bloat.
3. **Verify & measure token cost (`studio_test_generated`)**
   - Runs `node --test` on the generated project, executes a live `initialize` + `tools/list` stdio handshake, and reports `estimatedSchemaTokens`.
4. **Install or inspect visually (`studio_install_generated` / `studio_start_web`)**
   - Register the new server atomically into Codex, Gemini CLI, Claude Code, or Claude Desktop.
   - Start the Local Web Workbench on `http://127.0.0.1:4325` for live tool calls and visual editing.

See [`references/mcp-design-guide.md`](references/mcp-design-guide.md) for security and schema design rules.
