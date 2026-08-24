import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Buffer } from 'node:buffer';

const script = 'plugins/codex/agent-remote/scripts/mcp-proxy.mjs';

function startProxy(dataDir, pluginRoot = path.resolve('plugins/codex/agent-remote')) {
  const child = spawn(process.execPath, [script], {
    env: {
      ...process.env,
      PLUGIN_DATA: dataDir,
      PLUGIN_ROOT: pluginRoot,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const waiting = [];
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const hit = waiting.findIndex((entry) => entry.predicate(message));
      if (hit >= 0) waiting.splice(hit, 1)[0].resolve(message);
    }
  });
  const waitFor = (predicate, timeout = 5000) => new Promise((resolve, reject) => {
    const entry = { predicate, resolve: (value) => { clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => {
      const index = waiting.indexOf(entry);
      if (index >= 0) waiting.splice(index, 1);
      reject(new Error('timed out waiting for MCP message'));
    }, timeout);
    waiting.push(entry);
  });
  const request = async (id, method, params = {}) => {
    const response = waitFor((message) => message.id === id);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return response;
  };
  return { child, request, waitFor };
}

async function stopProxy(proxy) {
  proxy.child.kill('SIGTERM');
  await new Promise((resolve) => proxy.child.once('close', resolve));
}

describe('Codex MCP config-file bridge', () => {
  it('从配置文件暴露远端工具，只保留只读状态工具', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-remote-proxy-'));
    const server = http.createServer((req, res) => {
      if (req.url === '/client/status') {
        assert.equal(req.headers.authorization, 'Bearer saved-token');
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ ok: true, user_name: 'Tester', bound: true }));
      }
      if (req.url === '/mcp') {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        return req.on('end', () => {
          assert.equal(req.headers.authorization, 'Bearer saved-token');
          const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (rpc.method === 'tools/call') {
            res.setHeader('content-type', 'text/event-stream');
            res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 9, progress: 1 } })}\n\n`);
            return res.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: '{"answer":"继续"}' }] } })}\n\n`);
          }
          res.setHeader('content-type', 'application/json');
          return res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { tools: [{ name: 'ask_user', description: 'remote', inputSchema: { type: 'object' } }] } }));
        });
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
      version: 1,
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: 'saved-token',
      clientName: 'test-codex',
      timeoutSeconds: 600,
    }));
    const proxy = startProxy(dataDir);
    try {
      const initialized = await proxy.request(1, 'initialize', { protocolVersion: '2025-06-18' });
      assert.equal(initialized.result.serverInfo.name, 'agent-remote-codex-bridge');
      assert.match(initialized.result.instructions, /one-click|WebUI/i);

      const listed = await proxy.request(2, 'tools/list');
      const names = listed.result.tools.map((tool) => tool.name);
      assert.ok(names.includes('agent_remote_status'));
      assert.ok(names.includes('ask_user'));
      assert.ok(!names.includes('configure_agent_remote'));
      assert.ok(!names.includes('disconnect_agent_remote'));

      const status = await proxy.request(3, 'tools/call', { name: 'agent_remote_status', arguments: {} });
      assert.match(status.result.content[0].text, /Tester/);

      const progress = proxy.waitFor((message) => message.method === 'notifications/progress');
      const called = proxy.request(4, 'tools/call', { name: 'ask_user', arguments: { question: '继续吗？' } });
      assert.equal((await progress).params.progress, 1);
      assert.match((await called).result.content[0].text, /继续/);
    } finally {
      await stopProxy(proxy);
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('未连接时只提示从 WebUI 生成命令，不提供写配置工具', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-remote-empty-'));
    const proxy = startProxy(dataDir);
    try {
      await proxy.request(10, 'initialize');
      const listed = await proxy.request(11, 'tools/list');
      assert.deepEqual(listed.result.tools.map((tool) => tool.name), ['agent_remote_status']);
      const status = await proxy.request(12, 'tools/call', { name: 'agent_remote_status', arguments: {} });
      assert.equal(status.result.isError, true);
      assert.match(status.result.content[0].text, /WebUI|安装命令/i);
    } finally {
      await stopProxy(proxy);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
