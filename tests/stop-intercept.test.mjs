import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

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

describe('WebUI Stop 拦截设置', () => {
  it('默认全部开启，可分别保存 Codex 和 Claude Code 状态', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-remote-stop-intercept-'));
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const managementToken = 'stop-intercept-management-token';
    const child = spawn(process.execPath, ['dist/server.js'], {
      env: {
        ...process.env,
        PORT: String(port), DB_PATH: path.join(work, 'agent-remote.db'), MCP_TOKEN: managementToken,
        OIDC_ISSUER: '', OIDC_CLIENT_ID: '', OIDC_CLIENT_SECRET: '', OIDC_REDIRECT_URI: '', SESSION_SECRET: '',
        FEISHU_APP_ID: '', FEISHU_APP_SECRET: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      await waitUntilReady(baseUrl, child);
      const initial = await fetch(`${baseUrl}/api/me`).then((response) => response.json());
      assert.deepEqual(initial.stop_intercept, { codex: true, claude: true });

      const unauthorized = await fetch(`${baseUrl}/api/stop-intercept`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codex: false, claude: true }),
      });
      assert.equal(unauthorized.status, 403);

      const invalid = await fetch(`${baseUrl}/api/stop-intercept?key=${managementToken}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codex: false }),
      });
      assert.equal(invalid.status, 400);

      const saved = await fetch(`${baseUrl}/api/stop-intercept?key=${managementToken}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codex: false, claude: true }),
      });
      assert.equal(saved.status, 200);

      const updated = await fetch(`${baseUrl}/api/me`).then((response) => response.json());
      assert.deepEqual(updated.stop_intercept, { codex: false, claude: true });
    } finally {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('close', resolve));
      fs.rmSync(work, { recursive: true, force: true });
    }
  });
});
