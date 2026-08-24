import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const pluginRoot = process.env.PLUGIN_ROOT
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const pluginDataDir = process.env.PLUGIN_DATA || '';
export const configPath = pluginDataDir ? path.join(pluginDataDir, 'config.json') : '';
export const bootstrapPath = path.join(pluginRoot, 'bootstrap.json');

const readJson = (file) => {
  if (!file) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

const normalizedConfig = (saved) => {
  const parsedTimeout = Number(saved.timeoutSeconds || saved.timeout_seconds || 600);
  return {
    version: 2,
    baseUrl: String(saved.baseUrl || saved.base_url || '').replace(/\/+$/, ''),
    token: String(saved.token || ''),
    clientName: String(saved.clientName || saved.client_name || 'codex').trim().slice(0, 20) || 'codex',
    timeoutSeconds: Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? Math.min(parsedTimeout, 3600) : 600,
    configuredAt: saved.configuredAt,
  };
};

export function readStoredConfig() {
  return normalizedConfig(readJson(configPath));
}

export function effectiveConfig() {
  return readStoredConfig();
}

function validateConnectUrl(value) {
  const url = new URL(String(value || ''));
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname.toLowerCase());
  if (url.username || url.password || url.search || url.hash) throw new Error('安装地址格式无效');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('远程 Agent Remote 安装地址必须使用 HTTPS');
  }
  return url.toString();
}

function validateServiceUrl(value) {
  const url = new URL(String(value || ''));
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname.toLowerCase());
  if (url.username || url.password || url.search || url.hash) throw new Error('服务地址格式无效');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('远程 Agent Remote 服务必须使用 HTTPS');
  return url.origin;
}

function privateWriteConfig(value) {
  if (!pluginDataDir || !configPath) throw new Error('Codex 没有提供 PLUGIN_DATA，无法保存连接配置');
  fs.mkdirSync(pluginDataDir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(pluginDataDir, 0o700); } catch { /* Windows may not support POSIX modes. */ }
  const temporary = `${configPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, configPath);
    try { fs.chmodSync(configPath, 0o600); } catch { /* Windows may not support POSIX modes. */ }
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* Renamed or never created. */ }
  }
}

let activation;

async function redeemBootstrap(fetchImpl) {
  const bootstrap = readJson(bootstrapPath);
  if (!bootstrap.connectUrl) return readStoredConfig();
  const connectUrl = validateConnectUrl(bootstrap.connectUrl);
  const clientName = String(bootstrap.clientName || 'codex').trim().slice(0, 20) || 'codex';
  const response = await fetchImpl(connectUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_name: clientName }),
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.token || !result.base_url) {
    throw new Error(result.error || `安装票据兑换失败（HTTP ${response.status}）`);
  }
  const baseUrl = validateServiceUrl(result.base_url);
  if (new URL(baseUrl).origin !== new URL(connectUrl).origin) {
    throw new Error('服务地址与安装票据来源不一致');
  }
  const timeoutSeconds = Number(bootstrap.timeoutSeconds || result.timeout_seconds || 600);
  const stored = {
    version: 2,
    baseUrl,
    token: String(result.token),
    clientName: String(result.client_name || clientName).trim().slice(0, 20) || 'codex',
    timeoutSeconds: Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? Math.min(timeoutSeconds, 3600) : 600,
    configuredAt: new Date().toISOString(),
    configuredBy: 'one-time-install-ticket',
  };
  privateWriteConfig(stored);
  try { fs.unlinkSync(bootstrapPath); } catch { /* Another plugin process may have removed it. */ }
  return normalizedConfig(stored);
}

export async function ensureConfig(fetchImpl = fetch) {
  activation ||= redeemBootstrap(fetchImpl).finally(() => { activation = undefined; });
  try {
    return await activation;
  } catch (error) {
    const saved = readStoredConfig();
    if (saved.token) {
      try { fs.unlinkSync(bootstrapPath); } catch { /* Missing or read-only plugin root. */ }
      return saved;
    }
    throw error;
  }
}
