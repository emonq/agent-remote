# agent-remote

Agent 需要用户决策时，通过 MCP 工具把问题推到手机（飞书/Lark），阻塞等待用户回复，回复内容作为工具结果返回给 agent。

```
Agent ──MCP ask_user──▶ 本服务 ──卡片──▶ 飞书
                        (pending 挂起)      │ 点按钮 / 引用回复
Agent ◀──answer──────── 本服务 ◀──WS 长连接─┘
```

飞书走官方 SDK 的 WebSocket 长连接收事件，**不需要公网 IP / 域名 / 回调 URL**，可跑在本机或内网。

两种部署形态：**单用户**（一个 token 直接用）和**多用户**（OIDC SSO 登录、每用户 token、飞书绑定、事件历史、网页管理台）。

## 飞书侧配置（一次性）

1. [飞书开放平台](https://open.feishu.cn) / [Lark](https://open.larksuite.com) → 创建**企业自建应用**，拿到 `App ID` / `App Secret`
2. **应用能力 → 机器人**：启用
3. **权限管理**开通：
   - `im:message:send_as_bot` — 发送卡片
   - `im:message.p2p_msg:readonly` — 接收你发给机器人的消息（**必开**，缺了回复会静默失效）
   - `im:chat`（可选）
4. **事件与回调 → 事件配置 → 使用长连接接收事件**，添加事件：`接收消息 im.message.receive_v1`
5. **发布新版本并通过审批**——权限变更必须走版本发布才生效，最容易漏的一步
6. 与机器人发起一次对话，从事件日志拿到你的 `open_id`（`ou_` 开头）填入 env

## 运行

```bash
cp .env.example .env   # 填入上述配置; 国际版 Lark 设 FEISHU_DOMAIN=lark
docker compose up -d --build
# 或裸跑: npm install && npm start
```

## 接给 Claude Code

单用户模式用 env 里的 `MCP_TOKEN`；多用户模式在网页上拿自己的 token：

```bash
claude mcp add -s user -t http agent-remote http://127.0.0.1:3000/mcp \
  --header "Authorization: Bearer <TOKEN>"
```

agent 等待回复较久，调大客户端工具超时（默认 30s 会提前砍掉调用）：

```bash
export MCP_TOOL_TIMEOUT=1200000   # 20 分钟, 单位 ms
```

## 工具

**`ask_user(question, options?, timeout_minutes=10)`**

- 有 `options` → 手机上渲染按钮，点选即回
- 无（开放性问题）→ 引用该消息回复文本
- 超时 → 返回 `{"timeout": true}`，agent 自行决定默认行为
- 完成后卡片变绿（已回复）/ 灰色（超时）

## 多用户模式（可选）

单用户模式只填 `MCP_TOKEN` + `FEISHU_USER_OPEN_ID`。要多用户（SSO 登录、每用户 token、事件历史）改填：

```
OIDC_ISSUER / OIDC_CLIENT_ID / OIDC_CLIENT_SECRET / OIDC_REDIRECT_URI / SESSION_SECRET
```

任意标准 OIDC IdP（Keycloak / Authentik / Auth0 / Logto / Zitadel…）都行。用户流程：

1. 访问服务首页 → 跳 IdP 登录 → 自动建账号
2. 网页上点「生成绑定码」→ 在飞书给机器人发 `/bind 123456` → 完成飞书绑定（一个飞书号绑一个账号）
3. 网页查看/重置自己的 API token，接入方式与单用户相同（`Bearer <自己的 token>`）

所有事件（提问/回复/超时/hook/绑定）记入 SQLite（`data/agent-remote.db`，docker 已挂卷），网页可查最近 30 条。

## 多设备标注来源（可选）

一个 token 多个设备用，接入时加 `X-Client-Name` 请求头标注来源，卡片标题显示 `🤖 laptop 需要你的决策`：

```bash
claude mcp add -s user -t http agent-remote http://127.0.0.1:3000/mcp \
  --header "Authorization: Bearer <TOKEN>" \
  --header "X-Client-Name: laptop"
```

开放性问题回复按**引用**精确路由；多条并行且没带引用时不猜，回红色提示卡要求引用对应消息。

## Claude Code hook 通知（可选）

在 `~/.claude/settings.json` 配置 HTTP hook（`type: "http"`），agent 完成任务或需要你时推消息到手机：

```json
{
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:3000/claude", "headers": { "Authorization": "Bearer <MCP_TOKEN>" } }] }],
    "Notification": [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:3000/claude", "headers": { "Authorization": "Bearer <MCP_TOKEN>" } }] }],
    "PermissionRequest": [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:3000/claude", "headers": { "Authorization": "Bearer <MCP_TOKEN>" } }] }]
  }
}
```

`Stop`（任务完成）、`Notification`（等待输入/权限确认）、`SessionEnd`（会话结束）、`PermissionRequest`（远程授权），其他事件忽略。标题带项目目录名，多项目并行能分清。

绑定飞书后，`Stop` 会升级为交互式：Claude 本轮结果推到手机，**长按引用该消息回复**即可让 Claude 继续干（回复内容作为反馈注入，例如回复“方案 B，继续实现”）；点「✅ 到此为止」或不回复则放行结束。多项目/多会话同时挂起时请务必引用对应消息，避免回复串台。

等待时长只有一个旋钮：Claude Code hook 的 `timeout`（默认 600 秒，**无上限**）。服务端不设固定超时——客户端到时掐断连接，服务端感知到即放行结束。想等 30 分钟就配：

```json
{ "type": "http", "url": "http://127.0.0.1:3000/claude", "timeout": 1800, "headers": { "Authorization": "Bearer <MCP_TOKEN>" } }
```

### PermissionRequest：远程授权

绑定飞书后，`PermissionRequest` 变成手机上的授权卡：工具名 + 命令/参数正文，三个按钮——

- **✅ 允许** — 放行本次调用
- **❌ 拒绝** — 拒绝，原因回给 Claude（可调整方案后重试）
- **🔓 允许并切换 auto** — 放行本次，并把会话权限模式切成 `auto`（仅内存，会话结束失效）：后续调用由 classifier 自动放行，不再逐条弹窗

多用户模式下**引用回复**该卡片=拒绝并附上你的理由。超时、发送失败或未绑飞书时不做决策，权限确认回落到终端照常弹。

**注意**：等你在手机上点按钮期间 Claude Code 是阻塞的，等太久（hook `timeout` 默认 600s）连接会被掐断、回落终端确认。远程授权建议把 `timeout` 调大（同 Stop 的配法）。

## 开发

```bash
npm test   # 纯逻辑自检: pending 生命周期 / 匹配规则 / 卡片构造
```

MIT License.
