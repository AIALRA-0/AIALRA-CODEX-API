import { BadRequestException } from "@nestjs/common";
import type { ZodError } from "zod";

export function zodHttpError(error: ZodError): BadRequestException {
  const unsupported = error.issues.some((issue) => issue.code === "unrecognized_keys");
  const persistentChatDisabled = error.issues.some((issue) =>
    issue.message.includes("requires a new non-personalized Temporary Chat"),
  );
  const webSessionUnsupported = error.issues.some(
    (issue) =>
      issue.path.at(-1) === "sessionKey" &&
      issue.message.includes("does not support resumable Router sessions"),
  );
  return new BadRequestException({
    error: {
      code: persistentChatDisabled
        ? "persistent_chat_disabled"
        : webSessionUnsupported
          ? "web_session_not_supported"
          : unsupported
            ? "unsupported_parameter"
            : "invalid_request",
      message: persistentChatDisabled
        ? "ChatGPT 网页通道每次调用都必须使用新的非个性化临时对话"
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
