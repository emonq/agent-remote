// 纯逻辑: pending 决策管理 + 卡片构造 (无副作用, 供 server 和 test 导入)
import crypto from 'node:crypto';

export interface AskUserOption {
  label: string;
  description?: string;
}

export interface AskUserPrompt {
  question: string;
  header?: string;
  options: AskUserOption[];
  multiSelect: boolean;
}

export interface AskUserPendingContext {
  prompt: AskUserPrompt;
  index: number;
  total: number;
  dir?: string;
  timeoutSec?: number;
  selected: string[];
}

export interface PendingItem {
  resolve: (answer: string | null | undefined) => void;
  userId: string;
  messageId: string | null;
  options: string[] | null;
  question: string;
  source?: string;
  askUser?: AskUserPendingContext;
  timer: NodeJS.Timeout | null; // null = 不限时
}

// decisionId -> pending
export const pending = new Map<string, PendingItem>();

export function resolvePending(id: string, answer: string | null | undefined): boolean {
  const p = pending.get(id);
  if (!p) return false;
  if (p.timer) clearTimeout(p.timer);
  pending.delete(id);
  p.resolve(answer);
  return true;
}

// id 需先于卡片发送生成(按钮 value 要带), messageId 发送后才知道 — 所以两步注册
// timeoutMinutes 缺省 = 不限时, 只能等显式 resolve
export function createPending({ resolve, userId, options, question, source, askUser, timeoutMinutes, onTimeout }: {
  resolve: (answer: string | null | undefined) => void;
  userId: string;
  options: string[] | null;
  question: string;
  source?: string;
  askUser?: Omit<AskUserPendingContext, 'selected'>;
  timeoutMinutes?: number;
  onTimeout?: () => void;
}): string {
  const id = crypto.randomUUID();
  const timer = timeoutMinutes === undefined ? null : setTimeout(() => {
    pending.delete(id);
    onTimeout?.();
    resolve(null); // null = 超时
  }, timeoutMinutes * 60_000);
  pending.set(id, {
    resolve, userId, messageId: null, options, question, source, timer,
    askUser: askUser ? { ...askUser, selected: [] } : undefined,
  });
  return id;
}

export function setMessageId(id: string, messageId: string | undefined): void {
  const p = pending.get(id);
  if (p) p.messageId = messageId ?? null;
}

export const pendingForUser = (userId: string): PendingItem[] =>
  [...pending.values()].filter((p) => p.userId === userId);

// 自由文本匹配:
// 1. 引用回复(parent_id) 精确匹配 (跨用户也按 messageId 唯一定位, 无越权: 卡片只发到本人私聊)
// 2. 该用户仅一条无选项 pending 时直接匹配; 多条并行时不猜 (猜错会送到错误的 agent 会话)
export function matchFreeText({ userId, parentId, text }: { userId: string; parentId?: string; text: string }): { id: string; p: PendingItem } | null {
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

// 外部文本(claude 输出/用户回复)流入 markdown 组件前过一遍:
// 2.0 会把 ![alt](url) 当图片解析, 而 url 不是飞书 image_key, 整卡直接 400 — 降级成普通链接
// alt 允许嵌套 [](Claude 常写 "[架构图]" 这类); url 允许配对括号 (wiki 风格路径)
export const md = (s?: string | null): string =>
  String(s ?? '').replace(/!\[((?:[^\][]|\[[^\]]*\])*)\]\((\([^()]*\)|[^())]+(?:\([^()]*\)[^())]*)*)\)/g, (_m: string, alt: string, url: string) => `[${alt || url}](${url})`);

// CardKit 2.0 卡片结构 (SDK 只类型化了 1.0 的 InteractiveCard; 2.0 schema 不同, 自建最小接口)
// 模板色复用 SDK 的 InteractiveCardHeaderTemplate 取值
export type CardTemplate = 'blue' | 'wathet' | 'turquoise' | 'green' | 'yellow' | 'orange' | 'red' | 'carmine' | 'violet' | 'purple' | 'indigo' | 'grey';

// 按钮回调携带: d=decisionId, a=answer; op 仅供 AskUserQuestion 多选切换/提交使用
export interface CardCallbackValue { d: string; a: string; op?: 'toggle' | 'submit' }

export type CardElement =
  | { tag: 'markdown'; content: string }
  | { tag: 'hr' }
  | { tag: 'button'; text: { tag: 'plain_text'; content: string }; type?: 'primary' | 'default'; behaviors: { type: 'callback'; value: CardCallbackValue }[] };

