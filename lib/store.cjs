'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { generateMcpProject } = require('./generator.cjs');

const SAFE_SLUG_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;

function defaultStudioHome(home = os.homedir()) {
  return process.env.MCP_STUDIO_HOME || path.join(home, '.mcp-studio');
}

function atomicWriteJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

function assertSafeSlug(slug) {
  if (!SAFE_SLUG_RE.test(String(slug || ''))) {
    throw new Error('Invalid project slug. Use lowercase letters, numbers, hyphens, or underscores.');
  }
}

class StudioStore {
  constructor(studioHome = defaultStudioHome()) {
    this.studioHome = path.resolve(studioHome);
    this.projectsDir = path.join(this.studioHome, 'projects');
    this.metaDir = path.join(this.studioHome, 'registry');
    fs.mkdirSync(this.projectsDir, { recursive: true });
    fs.mkdirSync(this.metaDir, { recursive: true });
  }

  metaPath(slug) {
    assertSafeSlug(slug);
    return path.join(this.metaDir, `${slug}.json`);
  }

  createProject(blueprint, { outputDir = null, overwrite = true } = {}) {
    const provisionalSlug = String(blueprint?.name || blueprint?.appName || 'custom-mcp')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'custom-mcp';

    const targetDir = outputDir
      ? path.resolve(outputDir)
      : path.join(this.projectsDir, provisionalSlug);

    const generated = generateMcpProject(blueprint, targetDir, { overwrite });
    const slug = generated.blueprint.name;
    const now = new Date().toISOString();

    const record = {
      slug,
      appName: generated.blueprint.appName,
      targetType: generated.blueprint.targetType,
      description: generated.blueprint.description,
      outputDir: generated.outputDir,
      serverPath: path.join(generated.outputDir, 'bin', 'mcp-server.cjs'),
      toolCount: generated.blueprint.tools.length,
      files: generated.files,
      blueprint: generated.blueprint,
      lastProbe: null,
      lastTest: null,
      createdAt: now,
      updatedAt: now
    };

    atomicWriteJson(this.metaPath(slug), record);
    return record;
  }

  getProject(slug) {
    const p = this.metaPath(slug);
    if (!fs.existsSync(p)) {
      throw new Error(`Project not found in MCP Studio registry: ${slug}`);
    }
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  }

  updateProject(slug, patch) {
    const current = this.getProject(slug);
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    atomicWriteJson(this.metaPath(slug), next);
    return next;
  }

  listProjects() {
    if (!fs.existsSync(this.metaDir)) return [];
    const items = [];
    for (const entry of fs.readdirSync(this.metaDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      try {
        items.push(JSON.parse(fs.readFileSync(path.join(this.metaDir, entry.name), 'utf8')));
      } catch {}
    }
    return items.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  }
}

module.exports = {
  StudioStore,
  defaultStudioHome
};
