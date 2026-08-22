// 纯逻辑自检: pending 生命周期 / 匹配规则 / 卡片构造 / 票据绑定码 (不依赖飞书; 跑前先 build, 导入 dist 产物)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  pending, resolvePending, createPending, setMessageId, matchFreeText,
  questionCard, resolvedCard, hookCard, stopCard, stopHookResponse,
  permissionCard, permissionHookResponse, fmtPermInput,
  PERM_ALLOW, PERM_DENY, PERM_AUTO, md, fileKind,
  issueUploadTicket, takeUploadTicket, issueBindCode, takeBindCode, resolveDomain,
} from '../dist/core.js';

describe('pending 生命周期', () => {
  it('按钮路径: createPending -> setMessageId -> resolvePending', () => {
    let resolved;
    const id = createPending({ resolve: (a) => { resolved = a; }, userId: 'u1', options: ['a', 'b'], question: 'Q?', timeoutMinutes: 1 });
    setMessageId(id, 'om_1');
    assert.equal(pending.size, 1);
    assert.ok(resolvePending(id, 'b'));
    assert.equal(resolved, 'b');
    assert.equal(pending.size, 0);
    assert.equal(resolvePending(id, 'x'), false, '重复 resolve 拒绝');
  });

  it('自由文本: 引用回复精确匹配', () => {
    let resolved;
    const id = createPending({ resolve: (a) => { resolved = a; }, userId: 'u1', options: null, question: 'Q?', timeoutMinutes: 1 });
    setMessageId(id, 'om_2');
    const hit = matchFreeText({ userId: 'u1', parentId: 'om_2', text: '用方案 B' });
    assert.ok(hit && hit.id === id);
    assert.equal(resolved, '用方案 B');
  });

  it('自由文本: 无引用时仅一条 pending 才兜底', () => {
    const answers = [];
    const a = createPending({ resolve: (v) => answers.push(v), userId: 'u2', options: null, question: 'A?', timeoutMinutes: 1 });
    const hit = matchFreeText({ userId: 'u2', parentId: null, text: 'ok' });
    assert.equal(hit.id, a);
    assert.deepEqual(answers, ['ok']);
  });

  it('用户隔离: u2 的回复不能命中 u3 的 pending', () => {
    const answers = [];
    const id = createPending({ resolve: (v) => answers.push(v), userId: 'u3', options: null, question: 'A?', timeoutMinutes: 1 });
    assert.equal(matchFreeText({ userId: 'u2', parentId: null, text: '不是我的' }), null);
    assert.deepEqual(answers, []);
    resolvePending(id, 'clean'); // 清理, 别留 60s 定时器拖慢进程退出
  });

  it('有选项的 pending 不参与自由文本兜底', () => {
    let resolved = 'unset';
    const id = createPending({ resolve: (v) => { resolved = v; }, userId: 'u1', options: ['x'], question: 'Q?', timeoutMinutes: 1 });
    assert.equal(matchFreeText({ parentId: null, text: 'hi' }), null);
    assert.equal(resolved, 'unset');
    resolvePending(id, 'clean'); // 清理, 别泄漏给后面的用例
  });

  it('超时: resolve(null)', async () => {
    let resolved;
    const id = createPending({ resolve: (a) => { resolved = a; }, userId: 'u1', options: null, question: 'Q?', timeoutMinutes: 1 });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(resolved, undefined, '未到时不触发');
    resolvePending(id, 'clean'); // 清理
  });
});

