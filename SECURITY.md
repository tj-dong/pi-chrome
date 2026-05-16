# Security policy

## Reporting a vulnerability

Open a GitHub issue prefixed with `[security]` at https://github.com/tianrendong/pi-chrome/issues, or contact the maintainer directly if the issue is sensitive. Please do **not** include exploit details in a public issue without coordinating first.

## Threat model

`pi-chrome` is a developer tool you install knowingly.

### In scope (designed to defend against)

- **Ordinary web pages.** The bridge rejects browser-origin command requests; CORS cannot be used to drive Chrome.
- **Drive-by local processes / curl without the pairing secret.** Every privileged endpoint (`/next`, `/result`, `/command`) requires a signed envelope with an HMAC key established during explicit pairing. A random local process that has not been paired cannot poll commands, post results, or invoke `/command`.
- **Malicious Chrome extensions on the same browser.** The bridge pins the exact `chrome-extension://<id>` origin established at pairing time. Any other extension polling `/next` receives only an unsigned idle response (`type:"none"` + `needsPairing:true`); it never sees queued commands. An attacker who somehow learns a command ID still cannot forge a `/result` without the extension's HMAC key. The unsigned idle path exists purely so older or unrelated extensions can read the `x-pi-chrome-version` header and trigger the auto-reload migration path.
- **Pre-bind localhost impostors.** Pairing establishes mutual HMAC keys before any command is delivered. The Pi peer that talks to the bridge owner via `/command` signs every request and verifies the owner's signed response, so a process that binds `:17318` first cannot impersonate either side without the keys.
- **Replay / interleaving.** Every signed envelope binds protocol version, direction, method, path, extension ID, bridge ID, timestamp, fresh nonce, and SHA-256 of the body. Timestamps must be within ±30 s and nonces are rejected on reuse.
- **`/chrome authorize` bypass.** Even an attacker who can reach the bridge cannot drive Chrome from chrome_* tools unless the current Pi session also authorized control.

### Out of scope (cannot defend against)

- **Same-user malware.** A process running under your user account can read `~/.config/pi/chrome-bridge.json` (mode 0600), replace the Chrome extension, attach a debugger to Pi or Chrome, or use OS automation APIs. If your threat model includes hostile local processes running as you, isolate pi-chrome on a separate user account or VM.
- **Hostile pages running in your tabs.** Standard browser security boundaries apply. A page that already runs in a tab can read its own DOM. MAIN-world helpers (`window.__PI_CHROME_STATE__`) are page-tamperable; treat snapshot UIDs as advisory for dangerous actions on untrusted origins.
- **Network adversaries.** All communication is loopback. There is no network path to defend.

### Properties (always-on)

- **Loopback only.** Every endpoint rejects non-loopback `remoteAddress`. `PI_CHROME_BRIDGE_HOST=0.0.0.0` is ignored unless `PI_CHROME_BRIDGE_DANGEROUS_REMOTE=1` is set, and even then the per-endpoint loopback check still rejects remote callers.
- **Resource caps.** 1 MiB request body cap (413), 256 queued/pending commands, 4 concurrent long-pollers.
- **No telemetry.** All state stays on disk under your config dir or in the extension's `chrome.storage.local`.
- **Fail-closed.** Missing or invalid auth headers, expired timestamps, replayed nonces, and origin mismatches all return errors with no side effects.

## Pairing flow

1. Run `/chrome pair` in Pi. Pi generates a 32-byte invite, prints `pcp_<base64url>` (also copied to clipboard on macOS), and arms `/pair` for 10 minutes.
2. Open the **Pi Chrome Connector** extension popup in Chrome, paste the invite, click *Pair*.
3. The extension signs its identity with the invite key. The bridge verifies, derives two HKDF keys (one for extension↔bridge `/next`/`/result`, one for peer Pi↔owner Pi `/command`), pins the exact extension ID, and returns *only* the `extensionPairKey` over a response signed with the invite secret (so the extension proves it's talking to the same Pi process that issued the invite). The `brokerKey` stays Pi-side, persisted in `~/.config/pi/chrome-bridge.json`, and is never sent to the browser.
4. Both sides persist their copies: Pi at `~/.config/pi/chrome-bridge.json` mode 0600; extension in `chrome.storage.local`.
5. The invite is destroyed.

Run `/chrome unpair` to clear pairing keys; every Pi session and the Chrome extension popup will then need to re-pair.

## The companion extension

The Chrome extension under `extensions/chrome-profile-bridge/browser-extension/` runs with broad permissions: `tabs`, `scripting`, `debugger`, `webNavigation`, etc. **Only install it from a package source you trust.** Read the source before loading. Pin a known-good commit if you're security-sensitive.

## Defaults

- Loopback bridge only. No remote port. No telemetry.
- Chrome real input layer for interactive controls.
- Chrome control locked by default; `/chrome authorize` unlocks current Pi session after terminal confirmation, `/chrome revoke` locks it again.
- Run-in-background optional; tab/window focus is observable by default (the user can see Pi acting).

## Custom ports

The bundled Chrome extension currently polls `127.0.0.1:17318`. Custom bridge ports are not supported without editing the extension source and reloading it.

## Supported versions

The latest minor on npm is supported. Security patches will be released as soon as practical.
