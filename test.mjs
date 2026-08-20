// 自检: pending 生命周期 / 按钮匹配 / 自由文本匹配 / 卡片构造 (不依赖飞书)
import assert from 'node:assert';
import { pending, resolvePending, createPending, setMessageId, matchFreeText, questionCard, resolvedCard } from './core.mjs';

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

// 3. 自由文本: 无引用时 LIFO 兜底
{
  const answers = [];
  const a = createPending({ resolve: (v) => answers.push(v), options: null, question: 'A?', timeoutMinutes: 1 });
  const b = createPending({ resolve: (v) => answers.push(v), options: null, question: 'B?', timeoutMinutes: 1 });
  const hit = matchFreeText({ parentId: null, text: 'ok' });
  assert.equal(hit.id, b, 'LIFO 取最近一条');
  assert.deepEqual(answers, ['ok']);
  assert.ok(pending.has(a), '先前的仍挂着');
  resolvePending(a, 'late');
  assert.deepEqual(answers, ['ok', 'late']);
}

// 4. 有选项的 pending 不参与自由文本兜底
{
  let resolved = 'unset';
  createPending({ resolve: (v) => { resolved = v; }, options: ['x'], question: 'Q?', timeoutMinutes: 1 });
  assert.equal(matchFreeText({ parentId: null, text: 'hi' }), null);
  assert.equal(resolved, 'unset');
}

// 5. 超时: resolve(null)
{
  let resolved;
  createPending({ resolve: (a) => { resolved = a; }, options: null, question: 'Q?', timeoutMinutes: 1 });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(resolved, undefined, '未到时不触发');
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

console.log('all tests passed');
