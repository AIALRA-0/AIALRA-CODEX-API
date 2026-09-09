# API capabilities and operational boundaries

This is a task-backed compatibility gateway, not a complete implementation of every OpenAI API parameter. Container health proves that a service is running; only a successful upstream task proves model availability at that time.

## Authentication and account selection

Codex uses the Runner's configured Codex credential directory. The `chatgpt_web` account pool uses separate browser profiles. Changing a browser account does **not** change Codex credentials. Multiple web accounts do not constitute a multi-account Codex pool.

Web administrators can PATCH an account's `priority` (integer 0–100, default 0). Higher priority is preferred **only among eligible accounts**. Busy, unqualified, disabled, cooling-down, or pacing-blocked accounts are excluded. Equal-priority accounts retain oldest-submission-first scheduling. Set the primary to 100 and overflow accounts to 0. Priority is not a subscription label and never bypasses cooldown or qualification.

Login is manual. A login or verification failure cannot safely be repaired by replaying a submitted task or copying another account's browser profile.

Temporary Chat capabilities depend on the actual account menu. A missing Deep Research entry returns `chatgpt_mode_unavailable` before sending; it does not silently fall back to ordinary chat, leave Temporary Chat, or replay the task on another account. A verified pre-send capability absence does not revoke the account's existing ordinary-chat qualification. Research is not available merely because the API schema accepts that mode.

## Request support

| Capability                  | Current implementation                                                            | Boundary                                                                                                                                |
| --------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Durable tasks               | `/api/v1/jobs`, status, result, history, events, cancellation                     | Use a stable caller-supplied `Idempotency-Key`; poll the original task after uncertain delivery                                         |
| Chat Completions            | `/v1/chat/completions`, text messages, streaming, usage option                    | Text-only compatibility subset, not tool-call or multimodal protocol compatibility                                                      |
| Responses                   | `/v1/responses`, input, instructions, reasoning effort, text format, metadata     | Gateway-specific output/event shape; not full Responses SDK interchangeability; array input is serialized into prompt text              |
| Model and reasoning         | `model`, `reasoning_effort` or `reasoning.effort`                                 | Only models/efforts actually available in the upstream runtime can succeed                                                              |
| Structured output           | JSON schema passed to Codex and validated by Worker                               | Web JSON is not upstream schema-constrained generation; `json_object` is a prompt instruction, not a guarantee                          |
| Output-token fields         | `max_tokens`, `max_completion_tokens`, `max_output_tokens` map to the task budget | The current Codex SDK/Web adapters do not pass an upstream hard generation cap; do not rely on these fields as a hard cost/output limit |
| Sessions                    | Codex persistent threads and ephemeral tasks                                      | Web always uses a new non-personalized Temporary Chat; no persistent web `session_key`                                                  |
| Runtime controls            | Permission preset, deadline, execution channel, web mode, source requirements     | Permission ceilings are enforced by the API key; unsupported parameters must not be assumed effective                                   |
| Sampling, tools, multimodal | Not implemented as public compatibility features                                  | `temperature`, `top_p`, `tools`, `tool_choice`, image/audio input, logprobs and arbitrary upstream parameters are not supported         |

Top-level unsupported compatibility fields are rejected. Nested structures must be checked against the published schema; this is not an arbitrary provider passthrough.

## Streaming

- Codex forwards SDK agent-message updates as text deltas. Update frequency is controlled by the upstream SDK; token-by-token delivery is not guaranteed.
- Web is final-only: the SSE connection can stay open during generation, but the text arrives after validated completion. Heartbeat comments are not model tokens.
- Both compatibility streams send heartbeat comments every 15 seconds and disable reverse-proxy buffering. Disconnection stops local event polling, **not** the durable task; use its original idempotency key/job ID to retrieve the result, never invent a replacement request.
- Event polling drains again after observing a terminal job to avoid losing final output committed between queries. A successful final-only result is emitted when no text delta was received.
- Once an SSE response starts, later provider errors are stream events, not a replacement HTTP status. Consumers must inspect terminal events rather than treating HTTP 200 as model success.

## Isolation and recovery

Codex and web work use separate durable queue names and separate execution permits. The legacy queue remains a drain-only compatibility path for pre-upgrade jobs. Neither queue enables automatic pg-boss job retries.

Codex retries require an explicit Runner pre-acceptance rejection plus a transient error. Unknown transport failures and accepted/submitted failures are not retried. Web tasks never switch accounts after submission uncertainty; the affected account is quarantined pending verification.

Health, model-catalog and quota reads have bounded timeouts. One unready web account does not mark another qualified healthy account unavailable. Pool cooldown reporting counts down to the recorded cooldown deadline rather than continually extending it.

Remaining operational boundaries: no application-level atomic queue-size admission cap, no multi-host HA/failover guarantee, no automatic resolution of upstream login/region/account restrictions, and no guaranteed token-granular Web output. These are not covered by a passing unit-test suite or a single real smoke task.
