// 纯逻辑自检: pending 生命周期 / 匹配规则 / 卡片构造 / 票据绑定码 (不依赖飞书; 跑前先 build, 导入 dist 产物)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import {
  pending, resolvePending, createPending, setMessageId, matchFreeText,
  questionCard, resolvedCard, hookCard, stopCard, stopHookResponse,
  permissionCard, permissionHookResponse, codexPermissionHookResponse, codexStopHookResponse,
  askUserQuestionCard, parseAskUserQuestions, askUserQuestionHookResponse,
  cardActionResponse, fmtPermInput, notifyKeyOf,
  PERM_ALLOW, PERM_DENY, PERM_AUTO, CODEX_PERM_OPTIONS, ASK_USER_SUBMIT, md, fileKind,
  FEISHU_CARD_MAX_BYTES, FEISHU_CARD_TRUNCATION_NOTICE, fitCardToByteLimit, serializeCard,
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

  it('不限时: timeoutMinutes 缺省无定时器, 只能显式 resolve', () => {
    let resolved;
    const id = createPending({ resolve: (a) => { resolved = a; }, userId: 'u8', options: null, question: 'Q?' });
    assert.equal(pending.get(id).timer, null);
    assert.equal(resolved, undefined, '没有定时器不会自动 resolve');
    assert.ok(resolvePending(id, '来了'));
    assert.equal(resolved, '来了');
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
    assert.ok(/Claude is waiting/.test(hookCard({ hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }).body.elements[0].content), 'idle_prompt 走 Notification 卡片, 推不推由开关决定');
    assert.equal(notifyKeyOf({ hook_event_name: 'Notification', notification_type: 'idle_prompt' }), 'idle_prompt', 'idle_prompt 是独立开关键');
    assert.equal(notifyKeyOf({ hook_event_name: 'Notification', message: 'x' }), 'Notification');
    assert.equal(notifyKeyOf({ hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion' }), 'AskUserQuestion', '远程问答不混入权限开关');
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

  it('timeoutSec: 三种卡片显示等待时限, 不传不显示', () => {
    for (const [withT, noT] of [
      [questionCard({ id: 'D-t1', question: 'Q', options: null, timeoutSec: 600 }), questionCard({ id: 'D-t1', question: 'Q', options: null })],
      [stopCard({ id: 'D-t2', summary: 'S', dir: '', timeoutSec: 45 }), stopCard({ id: 'D-t2', summary: 'S', dir: '' })],
      [permissionCard({ id: 'D-t3', toolName: 'Bash', toolInput: {}, dir: '', timeoutSec: 1800 }), permissionCard({ id: 'D-t3', toolName: 'Bash', toolInput: {}, dir: '' })],
    ]) {
      assert.ok(withT.body.elements.some((e) => e.tag === 'markdown' && e.content.includes('⏳')), '带时限提示');
      assert.ok(!noT.body.elements.some((e) => e.tag === 'markdown' && e.content.includes('⏳')), '老客户端不带时限');
    }
    assert.ok(questionCard({ id: 'd', question: 'Q', options: null, timeoutSec: 600 }).body.elements.some((e) => /10 分钟/.test(e.content ?? '')), '600s 显示分钟');
    assert.ok(stopCard({ id: 'd', summary: 'S', dir: '', timeoutSec: 45 }).body.elements.some((e) => /45 秒/.test(e.content ?? '')), '不足一分钟显示秒');
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
    const longQuery = `${'x'.repeat(2000)}-末尾仍可见`;
    assert.ok(fmtPermInput({ query: longQuery }).endsWith('末尾仍可见"\n}'), '未触及整卡 30 KB 时不截断');
    assert.ok(fmtPermInput({ file_path: '/a/b.ts', old_string: longQuery }).includes('末尾仍可见'), '文件修改旧内容不再固定截到 100 字符');
    assert.ok(fmtPermInput({}).length > 0, '空输入兜底 JSON');
  });

  it('飞书 30 KB 整卡限制: 限内完整保留, 超限才按 UTF-8 字节裁剪', () => {
    const withinLimit = `${'完整内容'.repeat(1200)}-末尾仍可见`;
    const whole = stopCard({ id: 'D-within', summary: withinLimit, dir: '' });
    assert.equal(fitCardToByteLimit(whole), whole, '限内不复制也不截断');
    assert.ok(serializeCard(whole).includes('末尾仍可见'), '限内保留末尾');

    const oversized = `开始\n\`\`\`txt\n${'超长中文内容'.repeat(5000)}\n\`\`\`\n末尾`;
    const fitted = fitCardToByteLimit(stopCard({ id: 'D-large', summary: oversized, dir: '' }));
    const json = serializeCard(fitted);
    assert.ok(Buffer.byteLength(json, 'utf8') <= FEISHU_CARD_MAX_BYTES, '序列化卡片不超过官方 30 KB 上限');
    assert.ok(fitted.body.elements[0].content.includes(FEISHU_CARD_TRUNCATION_NOTICE), '超限时明确标注截断');
    assert.equal((fitted.body.elements[0].content.match(/```/g) ?? []).length % 2, 0, '截断后代码围栏成对');
  });

  it('AskUserQuestion hook: 完整展示、支持多题/多选并通过 updatedInput 回填', () => {
    const longDescription = `${'传输方式说明'.repeat(180)}-末尾仍可见`;
    const toolInput = {
      questions: [
        {
          question: 'MCP 配置的作用范围是什么？',
          header: '配置范围',
          options: [
            { label: '全局共享 (推荐)', description: longDescription },
            { label: '每用户独立', description: '按 user_id 隔离' },
          ],
          multiSelect: false,
        },
        {
          question: '需要支持哪些传输方式？',
          header: '传输类型',
          options: [{ label: 'SSE' }, { label: 'stdio' }],
          multiSelect: true,
        },
      ],
    };
    const prompts = parseAskUserQuestions(toolInput);
    assert.equal(prompts.length, 2);
    assert.equal(prompts[0].options[0].description, longDescription, '解析时不截断 description');

    const single = askUserQuestionCard({ id: 'ask-1', prompt: prompts[0], index: 0, total: 2, dir: 'agent-remote', timeoutSec: 600 });
    assert.match(single.header.title.content, /1\/2.*agent-remote/);
    assert.ok(single.body.elements.some((e) => e.tag === 'markdown' && e.content.endsWith('末尾仍可见')), '飞书卡片保留完整选项说明');
    assert.equal(single.body.elements.filter((e) => e.tag === 'button').length, 2);

    const multi = askUserQuestionCard({ id: 'ask-2', prompt: prompts[1], index: 1, total: 2, selected: ['SSE'] });
    const buttons = multi.body.elements.filter((e) => e.tag === 'button');
    assert.equal(buttons.length, 3, '两个选项加一个提交按钮');
    assert.equal(buttons[0].behaviors[0].value.op, 'toggle');
    assert.match(buttons[0].text.content, /☑/);
    assert.equal(buttons.at(-1).behaviors[0].value.a, ASK_USER_SUBMIT);
    assert.equal(buttons.at(-1).behaviors[0].value.op, 'submit');
    const callback = cardActionResponse(multi, 'info', '已选择 SSE');
    assert.equal(callback.card.type, 'raw', '交互回调同步返回 raw 卡片，避免消息更新竞态');
    assert.equal(callback.card.data, multi);
    assert.deepEqual(callback.toast, { type: 'info', content: '已选择 SSE' });

    const answers = {
      'MCP 配置的作用范围是什么？': '全局共享 (推荐)',
      '需要支持哪些传输方式？': 'SSE, stdio',
    };
    const permission = askUserQuestionHookResponse('PermissionRequest', toolInput, answers);
    assert.equal(permission.hookSpecificOutput.decision.behavior, 'allow');
    assert.deepEqual(permission.hookSpecificOutput.decision.updatedInput.questions, toolInput.questions, '原 questions 原样回传');
    assert.deepEqual(permission.hookSpecificOutput.decision.updatedInput.answers, answers);
    const preTool = askUserQuestionHookResponse('PreToolUse', toolInput, answers);
    assert.equal(preTool.hookSpecificOutput.permissionDecision, 'allow');
    assert.deepEqual(preTool.hookSpecificOutput.updatedInput.answers, answers);
  });

  it('AskUserQuestion 输入异常时拒绝远程解析', () => {
    assert.deepEqual(parseAskUserQuestions({}), []);
    assert.deepEqual(parseAskUserQuestions({ questions: [{ question: 'Q', options: [{ label: 1 }] }] }), []);
    assert.deepEqual(parseAskUserQuestions({ questions: Array.from({ length: 5 }, () => ({ question: 'Q', options: [] })) }), []);
  });

  it('Codex hook: 权限只允许 allow/deny，Stop 用 block/reason 续跑', () => {
    const card = permissionCard({
      id: 'D-codex-perm',
      toolName: 'shell',
      toolInput: ['rm', '-rf', 'build'],
      dir: 'myproj',
      options: CODEX_PERM_OPTIONS,
    });
    const btns = card.body.elements.filter((e) => e.tag === 'button');
    assert.equal(btns.length, 2, 'Codex 不显示切换 auto');
    assert.deepEqual(btns.map((b) => b.behaviors[0].value.a), [PERM_ALLOW, PERM_DENY]);
    assert.match(card.body.elements[0].content, /rm/);

    assert.deepEqual(codexPermissionHookResponse(null), {}, '无远程决定时交回 Codex 默认权限流程');
    assert.deepEqual(codexPermissionHookResponse(PERM_ALLOW), {
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
    assert.equal(codexPermissionHookResponse(PERM_DENY).hookSpecificOutput.decision.behavior, 'deny');
    assert.deepEqual(codexStopHookResponse(null), {}, '超时正常结束');
    assert.deepEqual(codexStopHookResponse('✅ 到此为止'), {}, '结束按钮正常结束');
    assert.deepEqual(codexStopHookResponse('继续补测试'), {
      decision: 'block',
      reason: '用户回复：继续补测试',
    });

    const stop = stopCard({ id: 'D-codex-stop', summary: 'done', dir: '', agentName: 'Codex' });
    assert.ok(stop.body.elements.some((e) => e.tag === 'markdown' && /Codex 继续/.test(e.content)));
    assert.ok(/Codex 已完成/.test(hookCard({ hook_event_name: 'Stop' }, 'Codex').body.elements[0].content));
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
