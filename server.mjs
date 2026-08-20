// agent-remote: MCP 中心服务 — agent 阻塞式问用户，飞书收发
// MCP: Streamable HTTP + Bearer token;  飞书: 官方 SDK WebSocket 长连接(免公网回调)
import express from 'express';
import * as Lark from '@larksuiteoapi/node-sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { pending, resolvePending, createPending, setMessageId, matchFreeText, questionCard, resolvedCard, hookCard } from './core.mjs';

const {
  MCP_TOKEN,            // MCP Bearer token (自定义); 多客户端跟踪用 CLIENT_TOKENS: "名字1:token1,名字2:token2"
  CLIENT_TOKENS,
  FEISHU_APP_ID,
  FEISHU_APP_SECRET,
  FEISHU_USER_OPEN_ID,  // 接收决策消息的用户 (open_id, ou_ 开头)
  PORT = 3000,
} = process.env;

if (!FEISHU_APP_ID || !FEISHU_APP_SECRET || !FEISHU_USER_OPEN_ID || !(MCP_TOKEN || CLIENT_TOKENS)) {
  console.error('missing env: 需要 FEISHU_APP_ID/FEISHU_APP_SECRET/FEISHU_USER_OPEN_ID 和 MCP_TOKEN(或 CLIENT_TOKENS)');
  process.exit(1);
}

// token -> 客户端名; CLIENT_TOKENS 的条目带名字, 裸 MCP_TOKEN 是默认客户端 (卡片不显示来源)
const tokenClients = new Map();
if (CLIENT_TOKENS) for (const pair of CLIENT_TOKENS.split(',')) {
  const [name, token] = pair.split(':').map((s) => s?.trim());
  if (name && token) tokenClients.set(token, name);
}
if (MCP_TOKEN && !tokenClients.has(MCP_TOKEN)) tokenClients.set(MCP_TOKEN, '');

// 认证中间件: 校验 Bearer, 挂上客户端名
function authClient(req, res, next) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  const name = tokenClients.get(token);
  if (name === undefined) return res.status(401).end();
  req.clientName = name;
  next();
}

// ---------- 飞书 ----------
// FEISHU_DOMAIN=lark 时连 open.larksuite.com (国际版), 默认 feishu (国内版)
const domain = process.env.FEISHU_DOMAIN === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu;
const lark = new Lark.Client({ appId: FEISHU_APP_ID, appSecret: FEISHU_APP_SECRET, domain });

async function sendCard(card) {
  const res = await lark.im.v1.message.create({
    params: { receive_id_type: 'open_id' },
    data: { receive_id: FEISHU_USER_OPEN_ID, msg_type: 'interactive', content: JSON.stringify(card) },
  });
  return res.data?.message_id;
}

function updateCard(messageId, card) {
  return lark.im.v1.message.patch({
    path: { message_id: messageId },
    data: { content: JSON.stringify(card) },
  });
}

// ---------- 飞书事件 (WSClient 长连接, 免公网) ----------
const ws = new Lark.WSClient({
  appId: FEISHU_APP_ID, appSecret: FEISHU_APP_SECRET, domain,
  onError: (e) => console.error('[feishu ws]', e?.code ?? e?.msg ?? e),
});
await ws.start({
  eventDispatcher: new Lark.EventDispatcher({}).register({
    // 卡片按钮点击
    'card.action.trigger': async (data) => {
      const { value } = data.action ?? {};
      if (!value?.d) return {};
      const p = pending.get(value.d);
      if (!p || !resolvePending(value.d, value.a)) return {};
      updateCard(p.messageId, resolvedCard(p.question, value.a, false, p.source)).catch(() => {});
      return { toast: { type: 'success', content: '已回复 agent' } };
    },
    // 自由文本回复
    'im.message.receive_v1': async (data) => {
      const msg = data.message;
      if (!msg || msg.chat_type !== 'p2p') return;
      const text = msg.message_type === 'text' ? JSON.parse(msg.content)?.text?.trim() : '';
      if (!text) return;
      const hit = matchFreeText({ parentId: msg.parent_id, text });
      if (hit) {
        updateCard(hit.p.messageId, resolvedCard(hit.p.question, text, false, hit.p.source)).catch(() => {});
      } else if (pending.size) {
        // 没匹配上但确实有待回复的问题 — 提示用户, 否则 agent 干等
        await sendCard({
          config: { wide_screen_mode: true },
          header: { template: 'red', title: { tag: 'plain_text', content: '⚠️ 没有匹配到待回复的问题' } },
          elements: [{ tag: 'markdown', content: `你发了: ${text}\n\n当前有 ${pending.size} 个待回复问题。请**引用**对应消息回复, 或带上消息里的 \`#tag\` 前缀重发。` }],
        }).catch(() => {});
      }
    },
  }),
});
console.log('feishu ws connected');

