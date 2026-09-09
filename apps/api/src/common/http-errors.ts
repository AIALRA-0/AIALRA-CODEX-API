import { BadRequestException } from "@nestjs/common";
import type { ZodError } from "zod";

export function zodHttpError(error: ZodError): BadRequestException {
  const unsupported = error.issues.some((issue) => issue.code === "unrecognized_keys");
  const deepResearchAcknowledgementRequired = error.issues.some((issue) =>
    issue.message.includes("Deep Research requires a fresh persistent ChatGPT conversation"),
  );
  const persistentChatDisabled = error.issues.some((issue) =>
    issue.message.includes("Chat and search require a new non-personalized Temporary Chat"),
  );
  const webSessionUnsupported = error.issues.some(
    (issue) =>
      issue.path.at(-1) === "sessionKey" &&
      issue.message.includes("does not support resumable Router sessions"),
  );
  return new BadRequestException({
    error: {
      code: deepResearchAcknowledgementRequired
        ? "deep_research_persistence_acknowledgement_required"
        : persistentChatDisabled
          ? "persistent_chat_disabled"
          : webSessionUnsupported
            ? "web_session_not_supported"
            : unsupported
              ? "unsupported_parameter"
              : "invalid_request",
      message: deepResearchAcknowledgementRequired
        ? "Deep Research 会创建可保留在 ChatGPT 历史记录中的新普通会话；调用方必须显式确认该数据留存风险"
        : persistentChatDisabled
          ? "普通聊天和网页搜索每次调用都必须使用新的非个性化临时对话"
          : webSessionUnsupported
            ? "ChatGPT 网页通道不支持继续使用 Router 会话"
            : unsupported
              ? "The request contains a parameter that this API subset does not support."
              : "The request does not match the published contract.",
      details: error.issues.map((issue) => ({
        path: issue.path.join("."),
        code: issue.code,
        message: issue.message,
      })),
    },
  });
}
