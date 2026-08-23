// agent-remote: 多用户 MCP 中心服务 — agent 阻塞式问用户, 飞书收发, OIDC 登录
// MCP: Streamable HTTP + 每用户 token;  飞书: 官方 SDK WS 长连接(免公网回调)
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Lark from '@larksuiteoapi/node-sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  pending, resolvePending, createPending, setMessageId, pendingForUser, matchFreeText,
  questionCard, resolvedCard, hookCard, stopCard, stopHookResponse, notifyKeyOf,
  permissionCard, permissionHookResponse, PERM_OPTIONS, mkCard,
  fileKind, issueUploadTicket, takeUploadTicket, issueBindCode, takeBindCode,
  resolveDomain,
  type ClaudeHook, type CardCallbackValue,
} from './core.js';
import {
  upsertUser, getUserByToken, getUser, getUserByOpenId, rotateToken,
  bindFeishu, unbindFeishu, clearAllBindings, logEvent, listEvents,
  getSetting, setSetting, delSetting, getNotifyOff, setNotifyOff,
  type User,
} from './db.js';
import { oidcConfigured, loginUrl, handleCallback, signSession, verifySession, bumpSessionVersion } from './auth.js';
import { startSetup, getSetup, type RegisterAppResult } from './setup.js';

const {
  MCP_TOKEN,            // 未配 SSO 时的单用户 token (兼容旧部署)
  FEISHU_APP_ID,
  FEISHU_APP_SECRET,
  PORT = 3000,
  BASE_URL = `http://127.0.0.1:${PORT}`, // Host 头缺失时的兜底回传地址
} = process.env as Record<string, string | undefined> & { PORT?: string; BASE_URL?: string };

if (!MCP_TOKEN && !oidcConfigured()) console.log('未配 MCP_TOKEN/OIDC: 单用户模式, token 需在管理页生成');
const MULTIUSER = oidcConfigured();
// 单用户也是一行真实记录: 复用多用户的 /bind 绑定码流程, 不再有 FEISHU_USER_OPEN_ID
if (!MULTIUSER) upsertUser('single', 'default', 'single');

// ---------- 飞书 ----------
// 凭据来源优先级: env > 扫码初始化落 SQLite 的; 都没有也照常起服务, 打开 /setup 扫码一键创建并绑定
let appId = FEISHU_APP_ID || getSetting('feishu_app_id') || '';
let appSecret = FEISHU_APP_SECRET || getSetting('feishu_secret') || '';
const { domain, conflict } = resolveDomain({
  envDomain: process.env.FEISHU_DOMAIN,
  savedDomain: getSetting('feishu_domain'),
  envApp: Boolean(FEISHU_APP_ID && FEISHU_APP_SECRET),
});
let domainStr = domain;
// 渠道按可用的来; 与 .env 声明不一致仅提醒
if (conflict) console.warn(`[feishu] .env FEISHU_DOMAIN=${process.env.FEISHU_DOMAIN} 与扫码创建应用的渠道(${getSetting('feishu_domain')})不一致, 按可用渠道用 ${domainStr}; 请对齐 .env 或重新扫码`);
const asDomain = () => (domainStr === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu);

// 管理凭据 key: 每次启动随机; /setup 与单用户网页写操作都认它 (或 env MCP_TOKEN)
const setupKey = crypto.randomBytes(6).toString('hex');
const keyOk = (k: unknown): boolean => k === setupKey || (MCP_TOKEN && k === MCP_TOKEN);

let lark: Lark.Client | null = null;
let ws: Lark.WSClient | null = null; // 取消配置时断开旧应用的长连接

// card.action.trigger 回调载荷 (SDK IHandles 未类型化此回调事件, 自建用到的部分)
interface CardActionTriggerData {
  action?: { value?: CardCallbackValue; tag?: string };
}

// 错误对象 → 可读字符串: 飞书错误带 code/msg, 标准 Error 带 message, 其余兜底
const errStr = (e: unknown): string => {
  const err = e as { code?: string; msg?: string; message?: string };
  return err.code ?? err.msg ?? err.message ?? '<unknown>';
};