describe('卡片构造', () => {
  it('2.0 结构, 按钮为顶层 element, callback value 带 decisionId', () => {
    const card = questionCard({ id: 'D-abc123', question: '部署到生产?', options: ['是', '否'] });
    assert.equal(card.schema, '2.0', 'CardKit 2.0 结构');
    const btns = card.body.elements.filter((e) => e.tag === 'button');
    assert.equal(btns.length, 2, '无 action 壳, 按钮直接平铺');
    assert.equal(btns[0].behaviors[0].value.d, 'D-abc123');
    assert.equal(btns[0].behaviors[0].value.a, '是');
    const noOpt = questionCard({ id: 'D-x', question: 'Q', options: undefined });
    assert.ok(noOpt.body.elements.some((e) => e.tag === 'markdown' && /回复/.test(e.content)));
    assert.equal(resolvedCard('Q', '是', false).header.template, 'green');
    assert.equal(resolvedCard('Q', null, true).header.template, 'grey');
  });

  it('hook 事件: 只认 Stop/Notification/SessionEnd, 各自配色, 其余忽略', () => {
    const stop = hookCard({ hook_event_name: 'Stop', cwd: '/home/u/myproj' });
    assert.equal(stop.header.template, 'green');
    assert.ok(/myproj/.test(stop.header.title.content), '标题带项目目录名');
    assert.equal(hookCard({ hook_event_name: 'Notification', message: '需要权限确认' }).header.template, 'orange');
    assert.ok(/需要权限确认/.test(hookCard({ hook_event_name: 'Notification', message: '需要权限确认' }).body.elements[0].content));
    assert.equal(hookCard({ hook_event_name: 'SessionEnd' }).header.template, 'grey');
    assert.ok(/exit/.test(hookCard({ hook_event_name: 'SessionEnd' }).body.elements[0].content));
    assert.equal(hookCard({ hook_event_name: 'PreToolUse' }), null, '未监听的事件忽略');
    assert.equal(hookCard({}), null);
  });

  it('引用回复精确路由 + 并发不猜', () => {
    const answers = {};
    const a = createPending({ resolve: (v) => { answers.a = v; }, userId: 'u1', options: null, question: 'A?', source: 'work-laptop', timeoutMinutes: 1 });
    setMessageId(a, 'om_a');
    const b = createPending({ resolve: (v) => { answers.b = v; }, userId: 'u1', options: null, question: 'B?', source: 'ci-runner', timeoutMinutes: 1 });
    setMessageId(b, 'om_b');

    assert.equal(matchFreeText({ userId: 'u1', parentId: null, text: '无引用并行两条' }), null, '两条并行无引用不猜');

    const hit = matchFreeText({ userId: 'u1', parentId: 'om_b', text: '用方案B' });
    assert.equal(hit.id, b);
    assert.equal(answers.b, '用方案B');
    assert.equal(answers.a, undefined, 'a 未被误伤');

    const hit2 = matchFreeText({ userId: 'u1', parentId: null, text: '就这样' });
    assert.equal(hit2.id, a);
    assert.equal(answers.a, '就这样');
  });

  it('卡片带来源, 开放性问题提示引用回复', () => {
    const card = questionCard({ id: 'abcd1234-xxxx', question: 'Q', options: null, source: 'work-laptop' });
    assert.ok(/work-laptop/.test(card.header.title.content));
    assert.ok(card.body.elements.some((e) => e.tag === 'markdown' && /引用/.test(e.content)), '提示引用回复');
    const done = resolvedCard('Q', 'ok', false, 'ci-runner');
    assert.ok(/ci-runner/.test(done.header.title.content));
  });

  it('Stop hook: 卡片带结果/引用提示/结束按钮, 应答格式', () => {
    const card = stopCard({ id: 'D-stop1', summary: '重构完成', dir: 'myproj' });
    assert.ok(/myproj/.test(card.header.title.content));
    assert.ok(/重构完成/.test(card.body.elements[0].content));
    assert.ok(card.body.elements.some((e) => e.tag === 'markdown' && /引用/.test(e.content)), '提示引用回复');
    const btn = card.body.elements.find((e) => e.tag === 'button');
    assert.equal(btn.behaviors[0].value.d, 'D-stop1');
    assert.equal(btn.behaviors[0].value.a, '✅ 到此为止');
    assert.deepEqual(stopHookResponse(null), { ok: true }, '无回复放行结束');
    assert.deepEqual(stopHookResponse('✅ 到此为止'), { ok: true }, '点结束按钮放行, 不等超时');
    assert.deepEqual(stopHookResponse('方案 B'), {
      hookSpecificOutput: { hookEventName: 'Stop', additionalContext: '用户回复：方案 B' },
    });
  });

  it('md(): 图片语法降级为链接, 防 2.0 卡片 400', () => {
    assert.equal(md('看图 ![截图](https://example.com/img.png) 完事'), '看图 [截图](https://example.com/img.png) 完事');
    assert.equal(md('空 alt ![](https://a.com/b.png)'), '空 alt [https://a.com/b.png](https://a.com/b.png)');
    assert.equal(md('嵌套 ![alt [inner]](https://a.com/b.png) 图'), '嵌套 [alt [inner]](https://a.com/b.png) 图', 'alt 嵌套括号');
    assert.equal(md('wiki ![x](https://en.wikipedia.org/wiki/Foo_(bar)) 图'), 'wiki [x](https://en.wikipedia.org/wiki/Foo_(bar)) 图', 'URL 带配对括号');
    assert.equal(md('普通 [链接](https://a.com) 不受影响'), '普通 [链接](https://a.com) 不受影响');
    assert.equal(md('引用式 ![alt][ref] 不动'), '引用式 ![alt][ref] 不动', '2.0 不认引用式图片, 原样保留');
    assert.equal(md(undefined), '');
    const card = stopCard({ id: 'D-x', summary: '![img](https://example.com/img.png)', dir: '' });
    assert.ok(!/!\[/.test(card.body.elements[0].content), 'stop 卡 summary 已降级');
  });

  it('PermissionRequest hook: 卡片三按钮, 应答 allow/deny/auto, 无应答不决策', () => {
    const card = permissionCard({ id: 'D-perm1', toolName: 'Bash', toolInput: { command: 'rm -rf node_modules', description: '清理' }, dir: 'myproj' });
    assert.ok(/myproj/.test(card.header.title.content), '标题带项目目录名');
    assert.equal(card.header.template, 'orange');
    assert.ok(/rm -rf node_modules/.test(card.body.elements[0].content), 'Bash 显示命令');
    const btns = card.body.elements.filter((e) => e.tag === 'button');
    assert.equal(btns.length, 3, '允许/拒绝/切 auto 三按钮');
    assert.equal(btns[0].behaviors[0].value.d, 'D-perm1');
    assert.equal(btns[0].type, 'primary', '允许为 primary');
    assert.equal(btns.map((b) => b.behaviors[0].value.a).join('|'), [PERM_ALLOW, PERM_DENY, PERM_AUTO].join('|'));

    assert.deepEqual(permissionHookResponse(null), { ok: true }, '无应答不决策, 回落终端确认');
    assert.deepEqual(permissionHookResponse(PERM_ALLOW), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
    assert.deepEqual(permissionHookResponse(PERM_AUTO), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode: 'auto', destination: 'session' }] } } }, 'auto = allow + setMode session');
    const deny = permissionHookResponse(PERM_DENY);
    assert.equal(deny.hookSpecificOutput.decision.behavior, 'deny');
    assert.equal(permissionHookResponse('不要动那个目录').hookSpecificOutput.decision.message, '用户拒绝: 不要动那个目录', '引用回复=拒绝并附理由');

    assert.equal(fmtPermInput({ command: 'ls' }), 'ls', 'Bash 显示 command');
    assert.equal(fmtPermInput({ file_path: '/a/b.ts' }), '/a/b.ts', '文件工具显示路径');
    assert.match(fmtPermInput({ query: 'x'.repeat(2000) }), /\.\.\.$/, '超长截断');
    assert.ok(fmtPermInput({}).length > 0, '空输入兜底 JSON');
  });
});

