// SQLite 持久层: 用户(token/飞书绑定) + 事件流水 + 设置
import Database from 'better-sqlite3';
import crypto from 'node:crypto';

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

export const db = new Database(process.env.DB_PATH || 'data/agent-remote.db');
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
export const getUserBySub = (sub: string): User | undefined =>
  db.prepare('SELECT * FROM users WHERE sso_sub = ?').get(sub) as User | undefined;
export const getUserByOpenId = (openId: string): User | undefined =>
  db.prepare('SELECT * FROM users WHERE feishu_open_id = ?').get(openId) as User | undefined;
export const getUser = (id: string): User | undefined =>
  db.prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined;

export function rotateToken(userId: string): string {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('UPDATE users SET token = ? WHERE id = ?').run(token, userId);
  return token;
}

export function bindFeishu(userId: string, openId: string): void {
  // 一个 open_id 只能绑一个账号: 旧绑定被顶掉
  db.prepare('UPDATE users SET feishu_open_id = NULL WHERE feishu_open_id = ?').run(openId);
  db.prepare('UPDATE users SET feishu_open_id = ? WHERE id = ?').run(openId, userId);
}

export const unbindFeishu = (userId: string) =>
  db.prepare('UPDATE users SET feishu_open_id = NULL WHERE id = ?').run(userId);

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
