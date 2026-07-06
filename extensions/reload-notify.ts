/**
 * Reload Notify Extension — reload 完成后注入确认消息
 *
 * 监听 session_start 事件，当 reason === "reload" 时注入紫色框体通知。
 * 使用 sendMessage（custom message），不会触发 LLM 对话。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (event) => {
    if (event.reason === "reload") {
      pi.sendMessage(
        {
          customType: "reload",
          content: "扩展已通过 /reload 重新加载",
          display: true,
        },
        { deliverAs: "followUp" },
      );
    }
  });
}
