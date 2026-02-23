import type {
  Client,
  SessionNotification,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import type { CallbacksRef } from "./types";

export function createClientHandler(ref: CallbacksRef): Client {
  return {
    async sessionUpdate(params: SessionNotification): Promise<void> {
      const update = params.update as any;

      const updateType = update.sessionUpdate;
      if (!updateType) return;

      switch (updateType) {
        case "agent_message_chunk": {
          const text = update.content?.text;
          if (text) {
            await ref.current.onTextChunk(text);
          }
          break;
        }
        case "tool_call": {
          console.log(`[acp] tool_call: ${update.title} (${update.kind}) [${update.status}]`);
          await ref.current.onToolCall({
            toolCallId: update.toolCallId,
            title: update.title ?? "tool",
            kind: update.kind,
            status: update.status,
            rawInput: update.rawInput,
            rawOutput: update.rawOutput,
            content: update.content,
          });
          break;
        }
        case "tool_call_update": {
          console.log(`[acp] tool_update: ${update.toolCallId} [${update.status}] ${update.title || ""}`);
          await ref.current.onToolCallUpdate({
            toolCallId: update.toolCallId,
            title: update.title,
            kind: update.kind,
            status: update.status,
            rawInput: update.rawInput,
            rawOutput: update.rawOutput,
            content: update.content,
          });
          break;
        }
        default:
          break;
      }
    },

    async requestPermission(
      params: RequestPermissionRequest
    ): Promise<RequestPermissionResponse> {
      console.log(`[acp] permission:`, JSON.stringify(params, null, 2));
      return ref.current.onPermissionRequest(params);
    },
  };
}
