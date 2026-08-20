// 自检: pending 生命周期 / 按钮匹配 / 自由文本匹配 / 卡片构造 (不依赖飞书)
import assert from 'node:assert';
import { pending, resolvePending, createPending, setMessageId, matchFreeText, questionCard, resolvedCard, hookCard } from './core.mjs';

// 1. 按钮路径: createPending -> setMessageId -> resolvePending
{
  let resolved;
  const id = createPending({ resolve: (a) => { resolved = a; }, options: ['a', 'b'], question: 'Q?', timeoutMinutes: 1 });
  setMessageId(id, 'om_1');
  assert.equal(pending.size, 1);
  assert.ok(resolvePending(id, 'b'));
  assert.equal(resolved, 'b');
  assert.equal(pending.size, 0);
  assert.equal(resolvePending(id, 'x'), false, '重复 resolve 拒绝');
}

// 2. 自由文本: 引用回复精确匹配
{
  let resolved;
  const id = createPending({ resolve: (a) => { resolved = a; }, options: null, question: 'Q?', timeoutMinutes: 1 });
  setMessageId(id, 'om_2');
  const hit = matchFreeText({ parentId: 'om_2', text: '用方案 B' });
  assert.ok(hit && hit.id === id);
  assert.equal(resolved, '用方案 B');
}

// 3. 自由文本: 无引用时仅一条 pending 才兜底, 两条并行不猜 (由第 8 组覆盖), 这里验证单条命中
{
  const answers = [];
  const a = createPending({ resolve: (v) => answers.push(v), options: null, question: 'A?', timeoutMinutes: 1 });
  const hit = matchFreeText({ parentId: null, text: 'ok' });
  assert.equal(hit.id, a);
  assert.deepEqual(answers, ['ok']);
}

// 4. 有选项的 pending 不参与自由文本兜底
{
  let resolved = 'unset';
  const id = createPending({ resolve: (v) => { resolved = v; }, options: ['x'], question: 'Q?', timeoutMinutes: 1 });
  assert.equal(matchFreeText({ parentId: null, text: 'hi' }), null);
  assert.equal(resolved, 'unset');
  resolvePending(id, 'clean'); // 清理, 别泄漏给后面的用例
}

// 5. 超时: resolve(null)
{
  let resolved;
  const id = createPending({ resolve: (a) => { resolved = a; }, options: null, question: 'Q?', timeoutMinutes: 1 });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(resolved, undefined, '未到时不触发');
  resolvePending(id, 'clean'); // 清理
}

// 6. 卡片构造: 按钮 value 带 decisionId
{
  const card = questionCard({ id: 'D-abc123', question: '部署到生产?', options: ['是', '否'], timeoutMin: 10 });
  const actions = card.elements.find((e) => e.tag === 'action').actions;
  assert.equal(actions[0].value.d, 'D-abc123');
  assert.equal(actions[0].value.a, '是');
  const noOpt = questionCard({ id: 'D-x', question: 'Q', options: undefined, timeoutMin: 5 });
  assert.ok(noOpt.elements.some((e) => e.tag === 'markdown' && /回复/.test(e.content)));
  const done = resolvedCard('Q', '是', false);
  assert.equal(done.header.template, 'green');
  assert.equal(resolvedCard('Q', null, true).header.template, 'grey');
}

// 7. hook 事件: 只认 Stop/Notification/SessionEnd, 其余忽略
{
  const stop = hookCard({ hook_event_name: 'Stop', cwd: '/home/u/myproj' });
  assert.equal(stop.header.template, 'blue');
  assert.ok(/myproj/.test(stop.header.title.content), '标题带项目目录名');
  const note = hookCard({ hook_event_name: 'Notification', message: '需要权限确认' });
  assert.ok(/需要权限确认/.test(note.elements[0].content));
  assert.ok(/exit/.test(hookCard({ hook_event_name: 'SessionEnd' }).elements[0].content));
  assert.equal(hookCard({ hook_event_name: 'PreToolUse' }), null, '未监听的事件忽略');
  assert.equal(hookCard({}), null);
}

// 8. 引用回复精确路由 + 并发不猜
{
  const answers = {};
  const a = createPending({ resolve: (v) => { answers.a = v; }, options: null, question: 'A?', source: 'work-laptop', timeoutMinutes: 1 });
  setMessageId(a, 'om_a');
  const b = createPending({ resolve: (v) => { answers.b = v; }, options: null, question: 'B?', source: 'ci-runner', timeoutMinutes: 1 });
  setMessageId(b, 'om_b');

  // 两条并行: 无引用不猜
  assert.equal(matchFreeText({ parentId: null, text: '无引用并行两条' }), null, '两条并行无引用不猜');

  // 引用 b 命中 b, a 不受影响
  const hit = matchFreeText({ parentId: 'om_b', text: '用方案B' });
  assert.equal(hit.id, b);
  assert.equal(answers.b, '用方案B');
  assert.equal(answers.a, undefined, 'a 未被误伤');

  // 只剩 a 一条, 无引用兜底命中
  const hit2 = matchFreeText({ parentId: null, text: '就这样' });
  assert.equal(hit2.id, a);
  assert.equal(answers.a, '就这样');
}

// 9. 卡片带来源, 开放性问题提示引用回复
{
  const card = questionCard({ id: 'abcd1234-xxxx', question: 'Q', options: null, timeoutMin: 5, source: 'work-laptop' });
  assert.ok(/work-laptop/.test(card.header.title.content));
  assert.ok(card.elements.some((e) => e.tag === 'markdown' && /引用/.test(e.content)), '提示引用回复');
  const done = resolvedCard('Q', 'ok', false, 'ci-runner');
  assert.ok(/ci-runner/.test(done.header.title.content));
}

console.log('all tests passed');