async function sendCard(card: object, openId: string): Promise<string | undefined> {
  const res = await lark!.im.v1.message.create({
    params: { receive_id_type: 'open_id' },
    data: { receive_id: openId, msg_type: 'interactive', content: JSON.stringify(card) },
  });
  return res.data?.message_id;
}

function updateCard(messageId: string, card: object) {
  return lark!.im.v1.message.patch({ path: { message_id: messageId }, data: { content: JSON.stringify(card) } });
}

// 路径 → 飞书消息: 图片直显, 其余按 file_type 枚举上传后发文件消息; name 为用户看到的文件名(与本地路径无关)
async function deliverFile(path: string, openId: string, name: string = path.split('/').pop()!): Promise<void> {
  const stat = fs.statSync(path);
  const kind = fileKind(name);
  if (kind === 'image') {
    if (stat.size > 10 * 1024 * 1024) throw new Error(`图片 ${stat.size} bytes 超过飞书 10MB 上限`);
    const { image_key } = await lark!.im.v1.image.create({ data: { image_type: 'message', image: fs.createReadStream(path) } });
    await lark!.im.v1.message.create({ params: { receive_id_type: 'open_id' }, data: { receive_id: openId, msg_type: 'image', content: JSON.stringify({ image_key }) } });
  } else {
    if (stat.size > 30 * 1024 * 1024) throw new Error(`文件 ${stat.size} bytes 超过飞书 30MB 上限`);
    const { file_key } = await lark!.im.v1.file.create({ data: { file_type: kind, file_name: name, file: fs.createReadStream(path) } });
    await lark!.im.v1.message.create({ params: { receive_id_type: 'open_id' }, data: { receive_id: openId, msg_type: 'file', content: JSON.stringify({ file_key }) } });
  }
}

// ---------- 飞书事件 (WSClient 长连接, 免公网) ----------
// 凭据就绪才初始化; 扫码完成后会再次调用。失败不退出进程, 网页/引导仍可用
function initFeishu(): boolean {
  if (!appId || !appSecret) return false;
  lark = new Lark.Client({ appId, appSecret, domain: asDomain() });
  ws = new Lark.WSClient({
    appId, appSecret, domain: asDomain(),
    onError: (e) => console.error('[feishu ws]', errStr(e)),
  });
  ws.start({
    eventDispatcher: new Lark.EventDispatcher({}).register({
      'card.action.trigger': async (data: CardActionTriggerData) => {
        const { value } = data.action ?? {};
        if (!value?.d) return {};
        const p = pending.get(value.d);
        if (!p || !resolvePending(value.d, value.a)) return {};
        updateCard(p.messageId!, resolvedCard(p.question, value.a, false, p.source)).catch(() => {});
        logEvent(p.userId, 'solved', { via: 'button', answer: value.a, question: p.question });
        return { toast: { type: 'success', content: '已回复 agent' } };
      },
      'im.message.receive_v1': async (data) => {
        console.log('[debug] msg event:', JSON.stringify(data).slice(0, 400));
        const msg = data.message;
        if (!msg || msg.chat_type !== 'p2p') return;
        const text = msg.message_type === 'text' ? (JSON.parse(msg.content) as { text?: string }).text?.trim() : '';
        if (!text) return;
        const openId = data.sender?.sender_id?.open_id;

        // /bind 绑定码
        const bindMatch = String(text).match(/^\/bind\s+(\d{6})$/);
        if (bindMatch) {
          const userId = takeBindCode(bindMatch[1]);
          const user = userId && getUser(userId);
          if (user) {
            bindFeishu(user.id, openId);
            logEvent(user.id, 'bind', { open_id: openId });
            sendCard(mkCard('green', '✅ 绑定成功', [{ tag: 'markdown', content: `账号 **${user.name}** 已绑定此飞书` }]), openId).catch(() => {});
          } else {
            sendCard(mkCard('red', '❌ 绑定码无效或已过期', [{ tag: 'markdown', content: '请到网页重新生成绑定码 (10 分钟内有效)' }]), openId).catch(() => {});
          }
          return;
        }

        // 按发信人路由: open_id → user (单用户绑定后同样能引用回复/发文本答案)
        const user = getUserByOpenId(openId);
        const hit = user && matchFreeText({ userId: user.id, parentId: msg.parent_id, text });
        if (hit) {
          updateCard(hit.p.messageId!, resolvedCard(hit.p.question, text, false, hit.p.source)).catch(() => {});
          logEvent(user.id, 'solved', { via: 'text', answer: text, question: hit.p.question });
        } else if (user && pendingForUser(user.id).length) {
          sendCard(mkCard('red', '⚠️ 没有匹配到待回复的问题', [{ tag: 'markdown', content: `你发了: ${text}\n\n当前有 ${pendingForUser(user.id).length} 个待回复问题。请**长按引用**对应的消息再回复。` }]), openId).catch(() => {});
        }
      },
    }),
  }).then(() => console.log('feishu ws connected'))
    .catch((e: unknown) => console.error('[feishu ws] start failed:', errStr(e)));
  return true;
}
if (!initFeishu()) {
  console.log(`未配置飞书应用: 打开 http://127.0.0.1:${PORT}/setup?key=${setupKey} 扫码一键创建并绑定`);
} else if (!MULTIUSER) {
  console.log(`单用户管理页(绑定飞书/token): http://127.0.0.1:${PORT}/?key=${setupKey}`);
}