export interface CardV2 {
  schema: '2.0';
  header: { template: CardTemplate; title: { tag: 'plain_text'; content: string } };
  body: { elements: CardElement[] };
}

// Claude Code hook 事件载荷 (非飞书; Claude Code 侧定义, 这里只建模用到的字段)
export interface ClaudeHook {
  hook_event_name?: string;
  notification_type?: string;
  cwd?: string;
  message?: string;
  reason?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  last_assistant_message?: string;
}

// Codex hook 与 Claude Code 载荷大体同构，但 PermissionRequest 的 tool_input 是任意 JSON，
// Stop 还会带 stop_hook_active 防止续跑后再次触发同一条交互。
export interface CodexHook extends Omit<ClaudeHook, 'tool_input'> {
  session_id?: string;
  turn_id?: string;
  permission_mode?: string;
  stop_hook_active?: boolean;
  tool_input?: unknown;
}

type HookNotice = Pick<ClaudeHook, 'hook_event_name' | 'notification_type' | 'cwd' | 'message' | 'reason' | 'tool_name'>;

export type Card = CardV2;

export const mkCard = (template: CardTemplate, title: string, elements: CardElement[]): Card => ({
  schema: '2.0',
  header: { template, title: { tag: 'plain_text', content: title } },
  body: { elements },
});

// 2.0 按钮走 behaviors.callback, 回调事件里仍是 data.action.value
export const mkBtn = (label: string, value: CardCallbackValue, primary = false): CardElement => ({
  tag: 'button',
  text: { tag: 'plain_text', content: label },
  type: primary ? 'primary' : 'default',
  behaviors: [{ type: 'callback', value }],
});

// 秒 → 人话时长 (卡片上的等待时限提示)
export const fmtDur = (sec: number): string => (sec >= 60 ? `${Math.round(sec / 60)} 分钟` : `${sec} 秒`);

export function questionCard({ id, question, options, source, timeoutSec }: {
  id: string; question: string; options: string[] | null; source?: string; timeoutSec?: number;
}): Card {
  const elements: CardElement[] = [{ tag: 'markdown', content: md(question) }, { tag: 'hr' }];
  if (options?.length) {
    // 2.0 无 action 组件, 按钮直接作顶层 element (每按钮一行, 手机上更好点)
    elements.push(...options.map((label, i) => mkBtn(label, { d: id, a: label }, i === 0)));
  } else {
    elements.push({ tag: 'markdown', content: '*长按引用本条消息回复你的答案*' });
  }
  // 老客户端不带 timeoutSec 就不显示
  if (timeoutSec) elements.push({ tag: 'markdown', content: `⏳ ${fmtDur(timeoutSec)}内回复有效，超时由 agent 自行兜底` });
  const title = `🤖 ${source ? `${source} 需要你的决策` : 'Agent 需要你的决策'}`;
  return mkCard('orange', title, elements);
}

export const ASK_USER_SUBMIT = '✅ 提交选择';

// Claude Code AskUserQuestion 卡片: 显示完整问题与选项说明；多选先切换选项，再显式提交。
export function askUserQuestionCard({ id, prompt, index, total, dir, timeoutSec, selected = [] }: {
  id: string;
  prompt: AskUserPrompt;
  index: number;
  total: number;
  dir?: string;
  timeoutSec?: number;
  selected?: string[];
}): Card {
  const where = dir ? ` · ${dir}` : '';
  const progress = total > 1 ? ` · ${index + 1}/${total}` : '';
  const heading = prompt.header ? `**${md(prompt.header)}**\n` : '';
  const elements: CardElement[] = [
    { tag: 'markdown', content: `${heading}${md(prompt.question)}` },
    { tag: 'hr' },
  ];

  for (const option of prompt.options) {
    if (option.description) {
      elements.push({ tag: 'markdown', content: `**${md(option.label)}**\n${md(option.description)}` });
    }
    const checked = selected.includes(option.label);
    const label = prompt.multiSelect ? `${checked ? '☑' : '☐'} ${option.label}` : option.label;
    elements.push(mkBtn(label, {
      d: id,
      a: option.label,
      ...(prompt.multiSelect ? { op: 'toggle' as const } : {}),
    }, !prompt.multiSelect && option === prompt.options[0]));
  }

  if (prompt.multiSelect) {
    elements.push(
      { tag: 'hr' },
      { tag: 'markdown', content: selected.length
        ? `已选择：**${md(selected.join('、'))}**`
        : '这是多选题，请先选择一项或多项，再点提交。' },
      mkBtn(`${ASK_USER_SUBMIT}${selected.length ? ` (${selected.length})` : ''}`, { d: id, a: ASK_USER_SUBMIT, op: 'submit' }, selected.length > 0),
    );
  }

  elements.push({ tag: 'markdown', content: '*也可以长按引用本条消息，回复自定义答案*' });
  if (timeoutSec) elements.push({ tag: 'markdown', content: `⏳ ${fmtDur(timeoutSec)}内回复有效，超时回落到 Claude Code 终端` });
  return mkCard('orange', `❓ Claude 需要你回答${progress}${where}`, elements);
}