describe('send_file / 绑定码', () => {
  it('fileKind: 扩展名 → 图片直显 / 枚举 file_type / 未知 stream', () => {
    assert.equal(fileKind('/a/screenshot.PNG'), 'image', '大小写不敏感');
    assert.equal(fileKind('报告.pdf'), 'pdf');
    assert.equal(fileKind('data.xlsx'), 'xls');
    assert.equal(fileKind('demo.mp4'), 'mp4');
    assert.equal(fileKind('archive.tar.gz'), 'stream', '未知扩展名走 stream');
    assert.equal(fileKind('noext'), 'stream');
  });

  it('上传票据: 一次性 + 过期', () => {
    const t = issueUploadTicket('u1');
    assert.match(t, /^[0-9a-f]{32}$/, '32 hex 随机');
    assert.equal(takeUploadTicket(t), 'u1');
    assert.equal(takeUploadTicket(t), null, '一次性');
    assert.equal(takeUploadTicket('deadbeef'), null, '无效票据');
  });

  it('绑定码: 一次性 + 过期', () => {
    const code = issueBindCode('u9');
    assert.equal(takeBindCode(code), 'u9');
    assert.equal(takeBindCode(code), null, '绑定码一次性');
    assert.equal(takeBindCode('000000'), null, '无效码');
    assert.match(code, /^\d{6}$/);
  });

  it('resolveDomain: 渠道跟凭据同源, 冲突以可用的扫码渠道为准', () => {
    // 扫码保存的渠道压过 .env 的错误声明 (以能用为先)
    assert.deepEqual(resolveDomain({ envDomain: 'lark', savedDomain: 'feishu', envApp: false }),
      { domain: 'feishu', conflict: true });
    // 一致或 .env 未声明: 直接用扫码保存的
    assert.deepEqual(resolveDomain({ envDomain: 'feishu', savedDomain: 'feishu', envApp: false }),
      { domain: 'feishu', conflict: false });
    assert.deepEqual(resolveDomain({ savedDomain: 'lark', envApp: false }), { domain: 'lark', conflict: false });
    // 手动 env 凭据: 信 .env 声明, 忽略残留扫码记录
    assert.deepEqual(resolveDomain({ envDomain: 'lark', savedDomain: 'feishu', envApp: true }),
      { domain: 'lark', conflict: false });
    // 无扫码记录: 用 .env 声明, 默认 feishu; 非法值当未配
    assert.deepEqual(resolveDomain({ envDomain: 'lark', envApp: false }), { domain: 'lark', conflict: false });
    assert.deepEqual(resolveDomain({}), { domain: 'feishu', conflict: false });
    assert.deepEqual(resolveDomain({ envDomain: 'LARK', envApp: false }), { domain: 'feishu', conflict: false });
  });
});