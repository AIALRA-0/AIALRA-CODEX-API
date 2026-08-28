import { BadRequestException } from "@nestjs/common";
import type { ZodError } from "zod";

export function zodHttpError(error: ZodError): BadRequestException {
  const unsupported = error.issues.some((issue) => issue.code === "unrecognized_keys");
  return new BadRequestException({
    error: {
      code: unsupported ? "unsupported_parameter" : "invalid_request",
      message: unsupported
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
