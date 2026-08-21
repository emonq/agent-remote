// agent-remote: 多用户 MCP 中心服务 — agent 阻塞式问用户, 飞书收发, OIDC 登录
// MCP: Streamable HTTP + 每用户 token;  飞书: 官方 SDK WS 长连接(免公网回调)
import express from 'express';
import crypto from 'node:crypto';
import * as Lark from '@larksuiteoapi/node-sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { pending, resolvePending, createPending, setMessageId, pendingForUser, matchFreeText, questionCard, resolvedCard, hookCard, stopCard, stopHookResponse, STOP_DONE, permissionCard, permissionHookResponse, PERM_OPTIONS, mkCard, issueBindCode, takeBindCode } from './core.mjs';
import { upsertUser, getUserByToken, getUser, getUserByOpenId, rotateToken, bindFeishu, unbindFeishu, logEvent, listEvents } from './db.mjs';
import { oidcConfigured, loginUrl, handleCallback, signSession, verifySession, bumpSessionVersion } from './auth.mjs';

const {
  MCP_TOKEN,            // 未配 SSO 时的单用户 token (兼容旧部署)
  FEISHU_APP_ID,
  FEISHU_APP_SECRET,
  PORT = 3000,
} = process.env;

if (!FEISHU_APP_ID || !FEISHU_APP_SECRET) { console.error('missing env FEISHU_APP_ID/FEISHU_APP_SECRET'); process.exit(1); }
if (!MCP_TOKEN && !oidcConfigured()) { console.error('missing env: 需要 MCP_TOKEN(单用户) 或完整 OIDC_* 配置(多用户)'); process.exit(1); }
const MULTIUSER = oidcConfigured();

// ---------- 飞书 ----------
const domain = process.env.FEISHU_DOMAIN === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu;
const lark = new Lark.Client({ appId: FEISHU_APP_ID, appSecret: FEISHU_APP_SECRET, domain });

async function sendCard(card, openId) {
  const res = await lark.im.v1.message.create({
    params: { receive_id_type: 'open_id' },
    data: { receive_id: openId, msg_type: 'interactive', content: JSON.stringify(card) },
  });
  return res.data?.message_id;
}

function updateCard(messageId, card) {
  return lark.im.v1.message.patch({ path: { message_id: messageId }, data: { content: JSON.stringify(card) } });
}

// ---------- 飞书事件 (WSClient 长连接, 免公网) ----------
const ws = new Lark.WSClient({
  appId: FEISHU_APP_ID, appSecret: FEISHU_APP_SECRET, domain,
  onError: (e) => console.error('[feishu ws]', e?.code ?? e?.msg ?? e),
});
await ws.start({
  eventDispatcher: new Lark.EventDispatcher({}).register({
    'card.action.trigger': async (data) => {
      const { value } = data.action ?? {};
      if (!value?.d) return {};
      const p = pending.get(value.d);
      if (!p || !resolvePending(value.d, value.a)) return {};
      updateCard(p.messageId, resolvedCard(p.question, value.a, false, p.source)).catch(() => {});
      logEvent(p.userId, 'solved', { via: 'button', answer: value.a, question: p.question });
      return { toast: { type: 'success', content: '已回复 agent' } };
    },
    'im.message.receive_v1': async (data) => {
      console.log('[debug] msg event:', JSON.stringify(data).slice(0, 400));
      const msg = data.message;
      if (!msg || msg.chat_type !== 'p2p') return;
      const text = msg.message_type === 'text' ? JSON.parse(msg.content)?.text?.trim() : '';
      if (!text) return;
      const openId = data.sender?.sender_id?.open_id;

      // /bind 绑定码
      const bindMatch = text.match(/^\/bind\s+(\d{6})$/);
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

      // 按发信人路由: open_id → user
      const user = MULTIUSER ? getUserByOpenId(openId) : null;
      const hit = user && matchFreeText({ userId: user.id, parentId: msg.parent_id, text });
      if (hit) {
        updateCard(hit.p.messageId, resolvedCard(hit.p.question, text, false, hit.p.source)).catch(() => {});
        logEvent(user.id, 'solved', { via: 'text', answer: text, question: hit.p.question });
      } else if (user && pendingForUser(user.id).length) {
        sendCard(mkCard('red', '⚠️ 没有匹配到待回复的问题', [{ tag: 'markdown', content: `你发了: ${text}\n\n当前有 ${pendingForUser(user.id).length} 个待回复问题。请**长按引用**对应的消息再回复。` }]), openId).catch(() => {});
      }
    },
  }),
});
console.log('feishu ws connected');

