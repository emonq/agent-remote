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

## 连接 Codex（推荐）

部署完成后打开 Agent Remote WebUI，在「连接 Codex」卡片点**生成安装命令**，复制并在 Codex 所在机器运行：

```bash
AGENT_REMOTE_CODEX_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/agent-remote/codex"
mkdir -p "$AGENT_REMOTE_CODEX_DIR"
curl -fsSL "https://agent-remote.example.com/install/codex/<一次性票据>" --output "$AGENT_REMOTE_CODEX_DIR/agent-remote-codex.tgz"
tar -xzf "$AGENT_REMOTE_CODEX_DIR/agent-remote-codex.tgz" -C "$AGENT_REMOTE_CODEX_DIR"
codex plugin marketplace add "$AGENT_REMOTE_CODEX_DIR" --json
codex plugin add agent-remote@agent-remote-install --json
```

WebUI 会把这些步骤合成一条可复制命令，并提供 macOS/Linux 和 Windows 两种版本。没有 npm 包、独立安装器或隐藏脚本；命令只下载个性化插件压缩包、解压，再调用 Codex 官方插件命令。这条命令十分钟有效且只能兑换一次，插件包内只有服务地址和安装票据，不包含用户主 Token。安装完成后打开一个新的 Codex 任务：

1. `SessionStart` Hook 用票据兑换独立的设备凭据
2. 凭据以 `0600` 原子写入 Codex 提供的 `PLUGIN_DATA/config.json`
3. 安装包中的 `bootstrap.json` 随即删除
4. MCP 与后续 Hook 只读取 `PLUGIN_DATA`，不会读取共享目录

重新连接或换服务时，回到 WebUI 生成一条新命令再运行即可。命令会移除旧版 Codex 插件，并删除旧方案留下的 `~/.agent-remote/config.json`。

旧的浏览器短码配对、交互式多 Agent 安装、环境变量覆盖、共享配置文件和对话内配置工具均已移除。远程部署必须通过 HTTPS；本机 `http://127.0.0.1` 仍可使用。

Codex 插件复用 `/mcp`，提供 `ask_user` / `send_file`，并通过 `/codex` Hook 适配器实现：

- `Stop`：任务结果推到飞书；引用回复后，用 Codex 的 `block/reason` 机制继续当前任务
- `PermissionRequest`：手机远程允许或拒绝本次操作
- `SessionEnd`：会话结束通知
- 防循环：手机回复触发续跑后，下一次 `Stop` 只发完成通知，不再阻塞

插件入口是 `plugins/codex/agent-remote/.codex-plugin/plugin.json`，MCP 配置是 `plugins/codex/agent-remote/.mcp.json`，Hook 配置是 `plugins/codex/agent-remote/hooks/hooks.json`。Codex 当前的 `PermissionRequest` Hook 只支持 `allow` / `deny`，所以手机卡片只有两个按钮；Claude Code 的“允许并切换 auto”不受影响。未绑定飞书、通知关闭、请求超时或服务不可达时，适配器返回空决定，让 Codex 回落本地流程。

## 安装 Claude Code

Claude Code 继续使用它自己的插件配置界面：

token 从哪拿：多用户在网页登录后查看自己的 token；单用户看 env 的 `MCP_TOKEN`（没配的话在管理页生成）。

```bash
claude plugin marketplace add emonq/agent-remote
claude plugin install agent-remote@agent-remote --config base_url=<服务地址> --config token=<你的TOKEN>
```

从旧目录版本升级不需要重装或重新填写配置：运行 `claude plugin marketplace update agent-remote && claude plugin update agent-remote@agent-remote`，然后重启 Claude Code 或执行 `/reload-plugins`。

或在会话里输入 `/plugin marketplace add emonq/agent-remote`、`/plugin install agent-remote@agent-remote`，弹出配置框时填服务地址和 Token 即可。插件自带 MCP 工具（`ask_user` / `send_file`）**和** hook（AskUserQuestion 远程作答 / Stop / Notification / PermissionRequest / SessionEnd），装完即用，不用再改任何 settings.json。

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
3. Codex 直接在网页生成一次性安装命令；Claude Code 或手动 API 接入再查看自己的 API Token

所有事件（提问/回复/超时/hook/绑定）记入 SQLite（`data/agent-remote.db`，docker 已挂卷），网页可查最近 30 条。

## 多设备标注来源（可选）

Codex 每次安装都会生成独立设备凭据，并自动用本机主机名作为来源标注。Claude Code 可在插件配置中填写 `client_name`；手动 API 接入则使用 `X-Client-Name` 请求头。卡片标题会显示 `🤖 <名称> 需要你的决策`。

开放性问题回复按**引用**精确路由；多条并行且没带引用时不猜，回红色提示卡要求引用对应消息。

## 手机通知与远程授权

装了上面的插件就自带 hook，无需手改客户端配置。Claude Code 可在 `/plugin` 中调整 `timeout_seconds`；Codex 一键安装默认等待 600 秒。推送卡片会显示时限，到点后服务端与客户端同步回落本地处理。

网页「通知开关」可按事件关闭推送（含空闲提醒，默认关）；关掉「Claude 提问」「任务完成」「权限确认」后直接放行回落终端处理。

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

`AskUserQuestion`（Claude 主动澄清需求，通过 PermissionRequest hook 分流）、`Stop`（任务完成）、`Notification`（等待输入/权限确认）、`SessionEnd`（会话结束）、其他 `PermissionRequest`（远程授权）。标题带项目目录名，多项目并行能分清。

绑定飞书后，`Stop` 会升级为交互式：Claude 本轮结果推到手机，**长按引用该消息回复**即可让 Claude 继续干（回复内容作为反馈注入，例如回复“方案 B，继续实现”）；点「✅ 到此为止」或不回复则放行结束。多项目/多会话同时挂起时请务必引用对应消息，避免回复串台。

等待时长只有一个旋钮：Claude Code hook 的 `timeout`（默认 600 秒，**无上限**）。服务端不设固定超时——客户端到时掐断连接，服务端感知到即放行结束。想等 30 分钟就配：

```json
{ "type": "http", "url": "http://127.0.0.1:3000/claude", "timeout": 1800, "headers": { "Authorization": "Bearer <MCP_TOKEN>" } }
```

### AskUserQuestion：远程回答 Claude 的澄清问题

Claude Code 调用内置 `AskUserQuestion` 时，服务会读取完整的 `questions`，逐题发到飞书，而不是把原始 JSON 当作权限正文截断显示：

- 单选题直接点选项；选项说明完整展示
- 多选题可依次勾选，再点「提交选择」
- 一次包含多道题时按 `1/N` 顺序推送，全部回答后 Claude 自动继续
- 也可以长按引用问题卡，回复自定义答案

服务收齐答案后通过 `updatedInput.answers` 原样回填 Claude Code。超时、发送失败、未绑定飞书或关闭「Claude 提问」通知时不代答，回落到 Claude Code 终端继续询问。

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

Claude Code 插件在 `plugins/claude/agent-remote/`，由仓库根目录的 `.claude-plugin/marketplace.json` 发布；Codex 插件在 `plugins/codex/agent-remote/`，由仓库根目录的 `.agents/plugins/marketplace.json` 发布。本地试装 Claude 插件：`claude plugin marketplace add . && claude plugin install agent-remote@agent-remote`。改完 Codex 插件后，开发安装要按 Codex 的 cachebuster + 重装流程刷新缓存。

MIT License.