// ---------- MCP ----------
// 每请求新建 (stateless): user/clientName/baseUrl 走闭包, MCP SDK handler 拿不到请求上下文
// baseUrl 取请求 Host: agent 连哪个地址来, curl 就指回哪个地址
function newMcpServer(user: User, clientName = '', baseUrl: string = BASE_URL!): McpServer {
  const mcp = new McpServer({ name: 'agent-remote', version: '0.3.0' });
  mcp.tool(
    'ask_user',
    '需要用户决策时【优先】使用本工具, 而不是在对话中等待用户输入。发送问题到用户手机(飞书), 阻塞等待用户回复, 回复内容直接作为工具结果返回, 期间可继续做其他工作。默认不限时一直等; options 提供候选项时用户可一键点选; 不提供则等待自由文本(用户需引用该消息回复)。传了 timeout_minutes 才会超时, 超时返回 {"timeout": true}, 由 agent 自行决定默认行为。',
    {
      question: z.string().describe('要问的问题, 写清楚上下文和推荐选项'),
      options: z.array(z.string()).max(6).optional().describe('候选项, 建议不超过 4 个; 开放性问题(需要用户输入文字)不要传此参数'),
      timeout_minutes: z.number().int().min(1).max(120).optional().describe('最长等待分钟数; 不传则一直等到用户回复'),
    },
    async ({ question, options, timeout_minutes }, extra) => {
      if (!user.feishu_open_id) return { content: [{ type: 'text', text: `用户 ${user.name} 尚未绑定飞书 (网页生成绑定码后在飞书发 /bind)` }], isError: true };
      let resolveFn!: (a: string | null | undefined) => void;
      const answerPromise = new Promise<string | null>((r) => { resolveFn = r; });
      const id = createPending({ resolve: resolveFn, userId: user.id, options: options ?? null, question, source: clientName, timeoutMinutes: timeout_minutes }); // 不传=不限时
      logEvent(user.id, 'ask', { question, options, source: clientName });
      let messageId: string | undefined;
      try {
        messageId = await sendCard(questionCard({ id, question, options: options ?? null, source: clientName, timeoutSec: timeout_minutes && timeout_minutes * 60 }), user.feishu_open_id);
        setMessageId(id, messageId);
      } catch (e) {
        resolvePending(id, undefined);
        return { content: [{ type: 'text', text: `发送到飞书失败: ${(e as Error).message}` }], isError: true };
      }
      // 心跳保活: 每 60s 发 progress 重置客户端空闲断开(HTTP 默认 5 分钟无字节即 abort); 客户端没带 token 就发不了
      const token = (extra._meta as { progressToken?: string | number } | undefined)?.progressToken;
      let beats = 0;
      const beat = token === undefined ? null : setInterval(() => {
        extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: ++beats, message: '仍在等待手机回复' } }).catch(() => {});
      }, 60_000);
      try {
        const answer = await answerPromise;
        if (answer === null) {
          updateCard(messageId, resolvedCard(question, null, true, clientName)).catch(() => {});
          logEvent(user.id, 'timeout', { question });
          return { content: [{ type: 'text', text: JSON.stringify({ timeout: true }) }] };
        }
        updateCard(messageId, resolvedCard(question, answer, false, clientName)).catch(() => {});
        return { content: [{ type: 'text', text: JSON.stringify({ answer }) }] };
      } finally {
        if (beat) clearInterval(beat);
      }
    },
  );
  mcp.tool(
    'send_file',
    '把 agent 工作空间的文件发送到用户手机(飞书)。图片(png/jpg/gif/webp等)聊天里直接显示, 其余类型以文件消息发送(用户可点开预览/下载)。上限: 图片 10MB, 文件 30MB。本工具返回一条 curl 命令(上传端点一次性), 必须原样执行它把文件内容传给服务端才算发送完成; curl 返回 {"ok":true} 即成功, 失败把响应原样报告给用户。',
    { path: z.string().describe('要发送文件的绝对路径') },
    async ({ path }) => {
      if (!user.feishu_open_id) return { content: [{ type: 'text', text: `用户 ${user.name} 尚未绑定飞书` }], isError: true };
      const t = issueUploadTicket(user.id);
      const name = encodeURIComponent(path.split('/').pop()!);
      return { content: [{ type: 'text', text: `执行以下命令上传文件:\ncurl -sS -X POST --data-binary @${JSON.stringify(path)} "${baseUrl}/file?t=${t}&name=${name}"` }] };
    },
  );
  return mcp;
}

