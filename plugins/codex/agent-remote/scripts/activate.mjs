#!/usr/bin/env node

import { ensureConfig } from './config.mjs';

try {
  const config = await ensureConfig();
  if (config.token) console.error(`[agent-remote] 已连接 ${config.baseUrl}`);
} catch (error) {
  console.error(`[agent-remote] 初始化失败：${error.message}`);
}

process.stdout.write('{}\n');
