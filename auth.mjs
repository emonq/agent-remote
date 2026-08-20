// OIDC 授权码流 (手写, 零新依赖) + HMAC session cookie
import crypto from 'node:crypto';

const CFG = () => ({
  issuer: process.env.OIDC_ISSUER,       // 如 https://auth.example.com
  clientId: process.env.OIDC_CLIENT_ID,
  clientSecret: process.env.OIDC_CLIENT_SECRET,
  redirectUri: process.env.OIDC_REDIRECT_URI,  // 如 https://svc.example.com/auth/callback
});

export function oidcConfigured() {
  const { issuer, clientId, clientSecret, redirectUri } = CFG();
  return Boolean(issuer && clientId && clientSecret && redirectUri);
}

let discovery = null; // issuer 元数据缓存 (含 endpoints/jwks)
async function discover() {
  if (discovery) return discovery;
  const res = await fetch(`${CFG().issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
  discovery = await res.json();
  return discovery;
}

// id_token 只用于拿 sub/name — code flow + client_secret 换来的 token, 信任 IdP 的 TLS,
// 不做签名校验 (要做时用 discovery.jwks_uri 验 RS256)。
async function exchangeCode(code) {
  const { clientId, clientSecret, redirectUri } = CFG();
  const d = await discover();
  const res = await fetch(d.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, client_secret: clientSecret }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
  const claims = JSON.parse(Buffer.from((await res.json()).id_token.split('.')[1], 'base64url').toString());
  return { sub: claims.sub, name: claims.name || claims.preferred_username || claims.email || claims.sub };
}

export function loginUrl(state) {
  const { clientId, redirectUri } = CFG();
  return discover().then((d) =>
    `${d.authorization_endpoint}?${new URLSearchParams({
      response_type: 'code', client_id: clientId, redirect_uri: redirectUri,
      scope: 'openid profile', state,
    })}`);
}

export const handleCallback = exchangeCode;

// ---- session cookie: userId.expiry.version.hmac ----
const sessionKey = () => process.env.SESSION_SECRET || 'ponytail: dev 默认, 生产必换';

// 无状态 cookie 无法服务端注销 — 用递增版本号: bump 后旧 cookie 全部失效 (内存, 重启即全部失效, 可接受)
const sessionVersions = new Map(); // userId -> version
export function bumpSessionVersion(userId) { sessionVersions.set(userId, (sessionVersions.get(userId) ?? 0) + 1); }
export function currentSessionVersion(userId) { return sessionVersions.get(userId) ?? 0; }

export function signSession(userId, days = 30) {
  const exp = Date.now() + days * 86400_000;
  const v = currentSessionVersion(userId);
  const body = `${userId}.${exp}.${v}`;
  const mac = crypto.createHmac('sha256', sessionKey()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function verifySession(cookie) {
  if (!cookie) return null;
  const parts = cookie.split('.');
  if (parts.length !== 4) return null;
  const [userId, exp, v, mac] = parts;
  const expect = crypto.createHmac('sha256', sessionKey()).update(`${userId}.${exp}.${v}`).digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  if (Number(exp) < Date.now()) return null;
  if (Number(v) !== currentSessionVersion(userId)) return null; // 已注销
  return userId;
}