// ---------- HTTP ----------
const app = express();
app.use(express.json());
app.use(express.static('public')); // 前端脚本/页面静态资源 (/app.js /setup.js ...)
const rawBody = express.raw({ type: () => true, limit: '35mb' }); // /file 专用: 收任意 content-type 的原始字节

// token 认证: 多用户查 DB; 单用户认 single 行的 DB token (网页可生成) 或 env MCP_TOKEN (兼容旧部署)
function tokenAuth(req: Request & { user?: User; clientName?: string }, res: Response, next: NextFunction): void {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  const u = MULTIUSER ? getUserByToken(token) : getUser('single');
  const ok = u && (MULTIUSER || token === u.token || (MCP_TOKEN && token === MCP_TOKEN));
  if (!ok || !u) return void res.status(401).end();
  req.user = u;
  req.clientName = String(req.headers['x-client-name'] ?? '').trim().slice(0, 20);
  next();
}

// session 认证 (网页用)
export function sessionAuth(req: Request & { user?: User | null }, _res: Response, next: NextFunction): void {
  const cookie = req.headers.cookie?.match(/session=([^;]+)/)?.[1];
  const userId = verifySession(cookie);
  req.user = userId ? getUser(userId) : null;
  next();
}

// 网页写操作鉴权: 多用户要登录; 单用户无账号体系, ?key= 认启动 key 或 env MCP_TOKEN
function userAuth(req: Request & { user?: User | null }, res: Response, next: NextFunction): void {
  if (!MULTIUSER) {
    if (!keyOk(req.query.key)) return void res.status(403).json({ error: '缺少有效凭据: 用启动日志的管理地址打开, 或在页面输入 MCP_TOKEN' });
    req.user = getUser('single')!;
    return next();
  }
  return sessionAuth(req, res, next);
}

app.get('/healthz', (_q: Request, s: Response) => s.send('ok'));
app.get('/', sessionAuth, (_q: Request, s: Response) => s.sendFile('index.html', { root: 'public' }));

// OIDC
const states = new Map<string, number>(); // state -> expires (CSRF)
app.get('/auth/login', async (req: Request, res: Response) => {
  const state = crypto.randomBytes(16).toString('base64url');
  states.set(state, Date.now() + 600_000);
  res.redirect(await loginUrl(state));
});
app.get('/auth/callback', async (req: Request, res: Response) => {
  const { code, state } = req.query as { code?: string; state?: string };
  if (!code || !state || !states.get(state)) return res.status(400).send('bad state');
  states.delete(state);
  try {
    const { sub, name } = await handleCallback(code);
    const userId = upsertUser(sub, name);
    res.setHeader('set-cookie', `session=${signSession(userId)}; Path=/; HttpOnly; Max-Age=2592000; SameSite=Lax`);
    res.redirect('/');
  } catch (e) {
    res.status(500).send(`login failed: ${(e as Error).message}`);
  }
});