// ---------- MCP ----------
// ponytail: stateless 模式每次请求新建 McpServer+transport(SDK 不允许实例复用); 要会话保持再改有状态模式
function newMcpServer(clientName = '') {
  const mcp = new McpServer({ name: 'agent-remote', version: '0.1.0' });
  mcp.tool(
    'ask_user',
    '需要用户决策时【优先】使用本工具, 而不是在对话中等待用户输入。发送问题到用户手机(飞书), 阻塞等待用户回复, 回复内容直接作为工具结果返回, 期间可继续做其他工作。options 提供候选项时用户可一键点选; 不提供则等待自由文本(回复时带上消息里的 #tag, 或引用该消息回复)。超时返回 {"timeout": true}, 由 agent 自行决定默认行为。',
    {
      question: z.string().describe('要问的问题, 写清楚上下文和推荐选项'),
      options: z.array(z.string()).max(6).optional().describe('候选项, 建议不超过 4 个; 开放性问题(需要用户输入文字)不要传此参数'),
      timeout_minutes: z.number().int().min(1).max(120).default(10).describe('等待用户回复的超时分钟数'),
    },
    async ({ question, options, timeout_minutes }) => {
      let resolveFn;
      const answerPromise = new Promise((r) => { resolveFn = r; });
      const id = createPending({ resolve: resolveFn, options, question, source: clientName, timeoutMinutes: timeout_minutes });
      let messageId;
      try {
        messageId = await sendCard(questionCard({ id, question, options, timeoutMin: timeout_minutes, source: clientName }));
        setMessageId(id, messageId);
      } catch (e) {
        resolvePending(id, undefined); // 发送失败, 清理 pending
        return { content: [{ type: 'text', text: `发送到飞书失败: ${e.message}` }], isError: true };
      }
      const answer = await answerPromise;
      if (answer === null) {
        updateCard(messageId, resolvedCard(question, null, true, clientName)).catch(() => {});
        return { content: [{ type: 'text', text: JSON.stringify({ timeout: true }) }] };
      }
      updateCard(messageId, resolvedCard(question, answer, false, clientName)).catch(() => {});
      return { content: [{ type: 'text', text: JSON.stringify({ answer }) }] };
    },
  );
  return mcp;
}

// HTTP: MCP endpoint + 健康检查
const app = express();
app.use(express.json());
app.get('/healthz', (_q, s) => s.send('ok'));

app.all('/mcp', authClient, async (req, res) => {
  try {
    const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await newMcpServer(req.clientName).connect(t);
    await t.handleRequest(req, res, req.body);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Claude Code hook 接收端: settings.json 里配 webhook 类 hook, POST 到这里
app.post('/claude', authClient, async (req, res) => {
  const card = hookCard(req.body);
  if (card) await sendCard(card).catch((e) => console.error('[hook] send failed:', e?.code ?? e?.msg ?? e));
  res.json({ ok: true }); // hook 不需要返回值, 2xx 即可
});

app.listen(PORT, () => console.log(`mcp on :${PORT}/mcp`));
