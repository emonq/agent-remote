# agent-remote

Agent 需要用户决策时，通过 MCP 工具把问题推到手机（飞书/Lark），阻塞等待用户回复，回复内容作为工具结果返回给 agent。

```
Agent ──MCP ask_user──▶ 本服务 ──卡片──▶ 飞书
                        (pending 挂起)      │ 点按钮 / 引用回复
Agent ◀──answer──────── 本服务 ◀──WS 长连接─┘
```

飞书走官方 SDK 的 WebSocket 长连接收事件，**不需要公网 IP / 域名 / 回调 URL**，可跑在本机或内网。

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

```bash
claude mcp add -s user -t http agent-remote http://127.0.0.1:3000/mcp \
  --header "Authorization: Bearer <MCP_TOKEN>"
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

## 多客户端跟踪（可选）

`CLIENT_TOKENS="laptop:token_a,ci:token_b"`，每个客户端带自己的 token：

- token → 客户端名服务端映射，卡片标题显示 `🤖 laptop 需要你的决策`
- 开放性问题回复按**引用**精确路由；多条并行且没带引用时不猜，回红色提示卡要求引用对应消息

## Claude Code hook 通知（可选）

在 `~/.claude/settings.json` 配置 webhook hook，agent 完成任务或需要你时推消息到手机：

```json
{
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "webhook", "url": "http://127.0.0.1:3000/claude", "headers": { "Authorization": "Bearer <MCP_TOKEN>" } }] }],
    "Notification": [{ "hooks": [{ "type": "webhook", "url": "http://127.0.0.1:3000/claude", "headers": { "Authorization": "Bearer <MCP_TOKEN>" } }] }]
  }
}
```

`Stop`（任务完成）、`Notification`（等待输入/权限确认）、`SessionEnd`（会话结束），其他事件忽略。标题带项目目录名，多项目并行能分清。

## 开发

```bash
npm test   # 纯逻辑自检: pending 生命周期 / 匹配规则 / 卡片构造
```

MIT License.
