// SQLite 持久层: 用户(token/飞书绑定) + 事件流水
import Database from 'better-sqlite3';
import crypto from 'node:crypto';

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
`);

const now = () => Date.now();

export function upsertUser(ssoSub, name) {
  const existing = db.prepare('SELECT id FROM users WHERE sso_sub = ?').get(ssoSub);
  if (existing) {
    db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, existing.id);
    return existing.id;
  }
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO users (id, sso_sub, name, token, created_at) VALUES (?,?,?,?,?)')
    .run(id, ssoSub, name, crypto.randomBytes(32).toString('base64url'), now());
  return id;
}

export const getUserByToken = (token) => db.prepare('SELECT * FROM users WHERE token = ?').get(token);
export const getUserBySub = (sub) => db.prepare('SELECT * FROM users WHERE sso_sub = ?').get(sub);
export const getUserByOpenId = (openId) => db.prepare('SELECT * FROM users WHERE feishu_open_id = ?').get(openId);
export const getUser = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);

export function rotateToken(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('UPDATE users SET token = ? WHERE id = ?').run(token, userId);
  return token;
}

export function bindFeishu(userId, openId) {
  // 一个 open_id 只能绑一个账号: 旧绑定被顶掉
  db.prepare('UPDATE users SET feishu_open_id = NULL WHERE feishu_open_id = ?').run(openId);
  db.prepare('UPDATE users SET feishu_open_id = ? WHERE id = ?').run(openId, userId);
}

export const unbindFeishu = (userId) =>
  db.prepare('UPDATE users SET feishu_open_id = NULL WHERE id = ?').run(userId);

export const logEvent = (userId, type, payload = {}) =>
  db.prepare('INSERT INTO events (user_id, type, payload, created_at) VALUES (?,?,?,?)')
    .run(userId, type, JSON.stringify(payload), now());

export const listEvents = (userId, limit = 50) =>
  db.prepare('SELECT type, payload, created_at FROM events WHERE user_id = ? ORDER BY id DESC LIMIT ?')
    .all(userId, limit);
