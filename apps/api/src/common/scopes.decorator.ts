import { SetMetadata } from "@nestjs/common";

export const REQUIRED_SCOPES = "requiredScopes";
export const RequireScopes = (...scopes: string[]) => SetMetadata(REQUIRED_SCOPES, scopes);
