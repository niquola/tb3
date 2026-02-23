import type { ChildProcess } from "node:child_process";
import type { ClientSideConnection } from "@agentclientprotocol/sdk";

export type AgentType = "claude" | "codex";

export type CallbacksRef = { current: SessionCallbacks };

export type SessionInfo = {
  modes?: { availableModes: Array<{ id: string; name: string; description?: string }>; currentModeId: string };
  models?: { availableModels?: Array<{ id: string; name: string }>; currentModelId?: string };
  configOptions?: Array<any>;
};

export type AgentHandle = {
  connection: ClientSideConnection;
  process: ChildProcess;
  sessionId: string;
  agentType: AgentType;
  cwd: string;
  callbacksRef: CallbacksRef;
  sessionInfo: SessionInfo;
};

export type ToolCallInfo = {
  toolCallId: string;
  title: string;
  kind?: string;
  status?: string;
  rawInput?: any;
  rawOutput?: any;
  content?: any[];
};

export type SessionCallbacks = {
  onTextChunk: (text: string) => Promise<void>;
  onToolCall: (info: ToolCallInfo) => Promise<void>;
  onToolCallUpdate: (info: ToolCallInfo) => Promise<void>;
  onPermissionRequest: (params: any) => Promise<any>;
};
