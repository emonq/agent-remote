// 扫码创建应用的增量配置: 权限/事件/回调名写错平台会静默忽略, 锁死关键名字
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { APP_ADDONS } from '../dist/setup.js';

describe('registerApp addons', () => {
  it('最小基座 + 精确权限/事件/回调', () => {
    assert.equal(APP_ADDONS.preset, false, '最小基座: 仅机器人能力');
    assert.deepEqual([...APP_ADDONS.scopes.tenant].sort(), ['im:message.p2p_msg:readonly', 'im:message:send_as_bot', 'im:resource']);
    assert.deepEqual(APP_ADDONS.events.items.tenant, ['im.message.receive_v1']);
    assert.deepEqual(APP_ADDONS.callbacks.items, ['card.action.trigger']);
  });
});