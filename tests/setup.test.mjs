// 扫码创建应用的增量配置: 权限/事件/回调名写错平台会静默忽略, 锁死关键名字
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  APP_ADDONS, APP_CONFIG_FINGERPRINT, CONTROL_MENU_CONFIG, appConfigurationState, configureRegisteredApp,
} from '../dist/setup.js';

describe('registerApp addons', () => {
  it('最小基座 + 精确权限/事件/回调', () => {
    assert.equal(APP_ADDONS.preset, false, '最小基座: 仅机器人能力');
    assert.deepEqual([...APP_ADDONS.scopes.tenant].sort(), [
      'application:application:patch', 'im:message.p2p_msg:readonly', 'im:message:send_as_bot', 'im:resource',
    ]);
    assert.deepEqual(APP_ADDONS.events.items.tenant, ['im.message.receive_v1', 'application.bot.menu_v6']);
    assert.deepEqual(APP_ADDONS.callbacks.items, ['card.action.trigger']);
  });

  it('按应用和目标配置生成稳定的启动同步状态', () => {
    assert.match(APP_CONFIG_FINGERPRINT, /^[0-9a-f]{16}$/);
    assert.equal(appConfigurationState('cli_test'), `cli_test:${APP_CONFIG_FINGERPRINT}`);
    assert.notEqual(appConfigurationState('cli_other'), appConfigurationState('cli_test'));
  });

  it('扫码后自动配置菜单、长连接并提交发布', async () => {
    const calls = [];
    const client = {
      application: { v7: {
        applicationAbility: { patch: async (payload) => { calls.push(['ability', payload]); return { code: 0 }; } },
        applicationConfig: { patch: async (payload) => { calls.push(['config', payload]); return { code: 0 }; } },
        applicationPublish: { create: async (payload) => {
          calls.push(['publish', payload]);
          return { code: 0, data: { version_id: 'oav_1', version: '1.0.0' } };
        } },
      } },
    };

    const result = await configureRegisteredApp({
      appId: 'cli_test', appSecret: 'secret', domain: 'feishu', client,
    });

    assert.deepEqual(result, { versionId: 'oav_1', version: '1.0.0' });
    assert.deepEqual(CONTROL_MENU_CONFIG, {
      menu_id: 'agent_remote_settings', sort: 1, default_name: '控制面板',
      i18n_name: { en_us: 'Control Panel' },
      event_key: 'agent_remote_settings', menu_content_type: 2,
    });
    assert.deepEqual(calls.map(([name]) => name), ['ability', 'config', 'publish']);
    assert.deepEqual(calls[0][1], {
      path: { app_id: 'cli_test' },
      data: { bot: {
        enable: true,
        bot_menu_enable: true,
        bot_menus: [{ ...CONTROL_MENU_CONFIG }],
        bot_menu_display_strategy: 1,
      } },
    });
    assert.deepEqual(calls[1][1].data, {
      event: {
        subscription_type: 'websocket',
        add_events: ['im.message.receive_v1', 'application.bot.menu_v6'],
      },
      callback: { callback_type: 'websocket', add_callbacks: ['card.action.trigger'] },
    });
    assert.equal(calls[2][1].data.mobile_default_ability, 'bot');
    assert.equal(calls[2][1].data.pc_default_ability, 'bot');
  });

  it('自动配置遇到飞书业务错误时停止发布并返回可读原因', async () => {
    let published = false;
    const client = {
      application: { v7: {
        applicationAbility: { patch: async () => ({ code: 210011, msg: 'Param is invalid' }) },
        applicationConfig: { patch: async () => ({ code: 0 }) },
        applicationPublish: { create: async () => { published = true; return { code: 0 }; } },
      } },
    };

    await assert.rejects(
      configureRegisteredApp({ appId: 'cli_test', appSecret: 'secret', domain: 'feishu', client }),
      /配置机器人菜单失败 \(210011\): Param is invalid/,
    );
    assert.equal(published, false);
  });
});
