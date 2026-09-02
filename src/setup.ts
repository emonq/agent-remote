// 飞书扫码一键创建应用: 官方 registerApp (OAuth Device Flow, SDK >= 1.61.1)
// 网页轮询状态机 — start 发起并立刻返回, 二维码/结果通过 getSetup 取
import * as Lark from '@larksuiteoapi/node-sdk';
import type { AppAddons } from '@larksuiteoapi/node-sdk';
import { createHash } from 'node:crypto';
import QRCode from 'qrcode';
import { SETTINGS_MENU_EVENT_KEY } from './core.js';

// SDK 未导出 RegisterAppResult, 从 registerApp 返回类型派生
export type RegisterAppResult = Awaited<ReturnType<typeof Lark.registerApp>>;

// 本项目需要的增量配置, 预填到用户扫码后的确认页 (最小基座: 仅机器人能力)
// 注意: 权限名写错平台会静默忽略, tests/setup.test.mjs 里有断言兜底
export const APP_ADDONS: AppAddons = {
  preset: false,
  scopes: { tenant: [
    'im:message:send_as_bot',
    'im:message.p2p_msg:readonly',
    'im:resource',
    'application:application:patch',
  ] },
  events: { items: { tenant: ['im.message.receive_v1', 'application.bot.menu_v6'] } },
  callbacks: { items: ['card.action.trigger'] },
};

export const CONTROL_MENU_CONFIG = {
  menu_id: SETTINGS_MENU_EVENT_KEY,
  sort: 1,
  default_name: '控制面板',
  i18n_name: { en_us: 'Control Panel' },
  event_key: SETTINGS_MENU_EVENT_KEY,
  menu_content_type: 2,
} as const;

const AUTOMATED_APP_CONFIGURATION = {
  bot: {
    enable: true,
    bot_menu_enable: true,
    bot_menus: [CONTROL_MENU_CONFIG],
    bot_menu_display_strategy: 1,
  },
  event: {
    subscription_type: 'websocket',
    add_events: ['im.message.receive_v1', 'application.bot.menu_v6'],
  },
  callback: {
    callback_type: 'websocket',
    add_callbacks: ['card.action.trigger'],
  },
  default_ability: { mobile: 'bot', pc: 'bot' },
} as const;

// 目标配置变化时指纹自动变化。server 将 appId + 指纹存入 SQLite，启动时据此只同步一次。
export const APP_CONFIG_FINGERPRINT = createHash('sha256')
  .update(JSON.stringify(AUTOMATED_APP_CONFIGURATION))
  .digest('hex')
  .slice(0, 16);

export const appConfigurationState = (appId: string): string => `${appId}:${APP_CONFIG_FINGERPRINT}`;

type ApplicationClient = Pick<Lark.Client, 'application'>;

const ensureApiSuccess = (operation: string, result: { code?: number; msg?: string } | null): void => {
  if (!result) throw new Error(`${operation}失败：飞书未返回响应`);
  if (result.code === undefined || result.code === 0) return;
  throw new Error(`${operation}失败 (${result.code}): ${result.msg ?? '未知错误'}`);
};

export async function configureRegisteredApp({ appId, appSecret, domain, client }: {
  appId: string;
  appSecret: string;
  domain: Lark.Domain;
  client?: ApplicationClient;
}): Promise<{ versionId?: string; version?: string }> {
  const api = client ?? new Lark.Client({ appId, appSecret, domain });

  const ability = await api.application.v7.applicationAbility.patch({
    path: { app_id: appId },
    data: {
      bot: {
        ...AUTOMATED_APP_CONFIGURATION.bot,
        bot_menus: AUTOMATED_APP_CONFIGURATION.bot.bot_menus.map((menu) => ({ ...menu })),
      },
    },
  });
  ensureApiSuccess('配置机器人菜单', ability);

  const config = await api.application.v7.applicationConfig.patch({
    path: { app_id: appId },
    data: {
      event: {
        ...AUTOMATED_APP_CONFIGURATION.event,
        add_events: [...AUTOMATED_APP_CONFIGURATION.event.add_events],
      },
      callback: {
        ...AUTOMATED_APP_CONFIGURATION.callback,
        add_callbacks: [...AUTOMATED_APP_CONFIGURATION.callback.add_callbacks],
      },
    },
  });
  ensureApiSuccess('配置长连接事件', config);

  const published = await api.application.v7.applicationPublish.create({
    path: { app_id: appId },
    data: {
      mobile_default_ability: AUTOMATED_APP_CONFIGURATION.default_ability.mobile,
      pc_default_ability: AUTOMATED_APP_CONFIGURATION.default_ability.pc,
      remark: 'Agent Remote 初始配置',
      changelog: '配置长连接事件、卡片回调和机器人控制面板',
    },
  });
  ensureApiSuccess('提交应用发布', published);
  return { versionId: published?.data?.version_id, version: published?.data?.version };
}

interface SetupRun {
  url: string | null;
  qrSvg: string | null;
  expireIn: number | null;
  result: RegisterAppResult | null;
  error: { code: string; description: string } | null;
  warning: { code: string; description: string } | null;
  settled: boolean;
}

let run: SetupRun | null = null;

export const getSetup = (): SetupRun | null => run;

const setupError = (value: unknown): { code: string; description: string } => {
  const err = value && typeof value === 'object'
    ? value as { code?: string | number; description?: string; message?: string }
    : {};
  return { code: String(err.code ?? 'error'), description: err.description ?? String(err.message ?? value) };
};

export function startSetup(onSuccess?: (r: RegisterAppResult) => void | Promise<void>): void {
  if (run && !run.settled) return; // 已有进行中的流程
  run = { url: null, qrSvg: null, expireIn: null, result: null, error: null, warning: null, settled: false };
  void Lark.registerApp({
    source: 'agent-remote',
    createOnly: true, // 只允许创建新应用, 防止误选已有应用被覆盖配置
    appPreset: { name: 'agent-remote', desc: '把 Agent 的决策问题推到飞书' },
    addons: APP_ADDONS,
    onQRCodeReady: async (info) => {
      run!.url = info.url;
      run!.expireIn = info.expireIn;
      run!.qrSvg = await QRCode.toString(info.url, { type: 'svg', margin: 1 });
    },
  }).then(async (r) => {
    try {
      await onSuccess?.(r);
    } catch (e: unknown) {
      run!.warning = setupError(e);
    }
    run!.result = r;
  }).catch((e: unknown) => {
    run!.error = setupError(e);
  }).finally(() => { if (run) run.settled = true; });
}
