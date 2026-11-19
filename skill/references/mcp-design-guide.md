# MCP Design & Security Standards

## 1. Zero Shell Injection
- Never pass user or model arguments through `cmd /c`, `bash -c`, or template-interpolated shell strings.
- Generated CLI bridges must use `execFile` with `shell: false` and explicit argument arrays.
- Generated Windows bridges must use `powershell.exe -NoProfile -NonInteractive -EncodedCommand` with escaped parameters and allowlisted hotkeys.

## 2. Schema Token Discipline
- Keep tool descriptions under 180 characters.
- Cap OpenAPI imports (default 40 tools) and prefer focused `inputSchema` objects with `additionalProperties: false`.

## 3. Credential Hygiene
- Never embed API keys, bearer tokens, or passwords in generated source files or `README.md`.
- Reference environment variables (e.g. `process.env.MY_APP_TOKEN`) configured in the client's `env` block.
