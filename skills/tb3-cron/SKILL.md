---
name: tb3-cron
description: Schedule recurring messages to Telegram on a cron schedule. Use when the agent needs to set up periodic notifications, reminders, or scheduled reports.
allowed-tools: Bash(curl *)
user-invocable: false
---

# tb3-cron — Schedule Telegram Messages

Schedule recurring messages to the Telegram chat linked to the current workdir.

The bot runs at `http://localhost:3034`. Uses standard cron expressions.

## Create a scheduled message

```bash
# Every day at 9:00
curl -s -X POST http://localhost:3034/api/cron \
  -H 'Content-Type: application/json' \
  -d "{\"name\": \"daily-standup\", \"cron\": \"0 9 * * *\", \"text\": \"Time for daily standup!\", \"workdir\": \"$PWD\"}"

# Every hour
curl -s -X POST http://localhost:3034/api/cron \
  -H 'Content-Type: application/json' \
  -d "{\"name\": \"hourly-check\", \"cron\": \"0 * * * *\", \"text\": \"Hourly check\", \"workdir\": \"$PWD\"}"

# Every Monday at 10:00
curl -s -X POST http://localhost:3034/api/cron \
  -H 'Content-Type: application/json' \
  -d "{\"name\": \"weekly-report\", \"cron\": \"0 10 * * 1\", \"text\": \"Weekly report time\", \"workdir\": \"$PWD\"}"

# Every 5 minutes
curl -s -X POST http://localhost:3034/api/cron \
  -H 'Content-Type: application/json' \
  -d "{\"name\": \"ping\", \"cron\": \"*/5 * * * *\", \"text\": \"ping\", \"workdir\": \"$PWD\"}"
```

## List all active crons

```bash
curl -s http://localhost:3034/api/crons | jq .
```

## Remove a cron by name

```bash
curl -s -X DELETE http://localhost:3034/api/cron/daily-standup
```

## Cron expression format

```
┌───────────── minute (0-59)
│ ┌───────────── hour (0-23)
│ │ ┌───────────── day of month (1-31)
│ │ │ ┌───────────── month (1-12)
│ │ │ │ ┌───────────── day of week (0-7, 0=Sun)
│ │ │ │ │
* * * * *
```

Examples:
- `0 9 * * *` — every day at 9:00
- `0 9 * * 1-5` — weekdays at 9:00
- `*/30 * * * *` — every 30 minutes
- `0 */2 * * *` — every 2 hours
- `0 10 * * 1` — every Monday at 10:00
- `0 0 1 * *` — first day of each month

Crons persist across bot restarts (saved to `.crons.json`).
