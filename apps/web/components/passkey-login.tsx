"use client";

import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { useState } from "react";

async function postJson(path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`/api/router${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) {
    throw new Error(value.error?.message ?? "身份验证失败");
  }
  return value;
}

export function PasskeyLogin({ returnTo }: { returnTo: string }) {
  const [email, setEmail] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function loginWithPasskey() {
    setBusy(true);
    setError("");
    try {
      const challenge = await postJson("/auth/passkey/login/options", { email });
      const credential = await startAuthentication({ optionsJSON: challenge.options });
      await postJson("/auth/passkey/login/verify", {
        challengeId: challenge.challengeId,
        response: credential,
      });
      window.location.assign(returnTo);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "身份验证失败");
    } finally {
      setBusy(false);
    }
  }

  async function loginWithRecoveryCode() {
    setBusy(true);
    setError("");
    try {
      await postJson("/auth/recovery/login", { email, code: recoveryCode });
      window.location.assign(returnTo);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "恢复码登录失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="form-stack">
      <div className="field">
        <label htmlFor="email">管理员邮箱</label>
        <input
          id="email"
          type="email"
          autoComplete="username webauthn"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </div>
      <button
        className="button primary"
        type="button"
        disabled={busy || !email}
        onClick={loginWithPasskey}
      >
        使用 Passkey 登录
      </button>
      <div className="field">
        <label htmlFor="recovery">一次性恢复码</label>
        <input
          id="recovery"
          autoComplete="one-time-code"
          value={recoveryCode}
          onChange={(event) => setRecoveryCode(event.target.value)}
        />
      </div>
      <button
        className="button"
        type="button"
        disabled={busy || !email || !recoveryCode}
        onClick={loginWithRecoveryCode}
      >
        使用恢复码登录
      </button>
      {error ? (
        <p className="error-message" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function PasskeySetup() {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("AIALRA 管理员");
  const [bootstrapToken, setBootstrapToken] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function register() {
    setBusy(true);
    setError("");
    try {
      const headers = { "x-bootstrap-token": bootstrapToken };
      const challenge = await postJson(
        "/auth/passkey/register/options",
        { email, displayName },
        headers,
      );
      const credential = await startRegistration({ optionsJSON: challenge.options });
      const verified = await postJson(
        "/auth/passkey/register/verify",
        { challengeId: challenge.challengeId, response: credential },
        headers,
      );
      setRecoveryCodes(verified.recoveryCodes ?? []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "注册失败");
    } finally {
      setBusy(false);
    }
  }

  if (recoveryCodes.length) {
    return (
      <div>
        <h2>离线保存恢复码</h2>
        <p className="muted">每个恢复码只能使用 1 次，离开本页后不会再次显示</p>
        <pre className="code-panel">{recoveryCodes.join("\n")}</pre>
        <a className="button primary" href="/console">
          打开控制台
        </a>
      </div>
    );
  }

  return (
    <div className="form-stack">
      <div className="field">
        <label htmlFor="setup-email">管理员邮箱</label>
        <input
          id="setup-email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="display-name">显示名称</label>
        <input
          id="display-name"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="bootstrap-token">初始化令牌</label>
        <input
          id="bootstrap-token"
          type="password"
          value={bootstrapToken}
          onChange={(event) => setBootstrapToken(event.target.value)}
        />
      </div>
      <button
        className="button primary"
        type="button"
        disabled={busy || !email || !bootstrapToken}
        onClick={register}
      >
        注册第一个 Passkey
      </button>
      {error ? (
        <p className="error-message" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
