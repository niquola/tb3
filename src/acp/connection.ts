import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
} from "@agentclientprotocol/sdk";
import type { Client } from "@agentclientprotocol/sdk";
import type { AgentType, AgentHandle } from "./types";

// Strip env vars that prevent nested Claude Code sessions
function cleanEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_SESSION;
  return env;
}

const AGENT_COMMANDS: Record<AgentType, { command: string; args: string[] }> = {
  claude: {
    command: "claude-agent-acp",
    args: [],
  },
  codex: {
    command: "codex",
    args: ["app-server", "--listen", "stdio://"],
  },
};

export async function spawnAgent(
  agentType: AgentType,
  cwd: string,
  clientImpl: Client
): Promise<AgentHandle> {
  const { command, args } = AGENT_COMMANDS[agentType];

  console.log(`[acp] spawning ${agentType}: ${command} ${args.join(" ")} in ${cwd}`);

  const proc = spawn(command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    cwd,
    env: cleanEnv(),
  });

  proc.stderr?.on("data", (chunk: Buffer) => {
    const line = chunk.toString().trim();
    if (line) console.error(`[${agentType} stderr] ${line}`);
  });

  if (!proc.stdin || !proc.stdout) {
    throw new Error("Failed to create ACP stdio pipes");
  }

  const input = Writable.toWeb(proc.stdin);
  const output = Readable.toWeb(proc.stdout) as unknown as ReadableStream<Uint8Array>;
  const stream = ndJsonStream(input, output);

  const connection = new ClientSideConnection(
    () => clientImpl,
    stream
  );

  console.log(`[acp] initializing ${agentType}`);
  await connection.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
    },
    clientInfo: { name: "tb3-telegram-bot", version: "1.0.0" },
  });

  console.log(`[acp] creating session for ${agentType} in ${cwd}`);
  const session = await connection.newSession({
    cwd,
    mcpServers: [],
  });

  console.log(`[acp] session created: ${session.sessionId}`);

  return {
    connection,
    process: proc,
    sessionId: session.sessionId,
    agentType,
    cwd,
    callbacksRef: { current: null as any },
  };
}

export async function loadExistingSession(
  agentType: AgentType,
  cwd: string,
  savedSessionId: string,
  clientImpl: Client
): Promise<AgentHandle> {
  const { command, args } = AGENT_COMMANDS[agentType];

  console.log(`[acp] spawning ${agentType} for session restore: ${savedSessionId}`);

  const proc = spawn(command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    cwd,
    env: cleanEnv(),
  });

  proc.stderr?.on("data", (chunk: Buffer) => {
    const line = chunk.toString().trim();
    if (line) console.error(`[${agentType} stderr] ${line}`);
  });

  if (!proc.stdin || !proc.stdout) {
    throw new Error("Failed to create ACP stdio pipes");
  }

  const input = Writable.toWeb(proc.stdin);
  const output = Readable.toWeb(proc.stdout) as unknown as ReadableStream<Uint8Array>;
  const stream = ndJsonStream(input, output);

  const connection = new ClientSideConnection(
    () => clientImpl,
    stream
  );

  await connection.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
    },
    clientInfo: { name: "tb3-telegram-bot", version: "1.0.0" },
  });

  // Try loadSession first, then resumeSession, then newSession
  let sessionId: string;

  try {
    console.log(`[acp] trying loadSession: ${savedSessionId}`);
    await connection.loadSession({
      sessionId: savedSessionId,
      cwd,
      mcpServers: [],
    });
    // loadSession response doesn't include sessionId — use the one we passed in
    sessionId = savedSessionId;
    console.log(`[acp] loadSession succeeded: ${sessionId}`);
  } catch (loadErr) {
    console.log(`[acp] loadSession failed, trying resumeSession:`, loadErr);
    try {
      await connection.unstable_resumeSession({
        sessionId: savedSessionId,
        cwd,
        mcpServers: [],
      });
      sessionId = savedSessionId;
      console.log(`[acp] resumeSession succeeded: ${sessionId}`);
    } catch (resumeErr) {
      console.log(`[acp] resumeSession failed, creating new session:`, resumeErr);
      const newSess = await connection.newSession({
        cwd,
        mcpServers: [],
      });
      sessionId = newSess.sessionId;
      console.log(`[acp] new session created: ${sessionId}`);
    }
  }

  return {
    connection,
    process: proc,
    sessionId,
    agentType,
    cwd,
    callbacksRef: { current: null as any },
  };
}
