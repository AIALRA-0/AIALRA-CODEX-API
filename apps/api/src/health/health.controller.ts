import { Controller, Get } from "@nestjs/common";

import { PublicRoute } from "../common/public.decorator.js";

@Controller()
export class HealthController {
  @PublicRoute()
  @Get("healthz")
  health() {
    return { status: "ok", service: "aialra-model-router-api" };
  }

  @PublicRoute()
  @Get("readyz")
  ready() {
    return { status: "ready", service: "aialra-model-router-api" };
  }
}
