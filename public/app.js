// 用 <template> 解析: tr/td 等 table 片段在 div.innerHTML 里会被浏览器丢弃
const $ = (h) => { const t = document.createElement('template'); t.innerHTML = h.trim(); return t.content.firstElementChild; };
const esc = (s) => { const d = document.createElement('span'); d.textContent = s; return d.innerHTML; };

// 单用户模式的管理凭据: 启动日志里的 key 或 env MCP_TOKEN; 多用户模式忽略 (走 session cookie)
const URL_KEY = new URLSearchParams(location.search).get('key') || '';
if (URL_KEY) localStorage.setItem('ar_key', URL_KEY);
const KEY = URL_KEY || localStorage.getItem('ar_key') || '';
if (URL_KEY) history.replaceState({}, '', location.pathname);
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

  // 飞书应用配置 (实例级): 未配置→引导扫码配对; 已配置→(解锁后)可取消配置重扫
  const cfgCard = $('<div class="card"><h2>飞书应用</h2><div class="cfg"></div></div>');
  app.append(cfgCard);
  const canAdmin = Boolean(!me.single || me.key_ok);
  const renderCfg = () => {
    const el = cfgCard.querySelector('.cfg');
    if (!me.app_configured) {
      el.innerHTML = `<div class="row"><span class="chip warn">未配置</span>
        <span class="muted" style="flex:1">agent 的提问无法推送，先创建并绑定飞书应用</span>
        ${canAdmin ? '<button id="cfg" class="primary">去扫码配对</button>' : '<span class="muted">用启动日志里的 key 解锁后可配对</span>'}</div>`;
      const b = el.querySelector('#cfg');
      if (b) b.onclick = () => { location.href = '/setup?key=' + encodeURIComponent(KEY); };
      return;
    }
    el.innerHTML = `<div class="row"><span class="chip ok">✓ 应用已配置</span>${canAdmin ? '<button id="cfg" class="danger">取消配置</button>' : ''}</div>`;
    const b = el.querySelector('#cfg');
    if (b) b.onclick = async () => {
      if (!confirm('将清除应用凭据和所有用户的飞书绑定，之后需重新扫码配对，继续？')) return;
      const r = await fetch(api('/api/unconfigure'), { method: 'POST' }).then((x) => x.json()).catch(() => null);
      if (!r || r.error) { alert(r?.error || '操作失败'); return; }
      location.href = '/setup?key=' + encodeURIComponent(KEY);
    };
  };
  renderCfg();

  // 账号 + 飞书绑定: 状态与操作同源, 合并一张卡 (未绑定→生成绑定码; 已绑定→可解绑)
  const acctCard = $('<div class="card"><h2>账号</h2><div class="acct"></div></div>');
  app.append(acctCard);
  const renderAcct = (bound) => {
    const el = acctCard.querySelector('.acct');
    el.innerHTML = `<div class="row"><div><strong>${esc(me.name)}</strong>&nbsp;&nbsp;${
        bound ? '<span class="chip ok">✓ 飞书已绑定</span>' : '<span class="chip warn">未绑定飞书</span>'
      }</div><span class="act"></span></div><div class="detail"></div>`;
    const act = el.querySelector('.act');
    if (bound) {
      act.innerHTML = '<button id="unbind" class="danger">解绑</button>';
      act.querySelector('#unbind').onclick = async () => {
        if (!confirm('解绑后 agent 的提问将无法推送给你，继续？')) return;
        await fetch(api('/api/unbind'), { method: 'POST' });
        location.reload();
      };
      return;
    }
    act.innerHTML = '<button id="bind" class="primary">生成绑定码</button>';
    act.querySelector('#bind').onclick = async () => {
      const r = await fetch(api('/api/bind-code'), { method: 'POST' }).then((x) => x.json());
      if (r.error) { alert(r.error); return; }
      act.innerHTML = '';
      el.querySelector('.detail').innerHTML =
        `<div>在飞书给机器人发&nbsp;<code>/bind ${esc(r.code)}</code></div>
         <div class="muted" style="margin-top:.4rem">10 分钟内有效，发送后自动完成绑定 — <a href="/" onclick="location.reload();return false">刷新查看绑定状态</a></div>`;
    };
  };
  renderAcct(me.bound);

  // Codex 一键安装: WebUI 只签发短期票据，长期设备凭据由插件首次启动后写入 PLUGIN_DATA。
  const installCard = $(`<div class="card install-card">
    <div class="install-heading"><div><div class="eyebrow">CODEX CONNECTION</div><h2>连接 Codex</h2></div><span class="ticket-life">10 分钟票据</span></div>
    <div class="install-body"><p>生成一条只属于当前账号的一次性命令。命令会直接下载插件并交给 Codex 安装，所有步骤都清楚可见。</p><div class="install-stage"></div></div>
  </div>`);
  app.append(installCard);
  const installStage = installCard.querySelector('.install-stage');
  let ticketTimer;
  const renderInstallAction = () => {
    clearInterval(ticketTimer);
    installStage.innerHTML = canAdmin
      ? '<button id="make-install" class="primary">生成安装命令</button><span class="muted">不运行安装器，命令中不包含长期 Token</span>'
      : '<span class="muted">解锁管理权限后即可生成安装命令</span>';
    const make = installStage.querySelector('#make-install');
    if (!make) return;
    make.onclick = async () => {
      make.disabled = true;
      make.textContent = '正在生成…';
      const response = await fetch(api('/api/install-ticket'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent: 'codex' }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        installStage.innerHTML = `<div class="install-error">${esc(result.error || '生成失败，请稍后重试')}</div><button id="retry-install">重新生成</button>`;
        installStage.querySelector('#retry-install').onclick = renderInstallAction;
        return;
      }
      const commands = result.commands || { unix: result.command };
      let commandPlatform = /Win/i.test(navigator.userAgentData?.platform || navigator.platform || '') && commands.powershell
        ? 'powershell' : 'unix';
      installStage.innerHTML = `<div class="command-ticket">
        <div class="command-meta"><span>一次性安装命令</span><span id="ticket-clock">10:00</span></div>
        <div class="command-platforms" role="group" aria-label="选择终端类型">
          <button type="button" data-platform="unix">macOS / Linux</button>
          <button type="button" data-platform="powershell">Windows</button>
        </div>
        <pre><code></code></pre>
        <div class="command-actions"><button id="copy-install" class="primary">复制命令</button><button id="renew-install">重新生成</button></div>
      </div><div class="muted install-hint">命令只使用下载、解压和 Codex 官方插件命令。运行后打开一个新的 Codex 任务完成连接。</div>`;
      const commandCode = installStage.querySelector('.command-ticket code');
      const platformButtons = [...installStage.querySelectorAll('[data-platform]')];
      const showCommand = (platform) => {
        if (!commands[platform]) return;
        commandPlatform = platform;
        commandCode.textContent = commands[platform];
        platformButtons.forEach((button) => {
          const selected = button.dataset.platform === platform;
          button.classList.toggle('active', selected);
          button.setAttribute('aria-pressed', String(selected));
        });
      };
      platformButtons.forEach((button) => { button.onclick = () => showCommand(button.dataset.platform); });
      showCommand(commandPlatform);
      installStage.querySelector('#copy-install').onclick = async (event) => {
        await navigator.clipboard.writeText(commands[commandPlatform]);
        event.target.textContent = '已复制';
        setTimeout(() => { event.target.textContent = '复制命令'; }, 1200);
      };
      installStage.querySelector('#renew-install').onclick = renderInstallAction;
      const expiresAt = new Date(result.expires_at).getTime();
      const clock = installStage.querySelector('#ticket-clock');
      const tick = () => {
        const seconds = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
        clock.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
        if (!seconds) {
          clearInterval(ticketTimer);
          clock.textContent = '已过期';
          clock.classList.add('expired');
        }
      };
      tick();
      ticketTimer = setInterval(tick, 1000);
    };
  };
  renderInstallAction();

  // token: 默认打码, 可显示/复制; env 配置 MCP_TOKEN 时只读 (禁重置), 否则可网页生成/重置
  const tokenCard = $('<div class="card"><h2>Claude Code / API Token</h2><div class="tok"><div class="muted">加载中…</div></div></div>');
  app.append(tokenCard);
  const renderToken = (t, shown = false, locked) => {
    const el = tokenCard.querySelector('.tok');
    const mask = shown ? t : t.slice(0, 6) + '••••••••••••••••';
    el.innerHTML = `<div class="row"><span class="token">${esc(mask)}</span>
        <span><button id="toggle">${shown ? '隐藏' : '显示'}</button> <button id="copy">复制</button>${locked ? '' : ' <button id="rot" class="danger">重置</button>'}</span></div>
      <div class="muted" style="margin-top:.4rem">用于 Claude Code 或手动 API 接入；Codex 一键安装不需要复制此 Token${locked ? '。该值来自环境变量 MCP_TOKEN' : '。重置后现有 Codex 设备凭据也会失效'}</div>`;
    el.querySelector('#toggle').onclick = () => renderToken(t, !shown, locked);
    el.querySelector('#copy').onclick = async (e) => {
      await navigator.clipboard.writeText(t);
      e.target.textContent = '已复制';
      setTimeout(() => { e.target.textContent = '复制'; }, 1200);
    };
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

  // 通知开关: 关掉的事件不再推飞书; 任务完成/权限确认关闭后直接放行, 回落终端处理
  const NOTIFY_LABELS = { Stop: '任务完成（可续跑）', Notification: '需要你注意', SessionEnd: '会话结束', PermissionRequest: '权限确认', idle_prompt: '空闲提醒' };
  const off = new Set(me.notify || []);
  const nfCard = $('<div class="card"><h2>通知开关</h2><div class="muted" style="margin-bottom:.4rem">关掉的不再推送；「任务完成」「权限确认」关闭后直接放行，回落终端处理</div><div class="row" id="nfs" style="flex-wrap:wrap;gap:.6rem"></div></div>');
  app.append(nfCard);
  const nfs = nfCard.querySelector('#nfs');
  for (const [k, label] of Object.entries(NOTIFY_LABELS)) {
    const l = $(`<label style="display:flex;align-items:center;gap:.3rem;cursor:pointer"><input type="checkbox" ${off.has(k) ? '' : 'checked'}> ${esc(label)}</label>`);
    l.querySelector('input').onchange = async (e) => {
      if (e.target.checked) off.delete(k); else off.add(k);
      await fetch(api('/api/notify'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify([...off]) });
    };
    nfs.append(l);
  }

  // 事件
  const typeZh = { ask: '提问', solved: '已回复', timeout: '超时', hook: 'hook', bind: '绑定', token_rotated: '重置 token', install_ticket: '安装票据', client_installed: 'Codex 连接' };
  const ev = $(`<div class="card"><h2>最近事件</h2>
    <div class="table-scroll"><table><thead><tr><th style="width:140px">时间</th><th style="width:72px">类型</th><th>内容</th></tr></thead><tbody></tbody></table></div>
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
    if (e.type === 'install_ticket') detail = 'Codex · 十分钟一次性命令';
    if (e.type === 'client_installed') detail = [p.agent, p.client].filter(Boolean).join(' · ');
    rows.append($(`<tr><td class="muted" style="white-space:nowrap">${new Date(e.created_at).toLocaleString()}</td>
      <td><span class="tag ${esc(e.type)}">${typeZh[e.type] || esc(e.type)}</span></td>
      <td><div class="clip" title="${esc(detail)}">${esc(String(detail))}</div></td></tr>`));
  }
  if (!events.length) ev.querySelector('.empty').style.display = '';
}
main();