// 严格识别 Claude Code 的 AskUserQuestion 输入；格式异常时不远程作答，交回本地界面。
export function parseAskUserQuestions(toolInput: unknown): AskUserPrompt[] {
  if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) return [];
  const raw = (toolInput as Record<string, unknown>).questions;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 4) return [];

  const parsed: AskUserPrompt[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const q = item as Record<string, unknown>;
    if (typeof q.question !== 'string' || !q.question.trim() || !Array.isArray(q.options)) return [];
    const options: AskUserOption[] = [];
    for (const value of q.options) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
      const option = value as Record<string, unknown>;
      if (typeof option.label !== 'string' || !option.label.trim()) return [];
      if (option.description !== undefined && typeof option.description !== 'string') return [];
      const description = typeof option.description === 'string' && option.description ? option.description : undefined;
      options.push(description ? { label: option.label, description } : { label: option.label });
    }
    parsed.push({
      question: q.question,
      ...(typeof q.header === 'string' && q.header ? { header: q.header } : {}),
      options,
      multiSelect: q.multiSelect === true,
    });
  }
  return parsed;
}

// AskUserQuestion 的 answers 必须通过 updatedInput 回填；兼容当前 PermissionRequest 路径，
// 同时保留 PreToolUse 结构，便于之后迁移到官方推荐的专用 matcher。
export function askUserQuestionHookResponse(
  hookEventName: 'PermissionRequest' | 'PreToolUse',
  toolInput: unknown,
  answers: Record<string, string>,
): Record<string, unknown> {
  const original = toolInput && typeof toolInput === 'object' && !Array.isArray(toolInput)
    ? toolInput as Record<string, unknown>
    : {};
  const updatedInput = { ...original, answers };
  return hookEventName === 'PreToolUse'
    ? { hookSpecificOutput: { hookEventName, permissionDecision: 'allow', updatedInput } }
    : { hookSpecificOutput: { hookEventName, decision: { behavior: 'allow', updatedInput } } };
}

export function resolvedCard(question: string, answer: string | null | undefined, timedOut: boolean, source?: string): Card {
  const title = timedOut ? '⏰ 已超时' : '✅ 已回复';
  return mkCard(timedOut ? 'grey' : 'green', source ? `${title} · ${source}` : title, [
    { tag: 'markdown', content: md(question) },
    { tag: 'hr' },
    { tag: 'markdown', content: answer ? `**你的回答:** ${md(answer)}` : '_未回复，已超时_' },
  ]);
}

// 通知开关的粒度键: 空闲提醒和 AskUserQuestion 都从宿主事件中拆出来单独控制。
export const notifyKeyOf = (h: HookNotice = {}): string => {
  if (h.tool_name === 'AskUserQuestion') return 'AskUserQuestion';
  return h.hook_event_name === 'Notification' && h.notification_type === 'idle_prompt'
    ? 'idle_prompt'
    : (h.hook_event_name ?? '');
};

// Claude Code hook 事件 → 通知卡片; 不在表里的事件返回 null (忽略, 免得每个工具调用都刷屏)
export function hookCard(hook: HookNotice = {}, agentName = 'Claude'): Card | null {
  const dir = hook.cwd ? String(hook.cwd).replace(/\/+$/, '').split('/').pop()! : '';
  const where = dir ? ` · ${dir}` : '';
  const m: Record<string, { icon: string; title: string; color: CardTemplate; body: string } | undefined> = {
    Stop: { icon: '✅', title: '任务完成', color: 'green', body: `${agentName} 已完成当前工作，可以回来查看了` },
    Notification: { icon: '🔔', title: '需要你注意', color: 'orange', body: hook.message || `${agentName} 在等待输入或确认` },
    SessionEnd: { icon: '👋', title: '会话结束', color: 'grey', body: `会话已结束 (${hook.reason || 'exit'})` },
  };
  const conf = m[hook.hook_event_name ?? ''];
  if (!conf) return null;
  return mkCard(conf.color, `${conf.icon} ${conf.title}${where}`, [{ tag: 'markdown', content: conf.body }]);
}

