import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";
import type { Response } from "express";

@Catch(HttpException)
export class RetryAfterFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const status = exception.getStatus();
    const body = exception.getResponse();
    const retryAfter =
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof body.error === "object" &&
      body.error !== null &&
      "retryAfter" in body.error &&
      typeof body.error.retryAfter === "number"
        ? body.error.retryAfter
        : null;
    if (retryAfter !== null) response.setHeader("Retry-After", String(retryAfter));
    response.status(status).json(body);
  }
}
