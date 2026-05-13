# Security policy

## Reporting a vulnerability

Open a GitHub issue prefixed with `[security]` at https://github.com/tianrendong/pi-packs/issues, or contact the maintainer directly if the issue is sensitive. Please do **not** include exploit details in a public issue without coordinating first.

## Threat model

`pi-chrome` is a developer tool you install knowingly. It is **not** designed to defend against:

- Hostile pages running in your Chrome trying to detect or escape automation. (Standard browser security boundaries still apply, but a hostile page that already runs in your tab can do anything that page can already do.)
- Other processes on your local machine. The bridge binds to `127.0.0.1:17318` (loopback only) but **does not authenticate** local callers. Any process running as your user can issue commands. If your threat model includes hostile local processes, run pi-chrome on a separate user account.

`pi-chrome` **is** designed to:

- Never exfiltrate page state to the network. All communication is loopback (`127.0.0.1`).
- Surface every action with an honest result envelope so the agent can't silently do the wrong thing.
- Require explicit opt-in for trusted-input mode (`/chrome clicks on` or `trusted: true`), which uses `chrome.debugger` and shows Chrome's banner.

## The companion extension

The Chrome extension under `extensions/chrome-profile-bridge/browser-extension/` runs with broad permissions: `tabs`, `scripting`, `debugger`, `webNavigation`, etc. **Only install it from a package source you trust.** Read the source before loading. Pin a known-good commit if you're security-sensitive.

## Defaults

- Loopback bridge only. No remote port. No telemetry.
- Synthetic events first; trusted CDP only when explicitly enabled.
- Quiet mode optional; tab/window focus is observable (the user can see Pi acting).

## Override the port

```bash
PI_CHROME_BRIDGE_PORT=17319 pi
```

## Supported versions

The latest minor on npm is supported. Security patches will be released as soon as practical.
