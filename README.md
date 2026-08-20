# agent-remote

Agent 需要用户决策时，通过 MCP 工具把问题推到手机（飞书），阻塞等待用户回复，回复内容作为工具结果返回给 agent。

```
Agent ──MCP ask_user──▶ 本服务 ──卡片──▶ 飞书
                        (pending 挂起)      │ 点按钮 / 回复文本
Agent ◀──answer──────── 本服务 ◀──WS 长连接─┘
```

飞书走官方 SDK 的 WebSocket 长连接收事件，**不需要公网 IP / 域名 / 回调 URL**。可跑在本机或内网服务器。

## 飞书侧配置（一次性）

1. [飞书开放平台](https://open.feishu.cn) → 创建**企业自建应用**，拿到 `App ID` / `App Secret`
2. **应用能力 → 机器人**：启用
3. **权限管理**开通：`im:message`（发送）、`im:message:send_as_bot`、`im:chat`（可选）
4. **事件与回调 → 事件配置 → 使用长连接接收事件**（选 WS 模式），添加事件：`接收消息 im.message.receive_v1`；卡片回调同样走长连接
5. 发布版本并通过（自建应用企业管理员即自己，秒过）
6. 与机器人发起一次对话（手机上搜到 bot 随便说句话），从后台或事件日志里拿到你的 `open_id`（`ou_` 开头）填入 env

## 运行

```bash
cp .env.example .env  # 填入上面的值
docker compose up -d --build
# 或裸跑: npm install && npm start (需自行加载 .env 到环境)
```

## 接给 Claude Code

用命令添加（不要手改配置文件）。全局可用（所有项目）：

```bash
claude mcp add -s user -t http agent-remote http://127.0.0.1:3000/mcp \
  --header "Authorization: Bearer <MCP_TOKEN>"
```

只给某个项目用，去掉 `-s user`（默认 local scope）。

注意：`--header` 是 variadic 参数，必须放在 URL **后面**，否则 URL 会被当成第二个 header 值。

agent 等待回复的时间较长，客户端工具超时要调大（默认 30s 会提前砍掉调用）：

```bash
export MCP_TOOL_TIMEOUT=1200000   # 20 分钟, 单位 ms
```

## Claude Code hook 通知（可选）

agent 干完活或需要你时推一条消息到手机。在 `~/.claude/settings.json`（或项目 `.claude/settings.json`）加：

```json
{
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "webhook", "url": "http://127.0.0.1:3000/claude", "headers": { "Authorization": "Bearer <MCP_TOKEN>" } }] }],
    "Notification": [{ "hooks": [{ "type": "webhook", "url": "http://127.0.0.1:3000/claude", "headers": { "Authorization": "Bearer <MCP_TOKEN>" } }] }]
  }
}
```

监听的事件：`Stop`（任务完成）、`Notification`（等待输入/权限确认）、`SessionEnd`（会话结束）。其他事件 POST 过来会被忽略，不会刷屏。标题带项目目录名，多项目并行时能分清是谁。

## 工具

**`ask_user(question, options?, timeout_minutes=10)`**

- 有 `options` → 手机上渲染按钮，点选即回
- 无（开放性问题）→ 卡片提示回复格式，用户**引用该消息**回复或带 `#tag` 前缀回复
- 超时 → 返回 `{"timeout": true}`，agent 自行决定默认行为
- 决策完成后卡片自动变为绿色（已回复）/ 灰色（超时）

## 多客户端跟踪

多个 agent 客户端同时使用时，每个客户端发**自己的 token**，卡片会标注来源、回复精确路由：

```
CLIENT_TOKENS="laptop:token_a,ci:token_b"
```

- token → 客户端名在服务端映射，卡片标题显示 `🤖 laptop 需要你的决策`，不依赖 agent 自报身份
- 开放性问题的回复路由三级匹配：`#tag`（卡片上的 4 位前缀，精确）→ 引用回复（精确）→ 仅剩一条无选项 pending 时兜底
- 多条并行且都没带 tag/引用时**不猜**，会回一张红色提示卡让你补 tag——猜错会把回复送进错误的 agent 会话

各客户端接入时 `--header` 里带自己的 token 即可。

## Claude Code hook 通知（可选）

## 测试

```bash
npm test   # 纯逻辑自检: pending 生命周期 / 匹配规则 / 卡片构造
```
