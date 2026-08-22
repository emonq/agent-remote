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