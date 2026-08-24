import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = 'plugins/codex/agent-remote';
const claudeRoot = 'plugins/claude/agent-remote';
const readJson = (path) => JSON.parse(fs.readFileSync(`${root}/${path}`, 'utf8'));

describe('Codex plugin package', () => {
  it('manifest、MCP 与 hooks 组件完整', () => {
    const manifest = readJson('.codex-plugin/plugin.json');
    const mcp = readJson('.mcp.json');
    const hooks = readJson('hooks/hooks.json');
    const marketplace = JSON.parse(fs.readFileSync('.agents/plugins/marketplace.json', 'utf8'));

    assert.equal(manifest.name, 'agent-remote');
    const packageVersion = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
    assert.ok(manifest.version === packageVersion || manifest.version.startsWith(`${packageVersion}+codex.`));
    assert.equal(manifest.mcpServers, './.mcp.json');
    const mcpServer = mcp.mcpServers['agent-remote'];
    assert.equal(mcpServer.command, 'node');
    assert.deepEqual(mcpServer.args, ['./scripts/mcp-proxy.mjs']);
    assert.equal(mcpServer.cwd, '.');
    assert.equal(mcpServer.env, undefined);
    assert.doesNotMatch(JSON.stringify(mcpServer), /\$\{PLUGIN_(?:ROOT|DATA)\}/);
    assert.equal(manifest.skills, undefined);
    assert.deepEqual(Object.keys(hooks.hooks).sort(), ['PermissionRequest', 'SessionEnd', 'SessionStart', 'Stop']);
    assert.equal(hooks.hooks.SessionStart[0].hooks[0].timeout, 20);
    assert.equal(hooks.hooks.SessionEnd[0].hooks[0].timeout, 3);
    assert.ok(fs.existsSync(`${root}/scripts/activate.mjs`));
    assert.ok(fs.existsSync(`${root}/scripts/codex-hook.mjs`));
    assert.ok(fs.existsSync(`${root}/scripts/mcp-proxy.mjs`));
    assert.equal(fs.existsSync(`${root}/skills/agent-remote-setup/SKILL.md`), false);
    assert.equal(marketplace.name, 'agent-remote');
    assert.equal(marketplace.plugins[0].source.path, './plugins/codex/agent-remote');
    assert.equal(marketplace.plugins[0].policy.authentication, 'ON_INSTALL');
    assert.ok(fs.existsSync(marketplace.plugins[0].source.path));
  });

  it('Claude 与 Codex 插件按宿主分目录，插件标识保持一致', () => {
    const claudeManifest = JSON.parse(fs.readFileSync(`${claudeRoot}/.claude-plugin/plugin.json`, 'utf8'));
    const claudeMarketplace = JSON.parse(fs.readFileSync('.claude-plugin/marketplace.json', 'utf8'));

    assert.equal(claudeManifest.name, 'agent-remote');
    assert.equal(claudeManifest.version, JSON.parse(fs.readFileSync('package.json', 'utf8')).version);
    assert.equal(claudeMarketplace.plugins[0].source, `./${claudeRoot}`);
    assert.ok(fs.existsSync(`${claudeRoot}/.mcp.json`));
    assert.ok(fs.existsSync(`${claudeRoot}/hooks/hooks.json`));
  });
});
