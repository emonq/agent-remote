// 设置存储: 扫码初始化的凭据落 SQLite (内存库, 不碰 data/)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// db.js 在模块加载时即 new Database(DB_PATH), 必须在动态导入前定好 :memory:
process.env.DB_PATH = ':memory:';

describe('settings 存储', () => {
  it('get/set + upsert 覆盖 + 删除', async () => {
    const { getSetting, setSetting, delSetting } = await import('../dist/db.js');
    assert.equal(getSetting('k'), undefined);
    setSetting('k', 'v1');
    assert.equal(getSetting('k'), 'v1');
    setSetting('k', 'v2');
    assert.equal(getSetting('k'), 'v2', 'upsert 覆盖');
    delSetting('k');
    assert.equal(getSetting('k'), undefined, '删除生效');
    assert.doesNotThrow(() => delSetting('k'), '重复删除无害');
  });
});

describe('通知开关', () => {
  it('未设置按 DEFAULT_OFF(空闲提醒默认关); 存过则以存的全量为准; 非法输入按全开', async () => {
    const { getNotifyOff, setNotifyOff } = await import('../dist/db.js');
    assert.deepEqual(getNotifyOff('u1'), ['idle_prompt'], '未设置 = 空闲提醒默认关');
    setNotifyOff('u1', ['Stop', 'SessionEnd']);
    assert.deepEqual(getNotifyOff('u1'), ['Stop', 'SessionEnd']);
    setNotifyOff('u1', []);
    assert.deepEqual(getNotifyOff('u1'), [], '存过空数组 = 全开, 覆盖默认');
    setNotifyOff('u1', 'garbage');
    assert.deepEqual(getNotifyOff('u1'), [], '非数组按全开');
    setNotifyOff('u1', [1, 'Notification']);
    assert.deepEqual(getNotifyOff('u1'), ['Notification'], '非字符串项过滤');
  });
});

describe('Stop 拦截开关', () => {
  it('Codex 和 Claude Code 默认开启并可独立持久化', async () => {
    const { getStopIntercept, setStopIntercept, setSetting } = await import('../dist/db.js');
    assert.deepEqual(getStopIntercept('u1'), { codex: true, claude: true });
    setStopIntercept('u1', { codex: false, claude: true });
    assert.deepEqual(getStopIntercept('u1'), { codex: false, claude: true });
    setStopIntercept('u1', { codex: false, claude: false });
    assert.deepEqual(getStopIntercept('u1'), { codex: false, claude: false });
    setSetting('stop-intercept:u2', '{bad json');
    assert.deepEqual(getStopIntercept('u2'), { codex: true, claude: true });
  });
});

describe('Codex 设备凭据', () => {
  it('只存哈希，并在重置用户 token 时统一撤销', async () => {
    const { db, getUserByClientToken, issueClientToken, rotateToken, upsertUser } = await import('../dist/db.js');
    const userId = upsertUser('device-user', 'Device User');
    const token = issueClientToken(userId, 'codex', 'MacBook');
    assert.match(token, /^arc_/);
    assert.equal(getUserByClientToken(token)?.id, userId);
    const row = db.prepare('SELECT token_hash FROM client_credentials WHERE user_id = ?').get(userId);
    assert.notEqual(row.token_hash, token);
    rotateToken(userId);
    assert.equal(getUserByClientToken(token), undefined);
  });
});