// Stop hook 交互: Claude 本轮结果推手机, 引用回复可让 Claude 继续
export const STOP_DONE = '✅ 到此为止'; // 结束按钮的标签, 同时作为应答哨兵: 收到它 = 放行结束

export function stopCard({ id, summary, dir, timeoutSec, agentName = 'Claude' }: {
  id: string; summary: string; dir: string; timeoutSec?: number; agentName?: string;
}): Card {
  const where = dir ? ` · ${dir}` : '';
  const elements: CardElement[] = [
    { tag: 'markdown', content: md(summary) },
    { tag: 'hr' },
    { tag: 'markdown', content: `**长按引用本条消息回复**可让 ${agentName} 继续（例如：方案 B，继续实现）；等待超时自动结束` },
    mkBtn(STOP_DONE, { d: id, a: STOP_DONE }),
  ];
  if (timeoutSec) elements.push({ tag: 'markdown', content: `⏳ ${fmtDur(timeoutSec)}内未回复自动结束` });
  return mkCard('green', `✅ 任务完成${where}`, elements);
}

// Stop hook 应答: 有回复 -> additionalContext 让 Claude 继续; 无(超时/发送失败/点结束) -> 放行结束
export const stopHookResponse = (answer: string | null | undefined): Record<string, unknown> =>
  answer == null || answer === STOP_DONE
    ? { ok: true }
    : { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: `用户回复：${answer}` } };

// PermissionRequest hook 交互: 权限确认推手机, 点按钮远程 allow/deny; 标签兼哨兵(同 STOP_DONE)
export const PERM_ALLOW = '✅ 允许';
export const PERM_DENY = '❌ 拒绝';
export const PERM_AUTO = '🔓 允许并切换 auto';
export const PERM_OPTIONS = [PERM_ALLOW, PERM_DENY, PERM_AUTO];
// Codex 当前的 PermissionRequest 只接受 allow / deny；不支持在 hook 响应里切换权限模式。
export const CODEX_PERM_OPTIONS = [PERM_ALLOW, PERM_DENY];

// tool_input 摘要: Bash 类显示命令, 文件类显示路径, 其余 JSON 全文, 超长截断
export function fmtPermInput(toolInput: unknown = {}): string {
  const input = toolInput !== null && typeof toolInput === 'object' && !Array.isArray(toolInput)
    ? toolInput as Record<string, unknown>
    : null;
  const command = typeof input?.command === 'string' ? input.command : undefined;
  const filePath = typeof input?.file_path === 'string' ? input.file_path : undefined;
  const oldStr = typeof input?.old_string === 'string' ? input.old_string : undefined;
  let s: string;
  if (command !== undefined) s = command;
  else if (filePath !== undefined) s = oldStr !== undefined ? `${filePath} (old: ${oldStr.slice(0, 100)})` : filePath;
  else s = JSON.stringify(toolInput, null, 2) ?? String(toolInput);
  if (s.length > 1500) s = `${s.slice(0, 1500)}\n...`;
  return s;
}

export function permissionCard({ id, toolName, toolInput, dir, timeoutSec, options = PERM_OPTIONS }: {
  id: string; toolName: string; toolInput: unknown; dir: string; timeoutSec?: number; options?: string[];
}): Card {
  const where = dir ? ` · ${dir}` : '';
  const elements: CardElement[] = [
    { tag: 'markdown', content: `**${toolName}** 请求权限:\n\`\`\`\n${fmtPermInput(toolInput)}\n\`\`\`` },
    { tag: 'hr' },
    ...options.map((label, i) => mkBtn(label, { d: id, a: label }, i === 0)),
  ];
  if (timeoutSec) elements.push({ tag: 'markdown', content: `⏳ ${fmtDur(timeoutSec)}内未处理将回落终端确认` });
  return mkCard('orange', `🔐 权限确认${where}`, elements);
}

