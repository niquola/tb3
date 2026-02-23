---
name: tb3-send
description: Send messages and files to the Telegram chat linked to this thread. Use when the agent needs to send a file, image, report, or notification to the user in Telegram.
allowed-tools: Bash(curl *)
user-invocable: false
---

# tb3-send — Send to Telegram

Send messages and files to the Telegram chat associated with the current working directory.

The bot runs at `http://localhost:3034`. It resolves the chat from your `$PWD`.

## Send a text message

```bash
curl -s -X POST http://localhost:3034/api/send \
  -H 'Content-Type: application/json' \
  -d "{\"text\": \"Hello from agent!\", \"workdir\": \"$PWD\"}"
```

## Send a file

```bash
curl -s -X POST http://localhost:3034/api/send-file \
  -H 'Content-Type: application/json' \
  -d "{\"file_path\": \"/path/to/report.pdf\", \"workdir\": \"$PWD\", \"caption\": \"Here is the report\"}"
```

Or with multipart form:

```bash
curl -s -X POST http://localhost:3034/api/send-file \
  -F "file=@/path/to/file.csv" \
  -F "workdir=$PWD" \
  -F "caption=Data export"
```

## Check which thread this workdir belongs to

```bash
curl -s "http://localhost:3034/api/thread?workdir=$PWD" | jq .
```
