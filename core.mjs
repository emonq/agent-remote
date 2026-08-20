// 纯逻辑: pending 决策管理 + 卡片构造 (无副作用, 供 server 和 test 导入)
import crypto from 'node:crypto';

// decisionId -> { resolve, userId, messageId, options, question, source, timer }
export const pending = new Map();

export function resolvePending(id, answer) {
  const p = pending.get(id);
  if (!p) return false;
  clearTimeout(p.timer);
  pending.delete(id);
  p.resolve(answer);
  return true;
}

// id 需先于卡片发送生成(按钮 value 要带), messageId 发送后才知道 — 所以两步注册
export function createPending({ resolve, userId, options, question, source, timeoutMinutes, onTimeout }) {
  const id = crypto.randomUUID();
  const timer = setTimeout(() => {
    pending.delete(id);
    onTimeout?.();
    resolve(null); // null = 超时
  }, timeoutMinutes * 60_000);
  pending.set(id, { resolve, userId, messageId: null, options, question, source, timer });
  return id;
}

export function setMessageId(id, messageId) {
  const p = pending.get(id);
  if (p) p.messageId = messageId;
}

export const pendingForUser = (userId) => [...pending.values()].filter((p) => p.userId === userId);

// 自由文本匹配:
// 1. 引用回复(parent_id) 精确匹配 (跨用户也按 messageId 唯一定位, 无越权: 卡片只发到本人私聊)
// 2. 该用户仅一条无选项 pending 时直接匹配; 多条并行时不猜 (猜错会送到错误的 agent 会话)
export function matchFreeText({ userId, parentId, text }) {
  if (parentId) {
    for (const [id, p] of pending) {
      if (p.messageId === parentId && resolvePending(id, text)) return { id, p };
    }
  }
  const open = pendingForUser(userId).filter((p) => !p.options?.length);
  if (open.length === 1) {
    const id = [...pending.entries()].find(([, v]) => v === open[0])?.[0];
    if (id && resolvePending(id, text)) return { id, p: open[0] };
  }
  return null;
}

// CardKit 2.0 卡片骨架: 行内代码等 markdown 扩展只在 2.0 结构支持; 1.0 已全线弃用
export const mkCard = (template, title, elements) => ({
  schema: '2.0',
  header: { template, title: { tag: 'plain_text', content: title } },
  body: { elements },
});

// 2.0 按钮走 behaviors.callback, 回调事件里仍是 data.action.value
export const mkBtn = (label, value, primary = false) => ({
  tag: 'button',
  text: { tag: 'plain_text', content: label },
  type: primary ? 'primary' : 'default',
  behaviors: [{ type: 'callback', value }],
});

export function questionCard({ id, question, options, timeoutMin, source }) {
  const elements = [{ tag: 'markdown', content: question }, { tag: 'hr' }];
  if (options?.length) {
    elements.push({ tag: 'action', actions: options.map((label, i) => mkBtn(label, { d: id, a: label }, i === 0)) });
  } else {
    elements.push({ tag: 'markdown', content: '*长按引用本条消息回复你的答案*' });
  }
  const title = `🤖 ${source ? `${source} 需要你的决策` : 'Agent 需要你的决策'}`;
  return mkCard('orange', title, elements);
}

export function resolvedCard(question, answer, timedOut, source) {
  const title = timedOut ? '⏰ 已超时' : '✅ 已回复';
  return mkCard(timedOut ? 'grey' : 'green', source ? `${title} · ${source}` : title, [
    { tag: 'markdown', content: question },
    { tag: 'hr' },
    { tag: 'markdown', content: answer ? `**你的回答:** ${answer}` : '_未回复，已超时_' },
  ]);
}

// Claude Code hook 事件 → 通知卡片; 不在表里的事件返回 null (忽略, 免得每个工具调用都刷屏)
export function hookCard(hook = {}) {
  const dir = hook.cwd ? hook.cwd.replace(/\/+$/, '').split('/').pop() : '';
  const where = dir ? ` · ${dir}` : '';
  const m = {
    Stop: { icon: '✅', title: '任务完成', color: 'green', body: 'Claude 已完成当前工作，可以回来查看了' },
    Notification: { icon: '🔔', title: '需要你注意', color: 'orange', body: hook.message || 'Claude 在等待输入或确认' },
    SessionEnd: { icon: '👋', title: '会话结束', color: 'grey', body: `会话已结束 (${hook.reason || 'exit'})` },
  }[hook.hook_event_name];
  if (!m) return null;
  return mkCard(m.color, `${m.icon} ${m.title}${where}`, [{ tag: 'markdown', content: m.body }]);
}

// Stop hook 交互: Claude 本轮结果推手机, 引用回复可让 Claude 继续
export const STOP_DONE = '✅ 到此为止'; // 结束按钮的标签, 同时作为应答哨兵: 收到它 = 放行结束

export function stopCard({ id, summary, dir }) {
  const where = dir ? ` · ${dir}` : '';
  return mkCard('green', `✅ 任务完成${where}`, [
    { tag: 'markdown', content: summary },
    { tag: 'hr' },
    { tag: 'markdown', content: '**长按引用本条消息回复**可让 Claude 继续（例如：方案 B，继续实现）；等待超时自动结束' },
    { tag: 'action', actions: [mkBtn(STOP_DONE, { d: id, a: STOP_DONE })] },
  ]);
}

// Stop hook 应答: 有回复 -> additionalContext 让 Claude 继续; 无(超时/发送失败/点结束) -> 放行结束
export const stopHookResponse = (answer) => (answer == null || answer === STOP_DONE
  ? { ok: true }
  : { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: `用户回复：${answer}` } });

// 飞书绑定码: 6 位数字, 10 分钟有效, 内存即可 (重启丢的是未完成的绑定, 无害)
const bindCodes = new Map(); // code -> { userId, expires }
export function issueBindCode(userId) {
  // ponytail: 6 位数字空间小, 但单实例自用+10min 过期足够; 要抗爆破再加速率限制
  const code = crypto.randomInt(100000, 1000000).toString();
  bindCodes.set(code, { userId, expires: Date.now() + 600_000 });
  for (const [c, v] of bindCodes) if (v.expires < Date.now()) bindCodes.delete(c);
  return code;
}
export function takeBindCode(code) {
  const v = bindCodes.get(String(code).trim());
  if (!v || v.expires < Date.now()) return null;
  bindCodes.delete(code);
  return v.userId;
}