// ---------- MCP ----------
// 每请求新建 (stateless): user/clientName 走闭包, MCP SDK handler 拿不到请求上下文
function newMcpServer(user, clientName = '') {
  const mcp = new McpServer({ name: 'agent-remote', version: '0.2.0' });
  mcp.tool(
    'ask_user',
    '需要用户决策时【优先】使用本工具, 而不是在对话中等待用户输入。发送问题到用户手机(飞书), 阻塞等待用户回复, 回复内容直接作为工具结果返回, 期间可继续做其他工作。options 提供候选项时用户可一键点选; 不提供则等待自由文本(用户需引用该消息回复)。超时返回 {"timeout": true}, 由 agent 自行决定默认行为。',
    {
      question: z.string().describe('要问的问题, 写清楚上下文和推荐选项'),
      options: z.array(z.string()).max(6).optional().describe('候选项, 建议不超过 4 个; 开放性问题(需要用户输入文字)不要传此参数'),
      timeout_minutes: z.number().int().min(1).max(120).default(10).describe('等待用户回复的超时分钟数'),
    },
    async ({ question, options, timeout_minutes }) => {
      if (!user.feishu_open_id) return { content: [{ type: 'text', text: `用户 ${user.name} 尚未绑定飞书 (网页生成绑定码后在飞书发 /bind)` }], isError: true };
      let resolveFn;
      const answerPromise = new Promise((r) => { resolveFn = r; });
      const id = createPending({ resolve: resolveFn, userId: user.id, options, question, source: clientName, timeoutMinutes: timeout_minutes });
      logEvent(user.id, 'ask', { question, options, source: clientName });
      let messageId;
      try {
        messageId = await sendCard(questionCard({ id, question, options, timeoutMin: timeout_minutes, source: clientName }), user.feishu_open_id);
        setMessageId(id, messageId);
      } catch (e) {
        resolvePending(id, undefined);
        return { content: [{ type: 'text', text: `发送到飞书失败: ${e.message}` }], isError: true };
      }
      const answer = await answerPromise;
      if (answer === null) {
        updateCard(messageId, resolvedCard(question, null, true, clientName)).catch(() => {});
        logEvent(user.id, 'timeout', { question });
        return { content: [{ type: 'text', text: JSON.stringify({ timeout: true }) }] };
      }
      updateCard(messageId, resolvedCard(question, answer, false, clientName)).catch(() => {});
      return { content: [{ type: 'text', text: JSON.stringify({ answer }) }] };
    },
  );
  return mcp;
}

// ---------- HTTP ----------
const app = express();
app.use(express.json());

// token 认证: 多用户查 DB, 单用户回退 MCP_TOKEN + FEISHU_USER_OPEN_ID
function tokenAuth(req, res, next) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  const user = MULTIUSER ? getUserByToken(token) : (token === MCP_TOKEN ? { id: 'single', name: 'default', feishu_open_id: process.env.FEISHU_USER_OPEN_ID } : null);
  if (!user) return res.status(401).end();
  req.user = user;
  req.clientName = String(req.headers['x-client-name'] ?? '').trim().slice(0, 20);
  next();
}

// session 认证 (网页用)
function sessionAuth(req, res, next) {
  const cookie = req.headers.cookie?.match(/session=([^;]+)/)?.[1];
  const userId = verifySession(cookie);
  req.user = userId && getUser(userId);
  next();
}

app.get('/healthz', (_q, s) => s.send('ok'));
app.get('/', sessionAuth, (_q, s) => s.sendFile('index.html', { root: 'public' }));

// OIDC
const states = new Map(); // state -> expires (CSRF)
app.get('/auth/login', async (req, res) => {
  const state = crypto.randomBytes(16).toString('base64url');
  states.set(state, Date.now() + 600_000);
  res.redirect(await loginUrl(state));
});
app.get('/auth/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !states.get(state)) return res.status(400).send('bad state');
  states.delete(state);
  try {
    const { sub, name } = await handleCallback(code);
    const userId = upsertUser(sub, name);
    res.setHeader('set-cookie', `session=${signSession(userId)}; Path=/; HttpOnly; Max-Age=2592000; SameSite=Lax`);
    res.redirect('/');
  } catch (e) {
    res.status(500).send(`login failed: ${e.message}`);
  }
});

// 注销: 清 cookie + 使该用户所有 session 失效
app.post('/auth/logout', sessionAuth, (req, res) => {
  if (req.user) bumpSessionVersion(req.user.id);
  res.setHeader('set-cookie', 'session=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax');
  res.json({ ok: true });
});

// 网页 API
app.get('/api/me', sessionAuth, (req, res) => {
  if (!req.user) {
    if (!MULTIUSER) {
      // 单用户模式: 网页只读展示, 无登录/token 管理
      return res.json({ single: true, name: 'default', multiuser: false, events: [] });
    }
    return res.status(401).json({ login: '/auth/login' });
  }
  res.json({ name: req.user.name, bound: Boolean(req.user.feishu_open_id), multiuser: MULTIUSER, events: listEvents(req.user.id, 30) });
});
app.post('/api/rotate-token', sessionAuth, async (req, res) => {
  if (!req.user) return res.status(401).end();
  const token = rotateToken(req.user.id);
  logEvent(req.user.id, 'token_rotated', {});
  res.json({ token });
});
app.post('/api/bind-code', sessionAuth, (req, res) => {
  if (!req.user) return res.status(401).end();
  res.json({ code: issueBindCode(req.user.id) });
});
app.post('/api/unbind', sessionAuth, (req, res) => {
  if (!req.user) return res.status(401).end();
  unbindFeishu(req.user.id);
  logEvent(req.user.id, 'unbind', {});
  res.json({ ok: true });
});
app.get('/api/token', sessionAuth, (req, res) => {
  if (!req.user) return res.status(401).end();
  res.json({ token: req.user.token });
});

