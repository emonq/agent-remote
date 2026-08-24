// SQLite 持久层: 用户(token/飞书绑定) + 事件流水 + 设置
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface User {
  id: string;
  sso_sub: string;
  name: string;
  feishu_open_id: string | null;
  token: string;
  created_at: number;
}

export interface EventRow {
  type: string;
  payload: string;
  created_at: number;
}

const DB_PATH = process.env.DB_PATH || 'data/agent-remote.db';
fs.mkdirSync(path.dirname(path.resolve(DB_PATH)), { recursive: true }); // 全新部署 (docker/新 clone) 没人建 data/
export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  sso_sub TEXT UNIQUE NOT NULL,        -- OIDC sub, 登录标识
  name TEXT NOT NULL DEFAULT '',
  feishu_open_id TEXT UNIQUE,          -- 绑定后可收决策消息
  token TEXT UNIQUE NOT NULL,          -- MCP/hook Bearer token
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS client_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  agent TEXT NOT NULL,
  client_name TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_client_credentials_user ON client_credentials(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  type TEXT NOT NULL,                  -- ask/solved/timeout/hook/bind ...
  payload TEXT NOT NULL DEFAULT '{}',  -- JSON
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id, id DESC);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

const now = () => Date.now();

export function upsertUser(ssoSub: string, name: string, id: string = crypto.randomUUID()): string {
  const existing = db.prepare('SELECT id FROM users WHERE sso_sub = ?').get(ssoSub) as { id: string } | undefined;
  if (existing) {
    db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, existing.id);
    return existing.id;
  }
  db.prepare('INSERT INTO users (id, sso_sub, name, token, created_at) VALUES (?,?,?,?,?)')
    .run(id, ssoSub, name, crypto.randomBytes(32).toString('base64url'), now());
  return id;
}

export const getUserByToken = (token: unknown): User | undefined =>
  db.prepare('SELECT * FROM users WHERE token = ?').get(String(token)) as User | undefined;
const clientTokenHash = (token: unknown): string =>
  crypto.createHash('sha256').update(String(token)).digest('hex');
export const getUserByClientToken = (token: unknown): User | undefined =>
  db.prepare(`
    SELECT users.* FROM client_credentials
    JOIN users ON users.id = client_credentials.user_id
    WHERE client_credentials.token_hash = ? AND client_credentials.revoked_at IS NULL
  `).get(clientTokenHash(token)) as User | undefined;
export const getUserBySub = (sub: string): User | undefined =>
  db.prepare('SELECT * FROM users WHERE sso_sub = ?').get(sub) as User | undefined;
export const getUserByOpenId = (openId: string): User | undefined =>
  db.prepare('SELECT * FROM users WHERE feishu_open_id = ?').get(openId) as User | undefined;
export const getUser = (id: string): User | undefined =>
  db.prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined;

export function rotateToken(userId: string): string {
  const token = crypto.randomBytes(32).toString('base64url');
  db.transaction(() => {
    db.prepare('UPDATE users SET token = ? WHERE id = ?').run(token, userId);
    db.prepare('UPDATE client_credentials SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now(), userId);
  })();
  return token;
}

export function issueClientToken(userId: string, agent: string, clientName: string): string {
  const token = `arc_${crypto.randomBytes(32).toString('base64url')}`;
  db.prepare(`
    INSERT INTO client_credentials (id, user_id, token_hash, agent, client_name, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), userId, clientTokenHash(token), agent, clientName, now());
  return token;
}

export function bindFeishu(userId: string, openId: string): void {
  // 一个 open_id 只能绑一个账号: 旧绑定被顶掉
  db.prepare('UPDATE users SET feishu_open_id = NULL WHERE feishu_open_id = ?').run(openId);
  db.prepare('UPDATE users SET feishu_open_id = ? WHERE id = ?').run(openId, userId);
}

export const unbindFeishu = (userId: string) =>
  db.prepare('UPDATE users SET feishu_open_id = NULL WHERE id = ?').run(userId);
// 取消应用配置时用: open_id 是应用维度的, 换应用后旧绑定全部失效
export const clearAllBindings = () => db.prepare('UPDATE users SET feishu_open_id = NULL').run();

export const logEvent = (userId: string | null, type: string, payload: Record<string, unknown> = {}) =>
  db.prepare('INSERT INTO events (user_id, type, payload, created_at) VALUES (?,?,?,?)')
    .run(userId, type, JSON.stringify(payload), now());

export const listEvents = (userId: string, limit = 50): EventRow[] =>
  db.prepare('SELECT type, payload, created_at FROM events WHERE user_id = ? ORDER BY id DESC LIMIT ?')
    .all(userId, limit) as EventRow[];

// 键值设置: 扫码初始化的应用凭据/open_id 落这里 (env 优先级更高, 见 server)
export const getSetting = (key: string): string | undefined =>
  (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;
export const setSetting = (key: string, value: unknown): void => {
  db.prepare('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
};
export const delSetting = (key: string) =>
  db.prepare('DELETE FROM settings WHERE key = ?').run(key);

// 每用户通知开关: 只存关掉的事件名数组, 存 settings 表 notify:<userId>
// 未设置过时按 DEFAULT_OFF (空闲提醒默认不推, 沿用旧硬编码行为); 存过则以存的全量为准
const notifyKey = (userId: string): string => `notify:${userId}`;
export const DEFAULT_OFF: string[] = ['idle_prompt'];
export const getNotifyOff = (userId: string): string[] => {
  const s = getSetting(notifyKey(userId));
  if (s === undefined) return DEFAULT_OFF;
  try { const v: unknown = JSON.parse(s); return Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string') : []; } catch { return []; }
};
export const setNotifyOff = (userId: string, off: unknown): void =>
  setSetting(notifyKey(userId), JSON.stringify(Array.isArray(off) ? off.filter((k) => typeof k === 'string') : []));