// 注销: 清 cookie + 使该用户所有 session 失效
app.post('/auth/logout', sessionAuth, (req: Request & { user?: User | null }, res: Response) => {
  if (req.user) bumpSessionVersion(req.user.id);
  res.setHeader('set-cookie', 'session=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax');
  res.json({ ok: true });
});

// 网页 API
app.get('/api/me', sessionAuth, (req: Request & { user?: User | null }, res: Response) => {
  if (!MULTIUSER) {
    // 单用户: 无登录体系, key 通过则开放管理 (绑定/token), 否则只读展示
    const u = getUser('single')!;
    return res.json({
      single: true, name: u.name, multiuser: false,
      app_configured: Boolean(appId && appSecret),
      bound: Boolean(u.feishu_open_id),
      key_ok: keyOk(req.query.key),
      token_locked: Boolean(MCP_TOKEN), // env 配置的 token 只读展示, 网页不可重置
      notify: getNotifyOff(u.id),
      events: listEvents(u.id, 30),
    });
  }
  if (!req.user) return res.status(401).json({ login: '/auth/login' });
  res.json({ name: req.user.name, bound: Boolean(req.user.feishu_open_id), multiuser: true, app_configured: Boolean(appId && appSecret), notify: getNotifyOff(req.user.id), events: listEvents(req.user.id, 30) });
});
// 通知开关: body = 关掉的事件名数组 (缺省全开)
app.post('/api/notify', userAuth, (req: Request & { user: User }, res: Response) => {
  setNotifyOff(req.user.id, req.body);
  res.json({ ok: true });
});
app.post('/api/rotate-token', userAuth, (req: Request & { user: User }, res: Response) => {
  if (!MULTIUSER && MCP_TOKEN) return res.status(403).json({ error: 'token 来自环境变量 MCP_TOKEN, 请改 .env 后重启' });
  const token = rotateToken(req.user.id);
  logEvent(req.user.id, 'token_rotated', {});
  res.json({ token });
});
app.post('/api/bind-code', userAuth, (req: Request & { user: User }, res: Response) => {
  res.json({ code: issueBindCode(req.user.id) });
});
app.post('/api/unbind', userAuth, (req: Request & { user: User }, res: Response) => {
  unbindFeishu(req.user.id);
  logEvent(req.user.id, 'unbind', {});
  res.json({ ok: true });
});
app.get('/api/token', userAuth, (req: Request & { user: User }, res: Response) => {
  res.json({ token: req.user.token });
});

// ---------- 扫码一键创建飞书应用 (/setup) ----------
// registerApp 成功后: 凭据落 SQLite (env 优先级更高), 单用户顺手把扫码人绑上
function applySetupResult(r: RegisterAppResult): void {
  appId = r.client_id;
  appSecret = r.client_secret;
  if (r.user_info?.tenant_brand === 'lark' || r.user_info?.tenant_brand === 'feishu') domainStr = r.user_info.tenant_brand;
  setSetting('feishu_app_id', appId);
  setSetting('feishu_secret', appSecret);
  setSetting('feishu_domain', domainStr);
  if (!MULTIUSER && r.user_info?.open_id) bindFeishu('single', r.user_info.open_id);
  logEvent(MULTIUSER ? null : 'single', 'bind', { via: 'scan_setup', app_id: appId });
  initFeishu();
  console.log(`[setup] 飞书应用已创建并绑定: ${appId}`);
  const me = !MULTIUSER ? getUser('single') : undefined;
  if (me?.feishu_open_id) {
    sendCard(mkCard('green', '🎉 飞书应用已就绪', [{ tag: 'markdown', content: `**${appId}** 已创建并绑定本服务。\n\n之后 agent 的提问会直接推到这里。` }]), me.feishu_open_id).catch((e: unknown) => console.error('[setup] card:', errStr(e)));
  }
}

