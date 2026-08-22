// 飞书扫码一键创建应用: 官方 registerApp (OAuth Device Flow, SDK >= 1.61.1)
// 网页轮询状态机 — start 发起并立刻返回, 二维码/结果通过 getSetup 取
import * as Lark from '@larksuiteoapi/node-sdk';
import type { AppAddons } from '@larksuiteoapi/node-sdk';
import QRCode from 'qrcode';

// SDK 未导出 RegisterAppResult, 从 registerApp 返回类型派生
export type RegisterAppResult = Awaited<ReturnType<typeof Lark.registerApp>>;

// 本项目需要的增量配置, 预填到用户扫码后的确认页 (最小基座: 仅机器人能力)
// 注意: 权限名写错平台会静默忽略, tests/setup.test.mjs 里有断言兜底
export const APP_ADDONS: AppAddons = {
  preset: false,
  scopes: { tenant: ['im:message:send_as_bot', 'im:message.p2p_msg:readonly', 'im:resource'] },
  events: { items: { tenant: ['im.message.receive_v1'] } },
  callbacks: { items: ['card.action.trigger'] },
};

interface SetupRun {
  url: string | null;
  qrSvg: string | null;
  expireIn: number | null;
  result: RegisterAppResult | null;
  error: { code: string; description: string } | null;
  settled: boolean;
}

let run: SetupRun | null = null;

export const getSetup = (): SetupRun | null => run;

export function startSetup(onSuccess?: (r: RegisterAppResult) => void): void {
  if (run && !run.settled) return; // 已有进行中的流程
  run = { url: null, qrSvg: null, expireIn: null, result: null, error: null, settled: false };
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
  }).then(
    (r) => { run!.result = r; onSuccess?.(r); },
    (e: unknown) => {
      const err = e as { code?: string; description?: string; message?: string };
      run!.error = { code: err.code ?? 'error', description: err.description ?? String(err.message ?? e) };
    },
  ).finally(() => { if (run) run.settled = true; });
}