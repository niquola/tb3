# tb3 — Telegram Bot for Claude Code & Codex via ACP

Telegram bot that acts as an ACP (Agent Client Protocol) client, connecting to Claude Code and Codex as coding agents. Each Telegram thread maps to a working directory with its own agent session. Users interact via threaded Telegram conversations, and the bot routes messages to the selected agent via ACP's stdio JSON-RPC protocol.

## Architecture

```
Telegram User (private DM with topics)
    ↕ (Bot API long-polling)
Telegram Handler (src/telegram/)
    ↕
Session Manager (src/acp/session-manager.ts)
    ↕ (stdio JSON-RPC via ACP SDK)
┌─────────────────────┬──────────────────────┐
│  claude-agent-acp   │  codex app-server    │
│  (child process)    │  (child process)     │
└─────────────────────┴──────────────────────┘
```

- **Private DM only** — bot ignores group chats
- **One agent process per thread** — isolated cwd, killed on `/clear`
- **Session persistence** — session IDs saved to `threads/.state.json`, restored on restart via ACP `loadSession`
- **HTTP API** on `:3034` — agents call back to send files, schedule crons

## Running

```sh
bun src/index.ts
```

Uses Bun runtime. Loads `.env` automatically (no dotenv).

### Environment Variables

- `TELEGRAM_BOT_TOKEN` — required
- `TELEGRAM_ALLOWED_USER` — Telegram user ID for auth (single-user bot)
- `HTTP_PORT` — HTTP API port (default: 3034)

## Project Structure

```
src/
├── index.ts                 # Entry point: load state, register commands, start polling
├── store.ts                 # File-based state (threads/.state.json) — thread configs, sessions, prefs
├── http-api.ts              # REST API for skills + cron scheduler (croner)
├── telegram/
│   ├── api.ts               # Telegram Bot API wrapper (fetch-based)
│   ├── send.ts              # Message formatting (MarkdownV2 via telegram-markdown-v2)
│   ├── poller.ts            # Long-polling loop (30s timeout)
│   └── handler.ts           # Message routing, commands, streaming display, permissions
└── acp/
    ├── types.ts             # AgentHandle, SessionInfo, SessionCallbacks, ToolCallInfo
    ├── connection.ts        # Spawn agent process + ACP handshake (initialize, newSession, loadSession)
    ├── client-handler.ts    # ACP Client impl — routes sessionUpdate/requestPermission to callbacks
    └── session-manager.ts   # Map threads → live agents, prompt routing, mode/model management

skills/                      # Shared skills (symlinked into each thread's .claude/skills/)
├── tb3-send/SKILL.md        # Skill for agents to send messages/files to Telegram
└── tb3-cron/SKILL.md        # Skill for agents to schedule cron jobs

threads/                     # Per-thread working directories (gitignored)
├── .state.json              # All thread state (configs, session IDs, active flag, mode/model prefs)
├── .messages.jsonl          # Message log (append-only)
├── .crons.json              # Persisted cron definitions
├── health/                  # Example thread workdir
│   ├── CLAUDE.md
│   └── .claude/skills/ → ../../skills/*
└── ...
```

## Bot Commands

- `/claude <path>` — Start Claude agent with workdir (`/claude health`, `/claude ~/myrepo`, `/claude system`)
- `/codex <path>` — Start Codex agent with workdir
- `/mode [id]` — Show/set agent mode (default, acceptEdits, plan, dontAsk, bypassPermissions)
- `/model [id]` — Show/set model (default=Opus 4.6, sonnet=Sonnet 4.6, haiku=Haiku 4.5)
- `/clear` — Kill current agent session
- `/cancel` — Cancel running prompt

Path resolution: bare name → `threads/<name>`, `~/...` → home-relative, `/...` → absolute, `system` → project root.

## ACP Integration

Agents are spawned as child processes speaking ACP over stdio:
- **Claude**: `node_modules/.bin/claude-agent-acp` (wraps Claude Agent SDK)
- **Codex**: `codex app-server --listen stdio://`

Communication via `ndJsonStream` + `ClientSideConnection` from `@agentclientprotocol/sdk`.

### Session Lifecycle

1. `/claude <path>` → saves thread config, creates workdir + CLAUDE.md, links skills
2. First message → `spawnAgent()` → `initialize()` → `newSession({ cwd })` → returns `AgentHandle`
3. Subsequent messages → reuses live agent, calls `connection.prompt()`
4. On restart → `restoreAllSessions()` → spawns fresh process → `loadSession({ sessionId })` to restore history
5. `/clear` → `killAgent()` → kills process, marks inactive in state

### Streaming Display

- **TextAccumulator** — buffers `agent_message_chunk` text, debounce-flushes to Telegram every 800ms or at 3500 chars
- **ToolCallTracker** — shows tool calls as temporary messages with emoji icons, deletes on completion
- **Permissions** — `requestPermission` → inline keyboard with allow/reject, 5min auto-reject timeout
- "Allow always" → persisted to `<workdir>/.claude/settings.json`

## HTTP API (for skills/crons)

All endpoints on `http://localhost:3034`:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/api/threads` | List all threads |
| GET | `/api/thread?workdir=...` | Find thread by workdir |
| POST | `/api/send` | Send text message `{text, workdir}` |
| POST | `/api/send-file` | Send file `{file_path, workdir, caption}` |
| POST | `/api/prompt` | Trigger agent prompt `{text, workdir}` |
| POST | `/api/cron` | Schedule cron `{name, cron, text, workdir}` |
| GET | `/api/crons` | List active crons |
| DELETE | `/api/cron/:id` | Remove a cron |

## Dependencies

- `@agentclientprotocol/sdk` — ACP client SDK (ClientSideConnection, ndJsonStream)
- `@zed-industries/claude-agent-acp` — Claude Code as ACP agent (child process)
- `croner` — Cron expression scheduler
- `telegram-markdown-v2` — MarkdownV2 formatting

## State Management

Single JSON file (`threads/.state.json`) stores all state — no database. Each thread entry keyed by `"chatId:threadId"`:

```json
{
  "threads": {
    "123456:789": {
      "workdir": "/path/to/dir",
      "agent_type": "claude",
      "name": "claude:health",
      "session_id": "uuid",
      "active": true,
      "mode": "default",
      "model": "default"
    }
  }
}
```

## Bun Conventions

- Use `bun` runtime, not Node.js
- `Bun.serve()` for HTTP, `Bun.file()` for file I/O, `Bun.$` for shell commands
- No dotenv — Bun loads `.env` automatically
- `bun install` / `bun test` / `bun run`
