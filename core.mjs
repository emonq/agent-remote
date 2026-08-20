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
export function createPending({ resolve, options, question, timeoutMinutes, onTimeout }) {
  const id = crypto.randomUUID();
  const timer = setTimeout(() => {
    pending.delete(id);
    onTimeout?.();
    resolve(null); // null = 超时
  }, timeoutMinutes * 60_000);
  pending.set(id, { resolve, messageId: null, options, question, timer });
  return id;
}

export function setMessageId(id, messageId) {
  const p = pending.get(id);
  if (p) p.messageId = messageId;
}

// 自由文本匹配: 引用回复(parent_id)精确匹配优先, 否则 LIFO 兜底取最近一条无选项 pending
export function matchFreeText({ parentId, text }) {
  if (parentId) {
    for (const [id, p] of pending) {
      if (p.messageId === parentId && resolvePending(id, text)) return { id, p };
    }
  }
  // ponytail: 单用户 LIFO; 多并发自由文本场景改为强制引用回复
  const open = [...pending.entries()].filter(([, p]) => !p.options?.length);
  if (open.length) {
    const [id, p] = open[open.length - 1];
    if (resolvePending(id, text)) return { id, p };
  }
  return null;
}

export function questionCard({ id, question, options, timeoutMin }) {
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
    elements.push({ tag: 'markdown', content: '*直接回复本条消息输入你的答案*' });
  }
  return {
    config: { wide_screen_mode: true },
    header: { template: 'orange', title: { tag: 'plain_text', content: '🤖 Agent 需要你的决策' } },
    elements: [...elements, { tag: 'note', elements: [{ tag: 'plain_text', content: `超时: ${timeoutMin} 分钟 | #${id.slice(0, 6)}` }] }],
  };
}

export function resolvedCard(question, answer, timedOut) {
  return {
    config: { wide_screen_mode: true },
    header: { template: timedOut ? 'grey' : 'green', title: { tag: 'plain_text', content: timedOut ? '⏰ 已超时' : '✅ 已回复' } },
    elements: [
      { tag: 'markdown', content: question },
      { tag: 'hr' },
      { tag: 'markdown', content: answer ? `**你的回答:** ${answer}` : '_未回复，已超时_' },
    ],
  };
}
