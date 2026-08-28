import "reflect-metadata";

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { type OpenAPIObject, SwaggerModule } from "@nestjs/swagger";
import { parse } from "yaml";

import { AppModule } from "./app.module.js";

function loadSecretFiles(): void {
  for (const name of [
    "DATABASE_URL",
    "PAYLOAD_MASTER_KEY",
    "API_KEY_PEPPER",
    "SESSION_PEPPER",
    "BOOTSTRAP_ADMIN_TOKEN",
    "INTERNAL_PROXY_SECRET",
  ]) {
    const path = process.env[`${name}_FILE`];
    if (path && existsSync(path)) {
      process.env[name] = readFileSync(path, "utf8").trim();
    }
  }
}

async function bootstrap(): Promise<void> {
  loadSecretFiles();
  const app = await NestFactory.create(AppModule, { cors: false });
  app.enableShutdownHooks();
  app.setGlobalPrefix("", { exclude: ["healthz", "readyz"] });

  const openApiPath = process.env.OPENAPI_PATH ?? resolve(process.cwd(), "openapi", "openapi.yaml");
  const document = parse(readFileSync(openApiPath, "utf8")) as OpenAPIObject;
  SwaggerModule.setup("openapi", app, document, { jsonDocumentUrl: "openapi.json" });

  const port = Number(process.env.PORT ?? 13210);
  const host = process.env.HOST ?? "127.0.0.1";
  await app.listen(port, host);
  Logger.log(`AIALRA Model Router API listening on ${host}:${port}`, "Bootstrap");
}

await bootstrap();