// 已配置后引导页关闭 — 重扫须先在管理页「取消配置」; 未配置窗口期凭 key 防局域网内他人抢绑自己的应用
const setupGated = [
  (req: Request, res: Response, next: NextFunction) => { if (appId && appSecret) return res.redirect('/'); next(); },
  (req: Request, res: Response, next: NextFunction) => { if (!keyOk(req.query.key)) return res.status(403).send('setup key 无效 (见服务启动日志)'); next(); },
];
app.get('/setup', ...setupGated, (_q: Request, s: Response) => s.sendFile('setup.html', { root: 'public' }));
app.post('/api/setup/start', ...setupGated, (_q: Request, res: Response) => { startSetup(applySetupResult); res.json({ ok: true }); });
// status 不拦"已配置": 完成瞬间页面还要靠它拿到 done 再跳转
app.get('/api/setup/status', (req: Request, res: Response, next: NextFunction) => {
  if (!keyOk(req.query.key)) return res.status(403).end();
  next();
}, (_q: Request, res: Response) => {
  const s = getSetup();
  if (!s || (!s.url && !s.result && !s.error)) return res.json({ phase: 'idle' });
  if (s.error) return res.json({ phase: 'error', code: s.error.code, description: s.error.description });
  if (s.result) return res.json({ phase: 'done' });
  res.json({ phase: 'waiting', url: s.url, qr_svg: s.qrSvg, expire_in: s.expireIn });
});

// 取消配置: 清扫码落库的凭据 + 全部飞书绑定 (open_id 是应用维度的), 断开旧应用长连接; 之后 /setup 可重扫
app.post('/api/unconfigure', (req: Request, res: Response) => {
  if (!keyOk(req.query.key)) return res.status(403).json({ error: 'setup key 无效 (见服务启动日志)' });
  if (FEISHU_APP_ID && FEISHU_APP_SECRET) return res.status(403).json({ error: '凭据来自环境变量 FEISHU_APP_ID/SECRET, 请改 .env 后重启' });
  if (!appId || !appSecret) return res.status(400).json({ error: '尚未配置' });
  delSetting('feishu_app_id'); delSetting('feishu_secret'); delSetting('feishu_domain');
  appId = ''; appSecret = ''; domainStr = 'feishu';
  ws?.close(); lark = null;
  clearAllBindings();
  logEvent(null, 'unbind', { via: 'unconfigure' });
  console.log(`[setup] 已取消飞书配置, 重新配对: http://127.0.0.1:${PORT}/setup?key=${setupKey}`);
  res.json({ ok: true });
});

