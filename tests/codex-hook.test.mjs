import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateConnectUrl, validateServiceUrl } from '../plugins/codex/agent-remote/scripts/config.mjs';

const script = 'plugins/codex/agent-remote/scripts/codex-hook.mjs';

const runHook = (payload, env) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', reject);
  child.on('close', (code) => resolve({ code, stdout, stderr }));
  child.stdin.end(JSON.stringify(payload));
});

describe('Codex hook command adapter', () => {
  it('允许远程 HTTP 安装地址和服务地址', () => {
    assert.equal(
      validateConnectUrl('http://192.168.1.20:3000/install/codex/ticket'),
      'http://192.168.1.20:3000/install/codex/ticket',
    );
    assert.equal(validateServiceUrl('http://agent-remote.lan:3000/codex'), 'http://agent-remote.lan:3000');
  });

  it('转发 stdin/认证头，并把服务端决定原样写回 stdout', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-remote-hook-config-'));
    let received;
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        received = {
          path: req.url,
          authorization: req.headers.authorization,
          clientName: req.headers['x-client-name'],
          timeout: req.headers['x-timeout-seconds'],
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        };
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ decision: 'block', reason: '继续' }));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
        version: 2, token: 'secret-token', baseUrl: `http://127.0.0.1:${address.port}`,
        clientName: 'test-client', timeoutSeconds: 15,
      }));
      const result = await runHook({ hook_event_name: 'Stop', turn_id: 't1' }, {
        PLUGIN_DATA: dataDir,
        PLUGIN_ROOT: path.resolve('plugins/codex/agent-remote'),
      });
      assert.equal(result.code, 0);
      assert.deepEqual(JSON.parse(result.stdout), { decision: 'block', reason: '继续' });
      assert.deepEqual(received, {
        path: '/codex',
        authorization: 'Bearer secret-token',
        clientName: 'test-client',
        timeout: '15',
        body: { hook_event_name: 'Stop', turn_id: 't1' },
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('缺少 token 时安全返回空决定', async () => {
    const result = await runHook({ hook_event_name: 'Stop' }, {
      PLUGIN_DATA: path.join(os.tmpdir(), `agent-remote-missing-${process.pid}-${Date.now()}`),
      PLUGIN_ROOT: path.resolve('plugins/codex/agent-remote'),
    });
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), {});
    assert.match(result.stderr, /尚未连接/);
  });

  it('无需环境变量，自动读取插件私有目录中的持久配置', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-remote-hook-'));
    let authorization;
    const server = http.createServer((req, res) => {
      authorization = req.headers.authorization;
      res.setHeader('content-type', 'application/json');
      res.end('{}');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
        version: 1,
        baseUrl: `http://127.0.0.1:${address.port}`,
        token: 'saved-token',
        clientName: 'saved-client',
        timeoutSeconds: 12,
      }));
      const result = await runHook({ hook_event_name: 'SessionEnd' }, {
        PLUGIN_DATA: dataDir,
        PLUGIN_ROOT: path.resolve('plugins/codex/agent-remote'),
      });
      assert.equal(result.code, 0);
      assert.deepEqual(JSON.parse(result.stdout), {});
      assert.equal(authorization, 'Bearer saved-token');
    } finally {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('首次运行用安装票据写入 PLUGIN_DATA，并删除 bootstrap', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-remote-bootstrap-'));
    const dataDir = path.join(root, 'plugin-data');
    const pluginRoot = path.join(root, 'plugin-root');
    fs.mkdirSync(dataDir);
    fs.mkdirSync(pluginRoot);
    let redeemedName;
    let hookAuthorization;
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        if (req.url === '/install/codex/ticket') {
          redeemedName = JSON.parse(Buffer.concat(chunks).toString('utf8')).client_name;
          return res.end(JSON.stringify({
            base_url: `http://127.0.0.1:${server.address().port}`,
            token: 'device-token', client_name: redeemedName, timeout_seconds: 30,
          }));
        }
        hookAuthorization = req.headers.authorization;
        res.end('{}');
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      fs.writeFileSync(path.join(pluginRoot, 'bootstrap.json'), JSON.stringify({
        version: 1,
        connectUrl: `http://127.0.0.1:${server.address().port}/install/codex/ticket`,
        clientName: 'bootstrap-client', timeoutSeconds: 30,
      }));
      const result = await runHook({ hook_event_name: 'SessionEnd' }, { PLUGIN_DATA: dataDir, PLUGIN_ROOT: pluginRoot });
      assert.equal(result.code, 0);
      assert.equal(redeemedName, 'bootstrap-client');
      assert.equal(hookAuthorization, 'Bearer device-token');
      const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
      assert.equal(stored.configuredBy, 'one-time-install-ticket');
      assert.equal(stored.token, 'device-token');
      assert.equal(fs.existsSync(path.join(pluginRoot, 'bootstrap.json')), false);
      if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dataDir, 'config.json')).mode & 0o777, 0o600);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
