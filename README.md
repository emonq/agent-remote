# agent-remote

Agent 需要用户决策时，通过 MCP 工具把问题推到手机（飞书/Lark），阻塞等待用户回复，回复内容作为工具结果返回给 agent。

```
Agent ──MCP ask_user──▶ 本服务 ──卡片──▶ 飞书
                        (pending 挂起)      │ 点按钮 / 引用回复
Agent ◀──answer──────── 本服务 ◀──WS 长连接─┘
```

飞书走官方 SDK 的 WebSocket 长连接收事件，**不需要公网 IP / 域名 / 回调 URL**，可跑在本机或内网。

两种部署形态：**单用户**（一个 token 直接用）和**多用户**（OIDC SSO 登录、每用户 token、飞书绑定、事件历史、网页管理台）。

## 快速开始（扫码一键创建并绑定）

不用去开发者后台手动建应用——服务启动后打开引导页，飞书扫码确认即可：自动创建企业自建应用、开通机器人能力和所需权限/事件、绑定你的飞书账号。

```bash
cp .env.example .env
docker compose up -d --build
docker compose logs agent-remote | grep setup   # 拿到带 key 的引导地址
# 浏览器打开 http://127.0.0.1:3000/setup?key=xxx，用飞书扫码 → 确认创建 → 完成
```

裸跑同理：`npm install && npm start`，日志里会打印 `/setup?key=...` 地址。凭据存在 SQLite（`data` 卷），重启不丢。单用户模式扫完即全部就绪；多用户模式各账号再到网页生成绑定码绑定个人飞书。

> 扫码后若机器人收不到消息（回复无响应），去开发者后台检查**事件与回调 → 订阅方式**是否为「使用长连接接收事件」——这是唯一无法通过扫码流程预置的配置。

## 手动配置飞书（可选，替代扫码）

