// 用 <template> 解析: tr/td 等 table 片段在 div.innerHTML 里会被浏览器丢弃
const $ = (h) => { const t = document.createElement('template'); t.innerHTML = h.trim(); return t.content.firstElementChild; };
const esc = (s) => { const d = document.createElement('span'); d.textContent = s; return d.innerHTML; };

// 单用户模式的管理凭据: 启动日志里的 key 或 env MCP_TOKEN; 多用户模式忽略 (走 session cookie)
const KEY = localStorage.getItem('ar_key') || '';
const api = (p) => p + (p.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(KEY);

async function main() {
  const me = await fetch(api('/api/me')).then((r) => r.json()).catch(() => null);
  const app = document.getElementById('app');
  app.innerHTML = ''; // 清掉"加载中"占位

  if (!me) { app.innerHTML = '<div class="card"><div class="empty">服务异常，稍后重试</div></div>'; return; }
  if (me.login) { // 未登录 → OIDC (跳转失败时给出可见提示而不是挂着"加载中")
    app.innerHTML = '<div class="card"><div class="empty">正在跳转登录…<div class="muted" style="margin-top:.5rem">没有跳转？<a href="' + esc(me.login) + '">手动登录</a></div></div></div>';
    location.href = me.login;
    return;
  }
  if (!me.single) {
    document.getElementById('logout').style.display = '';
    document.getElementById('logout').onclick = async () => {
      await fetch('/auth/logout', { method: 'POST' });
      location.reload();
    };
  } else if (!me.key_ok) {
    // 单用户未解锁: 输入 MCP_TOKEN 或启动日志里的 key 后记住
    const box = $('<div class="card"><h2>访问密钥</h2><div class="row"><input id="k" placeholder="MCP_TOKEN 或启动日志中的 key" autocomplete="off"><button id="go" class="primary">解锁</button></div><div class="muted" style="margin-top:.4rem">只读展示不需要它；管理操作（绑定飞书 / 查看 token）需要验证一次，之后记在本浏览器</div></div>');
    app.append(box);
    box.querySelector('#go').onclick = () => {
      localStorage.setItem('ar_key', box.querySelector('#k').value.trim());
      location.reload();
    };
    box.querySelector('#k').focus();
  }

  // 账号 (两种模式都有)
  app.append($(`
    <div class="card">
      <h2>账号</h2>
      <div class="row">
        <strong>${esc(me.name)}</strong>
        ${me.bound
          ? '<span class="chip ok">✓ 飞书已绑定</span>'
          : '<span class="chip warn">未绑定飞书</span>'}
      </div>
    </div>`));

  // 飞书绑定: 未绑定→生成绑定码; 已绑定→解绑 (单/多用户同一套 /bind 流程)
  const bindCard = $('<div class="card"><h2>飞书绑定</h2><div class="bind"></div></div>');
  app.append(bindCard);
  const renderBind = (bound) => {
    const el = bindCard.querySelector('.bind');
    if (bound) {
      el.innerHTML = `<div class="row"><div><span class="chip ok">✓ 已绑定</span> <span class="muted">决策消息会推送到你的飞书</span></div>
        <button id="unbind" class="danger">解绑</button></div>`;
      el.querySelector('#unbind').onclick = async () => {
        if (!confirm('解绑后 agent 的提问将无法推送给你，继续？')) return;
        await fetch(api('/api/unbind'), { method: 'POST' });
        location.reload();
      };
      return;
    }
    el.innerHTML = `<div class="row"><div class="muted">生成绑定码，在飞书给机器人发送即可绑定你的账号</div><button id="bind" class="primary">生成绑定码</button></div>`;
    el.querySelector('#bind').onclick = async () => {
      const r = await fetch(api('/api/bind-code'), { method: 'POST' }).then((x) => x.json());
      if (r.error) { alert(r.error); return; }
      el.innerHTML = `<div>在飞书给机器人发&nbsp;<code>/bind ${esc(r.code)}</code></div>
         <div class="muted" style="margin-top:.4rem">10 分钟内有效，发送后自动完成绑定 — <a href="/" onclick="location.reload();return false">刷新页面查看绑定状态</a></div>`;
    };
  };
  renderBind(me.bound);

  // token: 默认打码, 可显示/复制; env 配置 MCP_TOKEN 时只读 (禁重置), 否则可网页生成/重置
  const tokenCard = $('<div class="card"><h2>API Token</h2><div class="tok"><div class="muted">加载中…</div></div></div>');
  app.append(tokenCard);
  const renderToken = (t, shown = false, locked) => {
    const el = tokenCard.querySelector('.tok');
    const mask = shown ? t : t.slice(0, 6) + '••••••••••••••••';
    el.innerHTML = `<div class="row"><span class="token">${esc(mask)}</span>
        <span><button id="toggle">${shown ? '隐藏' : '显示'}</button> <button id="copy">复制</button>${locked ? '' : ' <button id="rot" class="danger">重置</button>'}</span></div>
      <div class="muted" style="margin-top:.4rem">用于 MCP / hook 的 Bearer 认证${locked ? '；来自环境变量 MCP_TOKEN，改 .env 后重启生效' : '，重置后旧 token 立即失效'}</div>`;
    el.querySelector('#toggle').onclick = () => renderToken(t, !shown, locked);
    el.querySelector('#copy').onclick = () => navigator.clipboard.writeText(t);
    const rot = el.querySelector('#rot');
    if (rot) rot.onclick = async () => {
      if (!confirm('重置后所有使用旧 token 的客户端都会失效，继续？')) return;
      const r = await fetch(api('/api/rotate-token'), { method: 'POST' }).then((x) => x.json());
      if (r.error) { alert(r.error); return; }
      renderToken(r.token, true, locked);
    };
  };
  if (me.key_ok || !me.single) {
    const t = (await fetch(api('/api/token')).then((r) => r.json())).token;
    renderToken(t, false, Boolean(me.token_locked));
  } else {
    tokenCard.querySelector('.tok').innerHTML = '<div class="muted">🔒 解锁后可见</div>';
  }

  // 事件
  const typeZh = { ask: '提问', solved: '已回复', timeout: '超时', hook: 'hook', bind: '绑定', token_rotated: '重置 token' };
  const ev = $(`<div class="card"><h2>最近事件</h2>
    <table><thead><tr><th style="width:140px">时间</th><th style="width:72px">类型</th><th>内容</th></tr></thead><tbody></tbody></table>
    <div class="empty muted" style="display:none">暂无事件</div></div>`);
  app.append(ev);
  const rows = ev.querySelector('tbody');
  const events = me.events || [];
  for (const e of events) {
    const p = JSON.parse(e.payload);
    // 提问/超时显示问题; 已回复显示 问题 → 答案; hook 显示 消息+项目
    let detail = p.question ?? '';
    if (e.type === 'solved' && p.question) detail = p.answer != null ? `${p.question} → ${p.answer}` : p.question;
    if (e.type === 'hook') detail = [p.message, p.project].filter(Boolean).join(' · ') || p.event || '';
    rows.append($(`<tr><td class="muted" style="white-space:nowrap">${new Date(e.created_at).toLocaleString()}</td>
      <td><span class="tag ${esc(e.type)}">${typeZh[e.type] || esc(e.type)}</span></td>
      <td><div class="clip" title="${esc(detail)}">${esc(String(detail))}</div></td></tr>`));
  }
  if (!events.length) ev.querySelector('.empty').style.display = '';
}
main();
