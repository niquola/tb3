# tb3

Telegram bot for Claude Code & Codex via [ACP](https://github.com/nichochar/agent-client-protocol) (Agent Client Protocol).

Each Telegram thread maps to a working directory with its own agent session. Messages are routed to Claude Code or Codex agents over ACP's stdio JSON-RPC protocol.

## Setup

```bash
bun install
```

Create `.env`:

```
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_ALLOWED_USER=your-telegram-user-id
HTTP_PORT=3034
```

## Run

```bash
bun src/index.ts
```

## Commands

| Command | Description |
|---------|-------------|
| `/claude <path>` | Start Claude agent (e.g. `/claude health`, `/claude ~/myrepo`, `/claude system`) |
| `/codex <path>` | Start Codex agent |
| `/mode` | Set agent mode (default, plan, acceptEdits, bypassPermissions) |
| `/model` | Set model (Opus 4.6, Sonnet 4.6, Haiku 4.5) |
| `/clear` | Kill current agent session |
| `/cancel` | Cancel running prompt |

## API

HTTP API on `:3034` for agent skills and integrations:

- `POST /api/send` — send text message to thread
- `POST /api/send-file` — send file to thread
- `POST /api/prompt` — trigger agent prompt
- `POST /api/cron` — schedule recurring agent prompt
- `GET /api/crons` — list crons
- `DELETE /api/cron/:id` — remove cron

See [CLAUDE.md](CLAUDE.md) for full architecture docs.