// PermissionRequest 应答: 允许/拒绝/允许+切 auto; 无应答(超时/断连/发送失败) -> 不决策, 回落终端确认
export function permissionHookResponse(answer: string | null | undefined): Record<string, unknown> {
  if (answer == null) return { ok: true };
  const decision = answer === PERM_ALLOW
    ? { behavior: 'allow' }
    : answer === PERM_AUTO
      ? { behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode: 'auto', destination: 'session' }] } // session=仅内存, 会话结束失效
      : { behavior: 'deny', message: answer === PERM_DENY ? '用户在手机上拒绝了此操作' : `用户拒绝: ${answer}` };
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
}

// Codex Stop: block 会把 reason 作为新的用户提示继续当前任务；空对象表示正常结束。
export const codexStopHookResponse = (answer: string | null | undefined): Record<string, unknown> =>
  answer == null || answer === STOP_DONE
    ? {}
    : { decision: 'block', reason: `用户回复：${answer}` };

// Codex PermissionRequest: 只输出官方支持的 allow / deny 结构；超时或发送失败不作决定。
export function codexPermissionHookResponse(answer: string | null | undefined): Record<string, unknown> {
  if (answer == null) return {};
  const decision = answer === PERM_ALLOW
    ? { behavior: 'allow' }
    : { behavior: 'deny', message: answer === PERM_DENY ? '用户在手机上拒绝了此操作' : `用户拒绝: ${answer}` };
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
}

// send_file 用: 扩展名 → 飞书上传类型; 图片直显(≤10MB), 其余按 im.file 的 file_type 枚举映射, 未知走 stream
// file_type 取值与 SDK im.v1.file.create 的 data.file_type 联合对齐
export type FileType = 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream';
const IMG_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'ico', 'tiff', 'heic']);
const FILE_TYPES: Record<string, FileType> = { opus: 'opus', mp4: 'mp4', pdf: 'pdf', doc: 'doc', docx: 'doc', xls: 'xls', xlsx: 'xls', ppt: 'ppt', pptx: 'ppt' };
export const fileKind = (path: string): 'image' | FileType => {
  const ext = String(path).split('.').pop()!.toLowerCase();
  return IMG_EXT.has(ext) ? 'image' : (FILE_TYPES[ext] || 'stream');
};

// send_file 上传票据: 一次性 + 5 分钟; agent 机器上的文件服务端读不到时, 凭 curl 指引推到 /file
const uploadTickets = new Map<string, { userId: string; expires: number }>(); // ticket -> ...
export function issueUploadTicket(userId: string): string {
  const t = crypto.randomBytes(16).toString('hex');
  uploadTickets.set(t, { userId, expires: Date.now() + 300_000 });
  for (const [k, v] of uploadTickets) if (v.expires < Date.now()) uploadTickets.delete(k);
  return t;
}
export function takeUploadTicket(t: unknown): string | null {
  const v = uploadTickets.get(String(t));
  if (!v || v.expires < Date.now()) return null;
  uploadTickets.delete(String(t));
  return v.userId;
}

// 飞书绑定码: 6 位数字, 10 分钟有效, 内存即可 (重启丢的是未完成的绑定, 无害)
const bindCodes = new Map<string, { userId: string; expires: number }>(); // code -> ...
export function issueBindCode(userId: string): string {
  // ponytail: 6 位数字空间小, 但单实例自用+10min 过期足够; 要抗爆破再加速率限制
  const code = crypto.randomInt(100000, 1000000).toString();
  bindCodes.set(code, { userId, expires: Date.now() + 600_000 });
  for (const [c, v] of bindCodes) if (v.expires < Date.now()) bindCodes.delete(c);
  return code;
}
export function takeBindCode(code: unknown): string | null {
  const v = bindCodes.get(String(code).trim());
  if (!v || v.expires < Date.now()) return null;
  bindCodes.delete(String(code));
  return v.userId;
}

// 飞书渠道解析 (以能用为先): 凭据和渠道同源才可用 — 手动 .env 凭据信 .env 声明;
// 扫码凭据用扫码时一起落库的渠道; .env 声明与扫码保存的不一致按可用的来, conflict 供启动告警
export function resolveDomain({ envDomain, savedDomain, envApp }: {
  envDomain?: string; savedDomain?: string; envApp: boolean;
}): { domain: 'lark' | 'feishu'; conflict: boolean } {
  const ok = (d?: string) => (d === 'lark' || d === 'feishu' ? (d as 'lark' | 'feishu') : undefined);
  const declared = ok(envDomain);
  const saved = ok(savedDomain);
  if (saved && !envApp) return { domain: saved, conflict: Boolean(declared && declared !== saved) };
  return { domain: declared ?? 'feishu', conflict: false };
}