1. [飞书开放平台](https://open.feishu.cn) / [Lark](https://open.larksuite.com) → 创建**企业自建应用**，把 `App ID` / `App Secret` 填入 `.env`
2. **应用能力 → 机器人**：启用
3. **权限管理**开通：
   - `im:message:send_as_bot` — 发送卡片
   - `im:message.p2p_msg:readonly` — 接收你发给机器人的消息（**必开**，缺了回复会静默失效）
   - `im:resource` — 发送图片/文件（`send_file` 用）
   - `im:chat`（可选）
4. **事件与回调 → 事件配置 → 使用长连接接收事件**，添加事件：`接收消息 im.message.receive_v1`
5. **发布新版本并通过审批**——权限变更必须走版本发布才生效，最容易漏的一步

## 运行

```bash
docker compose up -d --build
# 或裸跑: npm install && npm start
```

## 接给 Claude Code（插件一键安装）

token 从哪拿：多用户在网页登录后查看自己的 token；单用户看 env 的 `MCP_TOKEN`（没配的话在管理页生成）。

```bash
claude plugin marketplace add emonq/agent-remote
claude plugin install agent-remote@agent-remote --config base_url=<服务地址> --config token=<你的TOKEN>
```

或在会话里输入 `/plugin marketplace add emonq/agent-remote`、`/plugin install agent-remote@agent-remote`，弹出配置框时填服务地址和 Token 即可。插件自带 MCP 工具（`ask_user` / `send_file`）**和** hook（Stop / Notification / PermissionRequest / SessionEnd），装完即用，不用再改任何 settings.json。

安装时可配（事后在 `/plugin` 插件配置里也能改）：`base_url` 服务地址（必填，如 `http://127.0.0.1:3000`）、`token`（必填）、`client_name` 多设备标注、`timeout_seconds` 等手机回复时长（默认 600 秒）。

> 之前用手动方式接入的先删旧条目避免重复：`claude mcp remove agent-remote`，并清掉 `~/.claude/settings.json` 里的手工 hook 配置。

agent 等待回复较久？不用调客户端：`ask_user` **默认不限时**，服务端每 60 秒发一次 progress 心跳，既喂饱 Claude Code 的空闲检测（HTTP 默认 5 分钟无字节即断），也不会触发工具超时（未配 `MCP_TOOL_TIMEOUT` 时约 28 小时）。极旧客户端不发 progress token 时才需要自己兜底：`export CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=0`。

## 工具

**`ask_user(question, options?, timeout_minutes?)`**

- 有 `options` → 手机上渲染按钮，点选即回
- 无（开放性问题）→ 引用该消息回复文本
- `timeout_minutes` 不传则一直等到用户回复；传了才会在到点返回 `{"timeout": true}`，agent 自行决定默认行为
- 卡片会显示等待时限（如 `⏳ 10 分钟内回复有效`）；不限时不显示
- 完成后卡片变绿（已回复）/ 灰色（超时）

**`send_file(path)`**

把 agent 工作空间的文件发到手机（飞书）：图片（png/jpg/gif/webp 等）聊天内直接显示，其余（pdf/office/音视频/任意文件）以文件消息发送可点开预览。上限：图片 10MB、文件 30MB。

工具本身不传文件内容——它返回一条带**一次性票据**（5 分钟有效、单次使用）的 `curl` 命令，agent 在自己机器上执行它把文件推给服务端，服务端转发飞书。因此 agent 和 agent-remote 可以不在同一台机器/容器，只要 agent 能访问到 MCP 地址即可。

需要额外开通权限 `im:resource`（获取与上传图片或文件资源）并重新发布版本。

## 多用户模式（可选）

单用户模式零必填项（token 网页生成，飞书走扫码绑定）。要多用户（SSO 登录、每用户 token、事件历史）在 `.env` 改填：

```
OIDC_ISSUER / OIDC_CLIENT_ID / OIDC_CLIENT_SECRET / OIDC_REDIRECT_URI / SESSION_SECRET
```

任意标准 OIDC IdP（Keycloak / Authentik / Auth0 / Logto / Zitadel…）都行。用户流程：

1. 访问服务首页 → 跳 IdP 登录 → 自动建账号
2. 网页上点「生成绑定码」→ 在飞书给机器人发 `/bind 123456` → 完成飞书绑定（一个飞书号绑一个账号）
3. 网页查看/重置自己的 API token，接入方式与单用户相同（`Bearer <自己的 token>`）

所有事件（提问/回复/超时/hook/绑定）记入 SQLite（`data/agent-remote.db`，docker 已挂卷），网页可查最近 30 条。

## 多设备标注来源（可选）

一个 token 多个设备用，安装插件时配 `client_name`（如 `laptop`），卡片标题显示 `🤖 laptop 需要你的决策`；手动接入则加 `X-Client-Name` 请求头，效果相同。

开放性问题回复按**引用**精确路由；多条并行且没带引用时不猜，回红色提示卡要求引用对应消息。

## 手机通知与远程授权

装了上面的插件就自带全部 hook（`Stop` / `Notification` / `SessionEnd` / `PermissionRequest`），无需手动配置；等待时长用 `--config timeout_seconds=1800` 调整，或在 `/plugin` 插件配置里改。推送卡片会显示这条时限（如 `⏳ 30 分钟内未处理将回落终端确认`），到点服务端与客户端同步收尾。

网页「通知开关」可按事件关闭推送（含空闲提醒，默认关）；关掉「任务完成」「权限确认」后直接放行回落终端处理。

不想用插件的，也可以手动在 `~/.claude/settings.json` 配 HTTP hook（`type: "http"`），agent 完成任务或需要你时推消息到手机：

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

TypeScript 源码在 `src/`，`tsc` 编译到 `dist/` 运行；前端脚本独立在 `public/*.js`（ESLint 覆盖）。

```bash
npm run lint    # ESLint: 未定义变量/未使用声明 (src TS + public JS)
npm run build   # tsc 类型检查 + 编译到 dist/
npm test        # lint + build + 纯逻辑自检 (pending 生命周期/匹配规则/卡片构造, 跑 dist 产物)
npm start       # node dist/server.js
```

插件在 `plugin/`（含 marketplace 清单），本地试装：`claude plugin marketplace add . && claude plugin install agent-remote@agent-remote`；改完 `plugin/` 重装生效。

MIT License.
