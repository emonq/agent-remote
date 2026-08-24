# Agent Remote for Codex

Connect Codex to Agent Remote for:

- `ask_user` and `send_file` MCP tools
- task-completion and session-end notifications
- remote permission approval from Feishu/Lark
- mobile replies that continue a completed Codex turn

## Setup

Open the Agent Remote WebUI and select **连接 Codex**. It generates a command like:

```bash
curl -fsSL "https://agent.example.com/install/codex/<ticket>" --output agent-remote-codex.tgz
tar -xzf agent-remote-codex.tgz -C <local-marketplace-directory>
codex plugin marketplace add <local-marketplace-directory> --json
codex plugin add agent-remote@agent-remote-install --json
```

The WebUI combines these transparent steps into one copyable command, with separate macOS/Linux
and Windows variants. There is no npm package, installer, or hidden setup script. The URL is
single-use and expires after ten minutes. The downloaded package contains only the service address
and install ticket, not an account API token.

Open a new Codex task after installation. The `SessionStart` hook exchanges the ticket for a
device-specific credential, atomically saves `config.json` under Codex `PLUGIN_DATA` with mode
`0600`, and deletes `bootstrap.json` from the installed package. Subsequent MCP and hook processes
read only that plugin-private config.

There are no environment-variable overrides, shared `~/.agent-remote/config.json` fallback, or
conversation-based setup tools. To reconnect, generate a new command in the WebUI and run it.

Codex currently supports `allow` and `deny` responses for `PermissionRequest`; the Claude Code
plugin's “allow and switch auto” option is intentionally not shown here.