// MCP endpoint
app.all('/mcp', tokenAuth, async (req: Request & { user: User; clientName?: string }, res: Response) => {
  try {
    const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await newMcpServer(req.user, req.clientName ?? '', `http://${req.headers.host}`).connect(t);
    await t.handleRequest(req, res, req.body);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// send_file 回落: agent 机器上的文件凭一次性票据推上来, 落盘后转发飞书
app.post('/file', rawBody, (req: Request, res: Response) => {
  const userId = takeUploadTicket(req.query.t);
  if (!userId) return res.status(401).json({ error: '票据无效或已过期, 请重新调用 send_file' });
  const user = MULTIUSER ? getUser(userId) : (userId === 'single' ? getUser('single') : undefined);
  if (!user?.feishu_open_id) return res.status(400).json({ error: '用户未绑定飞书' });
  const name = String(req.query.name || 'file').replace(/[/\\\0]/g, '_');
  const tmp = path.join(os.tmpdir(), `agent-remote-${crypto.randomUUID()}-${name}`);
  fs.writeFileSync(tmp, req.body as Buffer);
  deliverFile(tmp, user.feishu_open_id, name)
    .then(() => { fs.rm(tmp, () => {}); logEvent(user.id, 'file', { path: name, via: 'upload' }); res.json({ ok: true }); })
    .catch((e: unknown) => { fs.rm(tmp, () => {}); res.status(502).json({ error: `转发飞书失败: ${errStr(e)}` }); });
});

// Claude Code hook; Stop 且已绑飞书 -> 推送本轮结果并等待手机回复 (无回复放行结束, 回复作为反馈让 Claude 继续)
// PermissionRequest 且已绑飞书 -> 权限确认推手机, 点按钮远程 allow/deny/切 auto (无回复不决策, 回落终端确认)
// 等待以客户端连接为准: 不设固定超时, Claude Code hook timeout 掐断连接时 close 兜底放行
app.post('/claude', tokenAuth, async (req: Request & { user: User; clientName?: string }, res: Response) => {
  const h = req.body as ClaudeHook;
  const dir = h.cwd ? String(h.cwd).replace(/\/+$/, '').split('/').pop() : '';
  // 网页关掉的事件直接放行/忽略: Stop=放行结束, PermissionRequest=不决策回落终端, 其余不推卡
  if (getNotifyOff(req.user.id).includes(notifyKeyOf(h))) return res.json({ ok: true });
  // 客户端等待时限 (hook 命令把插件配置的 timeout_seconds 放进 X-Timeout-Seconds): 卡片展示 + 服务端兜底定时器
  const n = Number(req.headers['x-timeout-seconds']);
  const timeoutSec = Number.isFinite(n) && n > 0 ? n : 0;
  if (h.hook_event_name === 'PermissionRequest' && req.user.feishu_open_id) {
    const question = `${h.tool_name} 权限请求: ${JSON.stringify(h.tool_input).slice(0, 500)}`;
    let resolveFn!: (a: string | null | undefined) => void;
    const answerPromise = new Promise<string | null>((r) => { resolveFn = r; });
    const id = createPending({ resolve: resolveFn, userId: req.user.id, options: PERM_OPTIONS, question, timeoutMinutes: timeoutSec / 60 || 24 * 60 }); // 未传时限才用兜底上限
    logEvent(req.user.id, 'hook', { event: 'PermissionRequest', project: dir, tool: h.tool_name });
    res.on('close', () => resolvePending(id, undefined)); // 客户端超时/断开: 不决策, 回落终端确认
    try {
      const messageId = await sendCard(permissionCard({ id, toolName: h.tool_name, toolInput: h.tool_input, dir, timeoutSec }), req.user.feishu_open_id);
      setMessageId(id, messageId);
      const answer = await answerPromise;
      if (answer == null) { // 超时/断连收尾只在服务端做; 引用回复路径 WS handler 已翻卡+记事件
        updateCard(messageId!, resolvedCard(question, null, true)).catch(() => {});
        logEvent(req.user.id, 'timeout', { question });
      }
      return res.json(permissionHookResponse(answer));
    } catch (e) {
      console.error('[hook] send failed:', errStr(e));
      resolvePending(id, undefined);
      return res.json({ ok: true });
    }
  }
  if (h.hook_event_name === 'Stop' && req.user.feishu_open_id) {
    const question = `Claude 本轮结果:\n${String(h.last_assistant_message || '').slice(0, 2000)}`;
    let resolveFn!: (a: string | null | undefined) => void;
    const answerPromise = new Promise<string | null>((r) => { resolveFn = r; });
    const id = createPending({ resolve: resolveFn, userId: req.user.id, options: null, question, source: 'Stop hook', timeoutMinutes: timeoutSec / 60 || 24 * 60 }); // 未传时限才用兜底上限
    logEvent(req.user.id, 'hook', { event: 'Stop', project: dir });
    res.on('close', () => resolvePending(id, undefined)); // 客户端超时/断开: 放行并清理 pending
    try {
      const messageId = await sendCard(stopCard({ id, summary: question, dir, timeoutSec }), req.user.feishu_open_id);
      setMessageId(id, messageId);
      const answer = await answerPromise;
      if (answer == null) { // 超时/断连收尾只在服务端做; 引用回复路径 WS handler 已翻卡+记事件
        updateCard(messageId!, resolvedCard(question, null, true, 'Stop hook')).catch(() => {});
        logEvent(req.user.id, 'timeout', { question: 'Stop hook 续跑' });
      }
      return res.json(stopHookResponse(answer));
    } catch (e) {
      console.error('[hook] send failed:', errStr(e));
      resolvePending(id, undefined);
      return res.json({ ok: true });
    }
  }
  const card = hookCard(h);
  if (card) {
    if (req.user.feishu_open_id) await sendCard(card, req.user.feishu_open_id).catch((e: unknown) => console.error('[hook] send failed:', errStr(e)));
    // 只存摘要: Stop/SessionEnd 没有 message 字段, 原样存 UI 没东西可显示
    logEvent(req.user.id, 'hook', { event: h.hook_event_name, message: h.message || '', project: dir });
  }
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`mcp on :${PORT}/mcp (multiuser=${MULTIUSER})`));
