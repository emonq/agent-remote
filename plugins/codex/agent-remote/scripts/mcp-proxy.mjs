#!/usr/bin/env node

// 零依赖 stdio MCP 桥接：首次启动兑换安装票据，之后只读取 PLUGIN_DATA 中的私有配置。
// stdout 必须保持 JSON-RPC 机器输出，所有诊断只写 stderr。
import readline from 'node:readline';
import { effectiveConfig, ensureConfig } from './config.mjs';

const VERSION = '1.4.0';
let protocolVersion = '2025-06-18';

const localTools = [
  {
    name: 'agent_remote_status',
    description: '只读检查 Agent Remote 配置、服务连通性和飞书/Lark 绑定状态；不会创建、修改或删除配置。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const textResult = (text, isError = false) => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });
const rpcError = (id, code, message) => send({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const log = (message) => console.error(`[agent-remote] ${message}`);

try { await ensureConfig(); } catch (error) { log(`初始化失败：${error.message}`); }

async function messagesFromResponse(response, onMessage) {
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream')) {
    const body = await response.text();
    if (!body) return [];
    const parsed = JSON.parse(body);
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    for (const message of messages) onMessage?.(message);
    return messages;
  }

  const messages = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const consume = (final = false) => {
    for (;;) {
      const match = /\r?\n\r?\n/.exec(buffer);
      if (!match && !final) break;
      const event = match ? buffer.slice(0, match.index) : buffer;
      buffer = match ? buffer.slice(match.index + match[0].length) : '';
      const data = event.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
      if (data) {
        const message = JSON.parse(data);
        messages.push(message);
        onMessage?.(message);
      }
      if (!match) break;
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    consume();
  }
  buffer += decoder.decode();
  consume(true);
  return messages;
}

async function remoteRequest(request, onMessage, timeoutMs) {
  const config = await ensureConfig();
  if (!config.token) throw new Error('尚未配置 Agent Remote');
  const headers = {
    Authorization: `Bearer ${config.token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'X-Client-Name': config.clientName,
    'MCP-Protocol-Version': protocolVersion,
  };
  const response = await fetch(`${config.baseUrl}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify(request),
    ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
  });
  return messagesFromResponse(response, onMessage);
}

async function remoteTools() {
  const request = { jsonrpc: '2.0', id: `list-${Date.now()}`, method: 'tools/list', params: {} };
  const messages = await remoteRequest(request, undefined, 10_000);
  const response = messages.find((message) => message?.id === request.id);
  if (response?.error) throw new Error(response.error.message || '远端 tools/list 失败');
  return Array.isArray(response?.result?.tools) ? response.result.tools : [];
}

async function status() {
  const config = await ensureConfig();
  if (!config.token) return textResult('Agent Remote 尚未连接。请在 Agent Remote WebUI 生成新的 Codex 一键安装命令。', true);
  try {
    const response = await fetch(`${config.baseUrl}/client/status`, {
      headers: { Authorization: `Bearer ${config.token}`, 'X-Client-Name': config.clientName, Accept: 'application/json' },
      signal: AbortSignal.timeout(5_000),
    });
    const result = await response.json().catch(() => ({}));
    if (response.status === 401) return textResult(`本地已有 ${config.baseUrl} 的配置，但设备凭据已失效。请在 Agent Remote WebUI 重新生成安装命令。`, true);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return textResult(`Agent Remote 已连接。\n服务：${config.baseUrl}\n账号：${result.user_name || 'default'}\n客户端：${config.clientName}\n飞书/Lark：${result.bound ? '已绑定' : '尚未绑定'}`);
  } catch (error) {
    return textResult(`本地已有配置，但目前无法访问 ${config.baseUrl}：${error.message}`, true);
  }
}

async function callLocal(name) {
  if (name === 'agent_remote_status') return status();
  return null;
}

async function handle(message) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return rpcError(message?.id, -32600, 'Invalid Request');
  const { id, method, params = {} } = message;
  if (method === 'initialize') {
    protocolVersion = params.protocolVersion || protocolVersion;
    return send({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'agent-remote-codex-bridge', version: VERSION },
        instructions: 'Connection is provisioned only by the one-click command shown in the Agent Remote WebUI. Never ask the user for a token or modify configuration through chat.',
      },
    });
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (method === 'tools/list') {
    let tools = [];
    if (effectiveConfig().token) {
      try { tools = await remoteTools(); } catch (error) { log(`读取远端工具失败：${error.message}`); }
    }
    const names = new Set(localTools.map((tool) => tool.name));
    return send({ jsonrpc: '2.0', id, result: { tools: [...localTools, ...tools.filter((tool) => !names.has(tool.name))] } });
  }
  if (method === 'tools/call') {
    const local = await callLocal(params.name).catch((error) => textResult(error.message, true));
    if (local) return send({ jsonrpc: '2.0', id, result: local });
    if (!effectiveConfig().token) return send({ jsonrpc: '2.0', id, result: textResult('Agent Remote 尚未连接。请在 Agent Remote WebUI 生成新的 Codex 一键安装命令。', true) });
    try {
      const messages = await remoteRequest({ jsonrpc: '2.0', id, method, params }, (response) => send(response));
      if (!messages.some((response) => response?.id === id)) rpcError(id, -32603, '远端 MCP 没有返回最终结果');
    } catch (error) {
      rpcError(id, -32000, `Agent Remote 请求失败：${error.message}`);
    }
    return;
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { return rpcError(null, -32700, 'Parse error'); }
  void handle(message).catch((error) => rpcError(message?.id, -32603, error.message));
});
