#!/usr/bin/env node

import { ensureConfig } from './config.mjs';
import { Buffer } from 'node:buffer';

// Codex command hooks receive one JSON object on stdin and expect a JSON decision on stdout.
// Keep stdout machine-only; diagnostics go to stderr so they cannot corrupt the hook response.
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);

const fallback = () => process.stdout.write('{}\n');

let payload;
try {
  payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
} catch (error) {
  console.error(`[agent-remote] invalid hook payload: ${error.message}`);
  fallback();
  process.exit(0);
}

let config;
try {
  config = await ensureConfig();
} catch (error) {
  console.error(`[agent-remote] 初始化失败：${error.message}`);
  fallback();
  process.exit(0);
}
const token = config.token;
if (!token) {
  console.error('[agent-remote] 尚未连接；remote hook skipped');
  fallback();
  process.exit(0);
}

const timeoutSeconds = config.timeoutSeconds;
const requestTimeout = payload.hook_event_name === 'SessionEnd' ? 2000 : timeoutSeconds * 1000;
const baseUrl = config.baseUrl;

try {
  const response = await fetch(`${baseUrl}/codex`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Client-Name': config.clientName,
      'X-Timeout-Seconds': String(timeoutSeconds),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(requestTimeout),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.text();
  const decision = body ? JSON.parse(body) : {};
  if (decision === null || typeof decision !== 'object' || Array.isArray(decision)) throw new Error('server returned a non-object response');
  process.stdout.write(`${JSON.stringify(decision)}\n`);
} catch (error) {
  console.error(`[agent-remote] hook request failed: ${error.message}`);
  fallback();
}
