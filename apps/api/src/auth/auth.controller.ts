import {
  Body,
  Controller,
  Headers,
  Inject,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { randomBytes, randomUUID } from "node:crypto";

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";

import type {
  AuthChallenge,
  AuthSession,
  IdentityUser,
  JobRepository,
  RecoveryCodeRecord,
  StoredPasskey,
} from "@aialra/persistence";
import { hashApiKey } from "@aialra/security";

import { PublicRoute } from "../common/public.decorator.js";
import { JOB_REPOSITORY } from "../tokens.js";

function authenticationConfiguration() {
  const rpId = process.env.WEBAUTHN_RP_ID;
  const origin = process.env.WEBAUTHN_ORIGIN;
  const sessionPepper = process.env.SESSION_PEPPER;
  if (!rpId || !origin || !sessionPepper) {
    throw new Error("WEBAUTHN_RP_ID, WEBAUTHN_ORIGIN, and SESSION_PEPPER are required");
  }
  return { rpId, origin, sessionPepper };
}

@Controller("auth")
export class AuthController {
  constructor(@Inject(JOB_REPOSITORY) private readonly repository: JobRepository) {}

  private verifyBootstrap(token?: string): void {
    if (!process.env.BOOTSTRAP_ADMIN_TOKEN || token !== process.env.BOOTSTRAP_ADMIN_TOKEN) {
      throw new UnauthorizedException({
        error: { code: "bootstrap_unavailable", message: "Passkey bootstrap is unavailable." },
      });
    }
  }

  private async issueSession(userId: string, response: Response): Promise<void> {
    const { sessionPepper } = authenticationConfiguration();
    const token = randomBytes(32).toString("base64url");
    const session: AuthSession = {
      id: randomUUID(),
      userId,
      digest: hashApiKey(token, sessionPepper),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1_000).toISOString(),
    };
    await this.repository.createSession(session);
    response.cookie("amr_session", token, {
      httpOnly: true,
      secure:
        process.env.SESSION_COOKIE_SECURE !== "false" && process.env.NODE_ENV !== "development",
      sameSite: "strict",
      path: "/",
      maxAge: 12 * 60 * 60 * 1_000,
    });
  }

  private async assertAuthRateLimit(subject: string): Promise<void> {
    if (!(await this.repository.consumeRateLimit(`auth:${subject}`, 10, new Date()))) {
      throw new UnauthorizedException({
        error: { code: "authentication_failed", message: "Authentication failed." },
      });
    }
  }

  @PublicRoute()
  @Post("passkey/register/options")
  async registrationOptions(
    @Body() body: { email?: string; displayName?: string },
    @Headers("x-bootstrap-token") bootstrapToken?: string,
  ) {
    this.verifyBootstrap(bootstrapToken);
    if (!body.email) {
      throw new UnauthorizedException({
        error: { code: "bootstrap_unavailable", message: "Passkey bootstrap is unavailable." },
      });
    }
    const normalizedEmail = body.email.toLowerCase();
    const existingUser = await this.repository.findUserByEmail(normalizedEmail);
    if (
      ((await this.repository.userCount()) > 0 && !existingUser) ||
      (existingUser && (await this.repository.passkeysForUser(existingUser.id)).length > 0)
    ) {
      throw new UnauthorizedException({
        error: { code: "bootstrap_unavailable", message: "Passkey bootstrap is unavailable." },
      });
    }
    const { rpId } = authenticationConfiguration();
    const user: IdentityUser =
      existingUser ??
      ({
        id: randomUUID(),
        email: normalizedEmail,
        displayName: body.displayName?.slice(0, 100) || "AIALRA Administrator",
        createdAt: new Date().toISOString(),
      } satisfies IdentityUser);
    if (!existingUser) {
      await this.repository.createUser(user);
    }
    const options = await generateRegistrationOptions({
      rpName: "AIALRA Model Router",
      rpID: rpId,
      userName: user.email,
      userDisplayName: user.displayName,
      userID: new TextEncoder().encode(user.id),
      attestationType: "none",
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
      },
    });
    const challengeId = randomUUID();
    const challenge: AuthChallenge = {
      id: challengeId,
      userId: user.id,
      purpose: "registration",
      challenge: options.challenge,
      expiresAt: new Date(Date.now() + 5 * 60 * 1_000).toISOString(),
      usedAt: null,
    };
    await this.repository.createChallenge(challenge);
    return { challengeId, options };
  }

  @PublicRoute()
  @Post("passkey/register/verify")
  async verifyRegistration(
    @Body() body: { challengeId?: string; response?: RegistrationResponseJSON },
    @Headers("x-bootstrap-token") bootstrapToken: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.verifyBootstrap(bootstrapToken);
    if (!body.challengeId || !body.response) {
      throw new UnauthorizedException();
    }
    const challenge = await this.repository.consumeChallenge(body.challengeId);
    if (!challenge || challenge.purpose !== "registration") {
      throw new UnauthorizedException();
    }
    const { rpId, origin, sessionPepper } = authenticationConfiguration();
    const verification = await verifyRegistrationResponse({
      response: body.response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: origin,
      expectedRPID: rpId,
      requireUserVerification: true,
    });
    if (!verification.verified) {
      throw new UnauthorizedException();
    }
    const credential = verification.registrationInfo.credential;
    const passkey: StoredPasskey = {
      id: randomUUID(),
      userId: challenge.userId,
      credentialId: credential.id,
      publicKeyBase64: Buffer.from(credential.publicKey).toString("base64"),
      counter: credential.counter,
      transports: credential.transports ?? [],
      deviceType: verification.registrationInfo.credentialDeviceType,
      backedUp: verification.registrationInfo.credentialBackedUp,
      createdAt: new Date().toISOString(),
    };
    await this.repository.createPasskey(passkey);

    const recoveryCodes = Array.from(
      { length: 10 },
      () =>
        randomBytes(10)
          .toString("hex")
          .match(/.{1,5}/g)
          ?.join("-") ?? "",
    );
    const records: RecoveryCodeRecord[] = recoveryCodes.map((code) => ({
      id: randomUUID(),
      userId: challenge.userId,
      digest: hashApiKey(code, sessionPepper),
      createdAt: new Date().toISOString(),
      usedAt: null,
    }));
    await this.repository.createRecoveryCodes(records);
    await this.issueSession(challenge.userId, response);
    return { verified: true, recoveryCodes };
  }

  @PublicRoute()
  @Post("passkey/login/options")
  async loginOptions(@Body() body: { email?: string }) {
    await this.assertAuthRateLimit(body.email?.toLowerCase() ?? "missing-email");
    if (!body.email) {
      throw new UnauthorizedException();
    }
    const user = await this.repository.findUserByEmail(body.email.toLowerCase());
    if (!user) {
      throw new UnauthorizedException();
    }
    const passkeys = await this.repository.passkeysForUser(user.id);
    const { rpId } = authenticationConfiguration();
    const options = await generateAuthenticationOptions({
      rpID: rpId,
      userVerification: "required",
      allowCredentials: passkeys.map((passkey) => ({
        id: passkey.credentialId,
        transports: passkey.transports as never,
      })),
    });
    const challengeId = randomUUID();
    await this.repository.createChallenge({
      id: challengeId,
      userId: user.id,
      purpose: "authentication",
      challenge: options.challenge,
      expiresAt: new Date(Date.now() + 5 * 60 * 1_000).toISOString(),
      usedAt: null,
    });
    return { challengeId, options };
  }

  @PublicRoute()
  @Post("passkey/login/verify")
  async verifyLogin(
    @Body() body: { challengeId?: string; response?: AuthenticationResponseJSON },
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.assertAuthRateLimit(body.challengeId ?? "missing-challenge");
    if (!body.challengeId || !body.response) {
      throw new UnauthorizedException();
    }
    const challenge = await this.repository.consumeChallenge(body.challengeId);
    const passkey = await this.repository.findPasskey(body.response.id);
    if (
      !challenge ||
      challenge.purpose !== "authentication" ||
      !passkey ||
      passkey.userId !== challenge.userId
    ) {
      throw new UnauthorizedException();
    }
    const { rpId, origin } = authenticationConfiguration();
    const verification = await verifyAuthenticationResponse({
      response: body.response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: origin,
      expectedRPID: rpId,
      credential: {
        id: passkey.credentialId,
        publicKey: Buffer.from(passkey.publicKeyBase64, "base64"),
        counter: passkey.counter,
        transports: passkey.transports as never,
      },
      requireUserVerification: true,
    });
    if (!verification.verified) {
      throw new UnauthorizedException();
    }
    await this.repository.updatePasskeyCounter(
      passkey.id,
      verification.authenticationInfo.newCounter,
    );
    await this.issueSession(challenge.userId, response);
    return { verified: true };
  }

  @PublicRoute()
  @Post("recovery/login")
  async recoveryLogin(
    @Body() body: { email?: string; code?: string },
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.assertAuthRateLimit(body.email?.toLowerCase() ?? "missing-email");
    if (!body.email || !body.code) {
      throw new UnauthorizedException();
    }
    const user = await this.repository.findUserByEmail(body.email.toLowerCase());
    if (!user) {
      throw new UnauthorizedException();
    }
    const { sessionPepper } = authenticationConfiguration();
    const accepted = await this.repository.consumeRecoveryCode(
      user.id,
      hashApiKey(body.code, sessionPepper),
    );
    if (!accepted) {
      throw new UnauthorizedException();
    }
    await this.issueSession(user.id, response);
    return { verified: true, recoveryCodeConsumed: true };
  }

  @Post("logout")
  async logout(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const token = request.headers.cookie
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("amr_session="))
      ?.slice("amr_session=".length);
    const { sessionPepper } = authenticationConfiguration();
    if (token) await this.repository.deleteSessionByDigest(hashApiKey(token, sessionPepper));
    response.clearCookie("amr_session", {
      httpOnly: true,
      secure:
        process.env.SESSION_COOKIE_SECURE !== "false" && process.env.NODE_ENV !== "development",
      sameSite: "strict",
      path: "/",
    });
    return { loggedOut: true };
  }
}
