<div align="center">

<h1 align="center">ChatGPT Web browser runtime</h1>

</div>

This image runs one visible Chromium profile, the unpacked AIALRA extension, a loopback bridge and a noVNC desktop. The production pool runs one container and one profile per fixed account slot (`account-a` through `account-d`); it never shares a profile volume between slots. The extension can access only `https://chatgpt.com/*` and its exact loopback bridge origin at `http://127.0.0.1:13216/*`. It does not expose Chrome remote debugging, request the cookies permission, or call private ChatGPT endpoints.

The persistent profile volume contains the interactive ChatGPT login and must be treated as an authentication secret. Keep it outside ordinary backups, never copy it into the repository, and delete it when the experiment is retired.

Operators log each account in manually through its protected Router noVNC path. The pool stores only the opaque slot id, a manually supplied `plus`, `pro` or `unknown` label, health state, lease state and redacted diagnostics. It does not infer plans from page text, cookies, latency or quota, and it does not copy cookies or credentials between slots.

DOM bridge v2 prewarms a tab, starts every task in a fresh regular conversation, and keeps failed tabs visible for ten minutes before reset. The extension locates and observes the page. Prompt entry uses native X11 pointer and keyboard events plus a container-local clipboard, which is cleared after the DOM verifies the editor. Extension storage contains only a job-id digest, slot and document identifiers, stage, and submitted flag; it never stores prompt or response bodies.

The egress proxy allows ChatGPT and the minimum Google OAuth browser domains used by the optional **Continue with Google** login flow, including the regional Google Accounts redirect observed from the VPS. It continues to reject loopback, private, Tailnet and cloud metadata destinations.
