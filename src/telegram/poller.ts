import { api } from "./api";

export async function startPolling(handler: (update: any) => Promise<void>) {
  let offset = 0;
  console.log("Telegram polling started");

  while (true) {
    try {
      const res = await api("getUpdates", {
        offset,
        timeout: 30,
        allowed_updates: ["message", "callback_query"],
      });
      if (res.ok && res.result) {
        for (const update of res.result) {
          offset = update.update_id + 1;

          if (update.callback_query) {
            // Callback queries must be handled synchronously (they resolve permission promises)
            try {
              await handler(update);
            } catch (err) {
              console.error("Callback handler error:", err);
            }
          } else {
            // Messages run in background so polling continues (permissions need callback_query)
            handler(update).catch((err) => {
              console.error("Handler error:", err);
            });
          }
        }
      }
    } catch (err) {
      console.error("Polling error:", err);
      await Bun.sleep(1000);
    }
  }
}
