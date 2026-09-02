// key 来自启动日志打印的 /setup?key= 地址
const key = new URLSearchParams(location.search).get('key');
const stage = document.getElementById('stage');
const esc = (s) => { const d = document.createElement('span'); d.textContent = s; return d.innerHTML; };

function show(html) { stage.className = ''; stage.innerHTML = html; }

function render(s) {
  if (s.phase === 'done') {
    if (s.warning) {
      show(`<div style="color:var(--warn);font-size:2rem">⚠️</div><strong>应用已创建并绑定，自动配置未完成</strong>
        <div class="muted" style="margin:.5rem 0 1rem">${esc(s.warning.description || s.warning.code)}</div>
        <button class="primary" onclick="location.href='/'">返回首页</button>`);
      return true;
    }
    show('<div style="color:var(--ok);font-size:2rem">✅</div><strong>应用创建、配置并提交发布成功</strong><div class="muted" style="margin-top:.5rem">企业审批通过后即可使用，即将返回首页…</div>');
    setTimeout(() => location.href = '/', 1500);
    return true; // 停止轮询
  }
  if (s.phase === 'error') {
    const why = s.code === 'expired_token' ? '二维码已过期' : s.code === 'access_denied' ? '你取消了授权' : (s.description || s.code);
    show(`<div style="color:var(--warn);font-size:2rem">❌</div><strong>${why}</strong>
      <div class="muted" style="margin:.5rem 0 1rem">${esc(s.code)}</div>
      <button class="primary" onclick="restart()">重新开始</button>`);
    return true;
  }
  if (s.phase === 'waiting' && s.qr_svg) {
    show(`<div class="qr">${s.qr_svg}</div>
      <div><strong>用飞书扫描二维码</strong></div>
      <div class="muted">确认后自动创建应用、开通权限、配置底栏菜单并提交发布</div>
      <div class="muted" style="margin-top:.4rem">打不开扫码？<a href="${esc(s.url)}">点此打开授权页</a>（约 ${Math.round((s.expire_in || 300) / 60)} 分钟内有效）</div>`);
  }
  return false; // 继续
}

async function poll() {
  const s = await fetch(`/api/setup/status?key=${encodeURIComponent(key)}`).then((r) => r.json()).catch(() => null);
  if (s && render(s)) clearInterval(timer);
}

async function restart() {
  show('<div class="empty muted">正在生成新的二维码…</div>');
  await fetch(`/api/setup/start?key=${encodeURIComponent(key)}`, { method: 'POST' });
}
let timer;
restart().then(() => { timer = setInterval(poll, 1500); });
