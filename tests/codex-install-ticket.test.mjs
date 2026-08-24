import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Buffer } from 'node:buffer';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const freePort = async () => {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
};

const waitUntilReady = async (url, child) => {
  for (let i = 0; i < 50; i += 1) {
    if (child.exitCode !== null) throw new Error(`server exited early with ${child.exitCode}`);
    try {
      const response = await fetch(`${url}/healthz`);
      if (response.ok) return;
    } catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('server did not become ready');
};

const readTarEntries = (compressed) => {
  const archive = zlib.gunzipSync(compressed);
  const entries = new Map();
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
    const size = Number.parseInt(sizeText || '0', 8);
    const start = offset + 512;
    entries.set(name, archive.subarray(start, start + size));
    offset = start + Math.ceil(size / 512) * 512;
  }
  return entries;
};

describe('Codex one-time install ticket', () => {
  it('WebUI 票据下载个性化包，首次启动兑换独立设备凭据', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-remote-install-server-'));
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const managementToken = 'webui-management-token';
    const child = spawn(process.execPath, ['dist/server.js'], {
      env: {
        ...process.env,
        PORT: String(port), BASE_URL: baseUrl, DB_PATH: path.join(work, 'agent-remote.db'),
        MCP_TOKEN: managementToken,
        OIDC_ISSUER: '', OIDC_CLIENT_ID: '', OIDC_CLIENT_SECRET: '', OIDC_REDIRECT_URI: '', SESSION_SECRET: '',
        FEISHU_APP_ID: '', FEISHU_APP_SECRET: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      await waitUntilReady(baseUrl, child);
      const ticketResponse = await fetch(`${baseUrl}/api/install-ticket?key=${managementToken}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent: 'codex' }),
      });
      assert.equal(ticketResponse.status, 200);
      assert.equal(ticketResponse.headers.get('cache-control'), 'no-store');
      const ticket = await ticketResponse.json();
      assert.equal(ticket.command, ticket.commands.unix);
      assert.doesNotMatch(ticket.command, /npx|installer/i);
      assert.match(ticket.command, /curl -fsSL/);
      assert.match(ticket.command, /codex plugin marketplace add/);
      assert.match(ticket.command, /codex plugin add agent-remote@agent-remote-install/);
      assert.doesNotMatch(ticket.command, /plugin remove|\.agent-remote\/config\.json/);
      assert.match(ticket.commands.powershell, /Invoke-WebRequest/);
      assert.doesNotMatch(ticket.commands.powershell, /npx|installer/i);
      assert.doesNotMatch(ticket.commands.powershell, /plugin remove|\.agent-remote[\\/]+config\.json/i);
      assert.equal(ticket.expires_in, 600);
      const connectUrl = ticket.command.match(/curl -fsSL "([^"]+)"/)?.[1];
      assert.ok(connectUrl);

      const accountToken = await fetch(`${baseUrl}/api/token?key=${managementToken}`).then((response) => response.json());

      const packageResponse = await fetch(connectUrl);
      assert.equal(packageResponse.status, 200);
      assert.equal(packageResponse.headers.get('cache-control'), 'no-store');
      assert.match(packageResponse.headers.get('content-type') || '', /^application\/gzip/);
      const packageBytes = Buffer.from(await packageResponse.arrayBuffer());
      const packageText = zlib.gunzipSync(packageBytes).toString();
      assert.doesNotMatch(packageText, new RegExp(managementToken));
      assert.doesNotMatch(packageText, new RegExp(accountToken.token));
      const packageEntries = readTarEntries(packageBytes);
      const pluginPrefix = 'plugins/agent-remote/';
      const marketplace = JSON.parse(packageEntries.get('.agents/plugins/marketplace.json').toString());
      assert.equal(marketplace.name, 'agent-remote-install');
      assert.equal(marketplace.plugins[0].source.path, './plugins/agent-remote');
      assert.ok(packageEntries.get(`${pluginPrefix}bootstrap.json`).toString().includes(connectUrl));
      const manifest = JSON.parse(packageEntries.get(`${pluginPrefix}.codex-plugin/plugin.json`).toString());
      const packageVersion = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
      assert.match(manifest.version, new RegExp(`^${packageVersion.replaceAll('.', '\\.')}\\+codex\\.install-`));

      if (process.platform !== 'win32') {
        const fakeBin = path.join(work, 'bin');
        const commandLog = path.join(work, 'codex-command.log');
        const xdgData = path.join(work, 'share');
        const testHome = path.join(work, 'home');
        fs.mkdirSync(fakeBin, { recursive: true });
        fs.mkdirSync(testHome, { recursive: true });
        const fakeCodex = path.join(fakeBin, 'codex');
        fs.writeFileSync(fakeCodex, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$AGENT_REMOTE_CODEX_LOG"\n');
        fs.chmodSync(fakeCodex, 0o755);
        const executed = spawnSync('/bin/sh', ['-c', ticket.command], {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
            HOME: testHome,
            XDG_DATA_HOME: xdgData,
            AGENT_REMOTE_CODEX_LOG: commandLog,
          },
        });
        assert.equal(executed.status, 0, executed.stderr);
        const installedRoot = path.join(xdgData, 'agent-remote', 'codex');
        assert.ok(fs.existsSync(path.join(installedRoot, '.agents/plugins/marketplace.json')));
        assert.ok(fs.existsSync(path.join(installedRoot, 'plugins/agent-remote/bootstrap.json')));
        assert.match(fs.readFileSync(commandLog, 'utf8'), /plugin marketplace add .*agent-remote\/codex --json/);
        assert.match(fs.readFileSync(commandLog, 'utf8'), /plugin add agent-remote@agent-remote-install --json/);
      }

      const removedInstaller = await fetch(`${baseUrl}/installers/agent-remote-installer.tgz`);
      assert.equal(removedInstaller.status, 404);

      const redeemedResponse = await fetch(connectUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'ticket-test' }),
      });
      assert.equal(redeemedResponse.status, 200);
      const redeemed = await redeemedResponse.json();
      assert.match(redeemed.token, /^arc_/);
      assert.notEqual(redeemed.token, managementToken);
      assert.equal(redeemed.base_url, baseUrl);
      assert.equal(redeemed.client_name, 'ticket-test');

      const retried = await fetch(connectUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'ignored-retry' }),
      }).then((response) => response.json());
      assert.equal(retried.token, redeemed.token, '短暂重试窗口返回同一设备凭据');
      assert.equal(retried.client_name, 'ticket-test');

      const packageAfterRedeem = await fetch(connectUrl);
      assert.equal(packageAfterRedeem.status, 409);

      const verified = await fetch(`${baseUrl}/client/status`, {
        headers: { Authorization: `Bearer ${redeemed.token}`, 'X-Client-Name': 'ticket-test' },
      });
      assert.equal(verified.status, 200);
      assert.deepEqual(await verified.json(), {
        ok: true, user_name: 'default', bound: false, multiuser: false, client_name: 'ticket-test',
      });

      const oldPairRoute = await fetch(`${baseUrl}/connect/pair/start`, { method: 'POST' });
      assert.equal(oldPairRoute.status, 404);

      const mcpResponse = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${redeemed.token}`,
          'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': '2025-06-18',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'list-test', method: 'tools/list', params: {} }),
      });
      assert.equal(mcpResponse.status, 200);
      const mcpText = await mcpResponse.text();
      const mcpMessages = mcpResponse.headers.get('content-type')?.includes('text/event-stream')
        ? mcpText.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => JSON.parse(line.slice(5)))
        : [JSON.parse(mcpText)];
      const listed = mcpMessages.find((message) => message.id === 'list-test');
      assert.ok(listed.result.tools.some((tool) => tool.name === 'ask_user'));
    } finally {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('close', resolve));
      fs.rmSync(work, { recursive: true, force: true });
    }
  });
});
