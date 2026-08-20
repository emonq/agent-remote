// 纯逻辑: pending 决策管理 + 卡片构造 (无副作用, 供 server 和 test 导入)
import crypto from 'node:crypto';

export const pending = new Map(); // decisionId -> { resolve, messageId, options, question, timer }

export function resolvePending(id, answer) {
  const p = pending.get(id);
  if (!p) return false;
  clearTimeout(p.timer);
  pending.delete(id);
  p.resolve(answer);
  return true;
}

// id 需先于卡片发送生成(按钮 value 要带), messageId 发送后才知道 — 所以两步注册
export function createPending({ resolve, options, question, source, timeoutMinutes, onTimeout }) {
  const id = crypto.randomUUID();
  const timer = setTimeout(() => {
    pending.delete(id);
    onTimeout?.();
    resolve(null); // null = 超时
  }, timeoutMinutes * 60_000);
  pending.set(id, { resolve, messageId: null, options, question, source, timer });
  return id;
}

export function setMessageId(id, messageId) {
  const p = pending.get(id);
  if (p) p.messageId = messageId;
}

// 自由文本匹配:
// 1. 引用回复(parent_id) 精确匹配
// 2. 仅一条无选项 pending 时直接匹配; 多条并行时不猜 (猜错会送到错误的 agent 会话)
export function matchFreeText({ parentId, text }) {
  if (parentId) {
    for (const [id, p] of pending) {
      if (p.messageId === parentId && resolvePending(id, text)) return { id, p };
    }
  }
  const open = [...pending.entries()].filter(([, p]) => !p.options?.length);
  if (open.length === 1) {
    const [id, p] = open[0];
    if (resolvePending(id, text)) return { id, p };
  }
  return null;
}

export function questionCard({ id, question, options, timeoutMin, source }) {
  const elements = [{ tag: 'markdown', content: question }, { tag: 'hr' }];
  if (options?.length) {
    elements.push({
      tag: 'action',
      actions: options.map((label, i) => ({
        tag: 'button',
        text: { tag: 'plain_text', content: label },
        type: i === 0 ? 'primary' : 'default',
        value: { d: id, a: label },
      })),
    });
  } else {
    elements.push({ tag: 'markdown', content: '*长按引用本条消息回复你的答案*' });
  }
  const title = `🤖 ${source ? `${source} 需要你的决策` : 'Agent 需要你的决策'}`;
  return {
    config: { wide_screen_mode: true },
    header: { template: 'orange', title: { tag: 'plain_text', content: title } },
    elements,
  };
}

export function resolvedCard(question, answer, timedOut, source) {
  const title = timedOut ? '⏰ 已超时' : '✅ 已回复';
  return {
    config: { wide_screen_mode: true },
    header: { template: timedOut ? 'grey' : 'green', title: { tag: 'plain_text', content: source ? `${title} · ${source}` : title } },
    elements: [
      { tag: 'markdown', content: question },
      { tag: 'hr' },
      { tag: 'markdown', content: answer ? `**你的回答:** ${answer}` : '_未回复，已超时_' },
    ],
  };
}

// Claude Code hook 事件 → 通知卡片; 不在表里的事件返回 null (忽略, 免得每个工具调用都刷屏)
export function hookCard(hook = {}) {
  const dir = hook.cwd ? hook.cwd.replace(/\/+$/, '').split('/').pop() : '';
  const where = dir ? ` · ${dir}` : '';
  const m = {
    Stop: { icon: '✅', title: '任务完成', body: 'Claude 已完成当前工作，可以回来查看了' },
    Notification: { icon: '🔔', title: '需要你注意', body: hook.message || 'Claude 在等待输入或确认' },
    SessionEnd: { icon: '👋', title: '会话结束', body: `会话已结束 (${hook.reason || 'exit'})` },
  }[hook.hook_event_name];
  if (!m) return null;
  return {
    config: { wide_screen_mode: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: `${m.icon} ${m.title}${where}` } },
    elements: [{ tag: 'markdown', content: m.body }],
  };
}