// MCP endpoint
app.all('/mcp', tokenAuth, async (req, res) => {
  try {
    const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await newMcpServer(req.user, req.clientName).connect(t);
    await t.handleRequest(req, res, req.body);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Claude Code hook; Stop 且已绑飞书 -> 推送本轮结果并等待手机回复 (无回复放行结束, 回复作为反馈让 Claude 继续)
// PermissionRequest 且已绑飞书 -> 权限确认推手机, 点按钮远程 allow/deny/切 auto (无回复不决策, 回落终端确认)
// 等待以客户端连接为准: 不设固定超时, Claude Code hook timeout 掐断连接时 close 兜底放行
app.post('/claude', tokenAuth, async (req, res) => {
  const h = req.body;
  const dir = h.cwd ? String(h.cwd).replace(/\/+$/, '').split('/').pop() : '';
  if (h.hook_event_name === 'PermissionRequest' && req.user.feishu_open_id) {
    const question = `${h.tool_name} 权限请求: ${JSON.stringify(h.tool_input).slice(0, 500)}`;
    let resolveFn;
    const answerPromise = new Promise((r) => { resolveFn = r; });
    const id = createPending({ resolve: resolveFn, userId: req.user.id, options: PERM_OPTIONS, question, timeoutMinutes: 24 * 60 }); // 兜底上限, 实际由连接断开决定
    logEvent(req.user.id, 'hook', { event: 'PermissionRequest', project: dir, tool: h.tool_name });
    res.on('close', () => resolvePending(id, undefined)); // 客户端超时/断开: 不决策, 回落终端确认
    try {
      const messageId = await sendCard(permissionCard({ id, toolName: h.tool_name, toolInput: h.tool_input, dir }), req.user.feishu_open_id);
      setMessageId(id, messageId);
      const answer = await answerPromise;
      if (answer == null) { // 超时/断连收尾只在服务端做; 引用回复路径 WS handler 已翻卡+记事件
        updateCard(messageId, resolvedCard(question, null, true)).catch(() => {});
        logEvent(req.user.id, 'timeout', { question });
      }
      return res.json(permissionHookResponse(answer));
    } catch (e) {
      console.error('[hook] send failed:', e?.code ?? e?.msg ?? e);
      resolvePending(id, undefined);
      return res.json({ ok: true });
    }
  }
  if (h.hook_event_name === 'Stop' && req.user.feishu_open_id) {
    const question = `Claude 本轮结果:\n${String(h.last_assistant_message || '').slice(0, 2000)}`;
    let resolveFn;
    const answerPromise = new Promise((r) => { resolveFn = r; });
    const id = createPending({ resolve: resolveFn, userId: req.user.id, options: null, question, source: 'Stop hook', timeoutMinutes: 24 * 60 }); // 兜底上限, 实际由连接断开决定
    logEvent(req.user.id, 'hook', { event: 'Stop', project: dir });
    res.on('close', () => resolvePending(id, undefined)); // 客户端超时/断开: 放行并清理 pending
    try {
      const messageId = await sendCard(stopCard({ id, summary: question, dir }), req.user.feishu_open_id);
      setMessageId(id, messageId);
      const answer = await answerPromise;
      if (answer == null) { // 超时/断连收尾只在服务端做; 引用回复路径 WS handler 已翻卡+记事件
        updateCard(messageId, resolvedCard(question, null, true, 'Stop hook')).catch(() => {});
        logEvent(req.user.id, 'timeout', { question: 'Stop hook 续跑' });
      }
      return res.json(stopHookResponse(answer));
    } catch (e) {
      console.error('[hook] send failed:', e?.code ?? e?.msg ?? e);
      resolvePending(id, undefined);
      return res.json({ ok: true });
    }
  }
  const card = hookCard(h);
  if (card) {
    if (req.user.feishu_open_id) await sendCard(card, req.user.feishu_open_id).catch((e) => console.error('[hook] send failed:', e?.code ?? e?.msg ?? e));
    // 只存摘要: Stop/SessionEnd 没有 message 字段, 原样存 UI 没东西可显示
    logEvent(req.user.id, 'hook', { event: h.hook_event_name, message: h.message || '', project: dir });
  }
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`mcp on :${PORT}/mcp (multiuser=${MULTIUSER})`));
