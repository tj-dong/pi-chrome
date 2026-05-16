import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, readFileSync, statSync, mkdirSync, writeFileSync, chmodSync, watch as fsWatch, type FSWatcher } from "node:fs";
import { mkdir, writeFile, readFile, chmod } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, createHmac, hkdfSync, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * Existing-profile Chrome bridge for pi.
 *
 * This is intentionally not a remote-debugging-port integration. Chrome blocks default-profile
 * remote debugging in many normal launches, so pi-chrome uses a companion extension from the
 * browser-extension folder bundled next to this Pi extension.
 *
 * The companion extension runs inside the user's real Chrome profile and polls this local
 * pi extension for commands. That gives pi access to the user's existing tabs/authenticated
 * profile, subject to the browser extension permissions the user grants.
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

type ToolTextResult = {
	content: Array<{ type: "text"; text: string }>;
	details?: Record<string, unknown>;
};

type BridgeCommand = {
	id: string;
	action: string;
	params: Record<string, unknown>;
};

type PendingCommand = {
	command: BridgeCommand;
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
};

type BridgeResult = {
	id: string;
	ok: boolean;
	result?: unknown;
	error?: string;
};

const PI_CHROME_PKG_PATH = resolve(__dirname, "..", "..", "package.json");
function readPiChromeVersion(): string {
	try {
		const pkg = JSON.parse(readFileSync(PI_CHROME_PKG_PATH, "utf8")) as { version?: string };
		if (pkg.version) return pkg.version;
	} catch {}
	return "0.0.0-dev";
}
const PI_CHROME_VERSION = readPiChromeVersion();
const PI_CHROME_GLOBAL_KEY = "__piChromeProfileBridgeLoaded__";
const DANGEROUS_REMOTE_ENV = "PI_CHROME_BRIDGE_DANGEROUS_REMOTE";
const RAW_HOST_ENV = process.env.PI_CHROME_BRIDGE_HOST;
const DANGEROUS_REMOTE_ENABLED = process.env[DANGEROUS_REMOTE_ENV] === "1";
function resolveDefaultHost(): string {
	if (!RAW_HOST_ENV) return "127.0.0.1";
	const hostIsLoopback = RAW_HOST_ENV === "127.0.0.1" || RAW_HOST_ENV === "::1" || RAW_HOST_ENV === "localhost";
	if (hostIsLoopback) return RAW_HOST_ENV;
	if (!DANGEROUS_REMOTE_ENABLED) {
		console.warn(
			`pi-chrome: ignoring PI_CHROME_BRIDGE_HOST=${RAW_HOST_ENV} (non-loopback). Set ${DANGEROUS_REMOTE_ENV}=1 to opt in explicitly.`,
		);
		return "127.0.0.1";
	}
	console.warn(`pi-chrome: ${DANGEROUS_REMOTE_ENV}=1 — binding bridge to ${RAW_HOST_ENV}. Bridge endpoints still require loopback or paired auth.`);
	return RAW_HOST_ENV;
}
const DEFAULT_HOST = resolveDefaultHost();
const DEFAULT_PORT = Number(process.env.PI_CHROME_BRIDGE_PORT ?? "17318");
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_REQUEST_BODY_BYTES = 1 * 1024 * 1024; // 1 MiB hard cap on inbound HTTP bodies
const MAX_QUEUE = 256;
const MAX_PENDING = 256;
const MAX_WAITERS = 4;

function isLoopbackAddress(address: string | undefined): boolean {
	if (!address) return false;
	return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

// Locate the OS-level owner of `:port` via `lsof`. Returns undefined when lsof isn't on
// PATH (minimal Linux containers, Windows). Used by ChromeProfileBridge to decide whether
// to auto-takeover an incompatible existing owner at session_start.
function findPortOwnerPid(port: number): number | undefined {
	try {
		const result = spawnSync("sh", ["-lc", `lsof -nP -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null | head -1`], { timeout: 3_000, encoding: "utf8" });
		if (result.status !== 0) return undefined;
		const pid = Number(String(result.stdout).trim());
		return Number.isFinite(pid) && pid > 0 ? pid : undefined;
	} catch {
		return undefined;
	}
}

// Probe the owner's /status with a 1s timeout. Returns the parsed status object, or undefined
// when the owner is unresponsive (likely dead/wedged). Synchronous fetch via a child process
// avoids importing a fetch shim before the main event loop is up.
function probeBridgeStatus(host: string, port: number): { bridgeVersion?: string } | undefined {
	try {
		const result = spawnSync("curl", ["-sS", "--max-time", "1", `http://${host}:${port}/status`], { timeout: 2_000, encoding: "utf8" });
		if (result.status !== 0) return undefined;
		return JSON.parse(String(result.stdout || "").trim() || "{}");
	} catch {
		return undefined;
	}
}

function sameMajorMinor(a: string, b: string): boolean {
	const [aMaj, aMin] = a.split(".").map((n) => Number(n));
	const [bMaj, bMin] = b.split(".").map((n) => Number(n));
	return aMaj === bMaj && aMin === bMin;
}

// Ensure the bundled daemon.cjs is copied to a versioned cache dir so each pi-chrome
// version has a stable on-disk daemon binary independent of nvm/npm install location.
function ensureVersionedDaemon(): string {
	const target = join(homedir(), ".cache", "pi-chrome", PI_CHROME_VERSION, "daemon.cjs");
	const source = join(extensionRoot(), "daemon.cjs");
	try {
		mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
		// Copy idempotently: if shasum already matches, skip. Cheap because daemon.cjs is small.
		let needCopy = true;
		if (existsSync(target)) {
			try {
				const a = readFileSync(target);
				const b = readFileSync(source);
				needCopy = a.length !== b.length || createHash("sha256").update(a).digest("hex") !== createHash("sha256").update(b).digest("hex");
			} catch { needCopy = true; }
		}
		if (needCopy) copyFileSync(source, target);
	} catch (error) {
		console.warn(`pi-chrome: failed to stage daemon at ${target} (${(error as Error).message}); falling back to in-tree source.`);
		return source;
	}
	return target;
}

function daemonLogPath(): string {
	return join(homedir(), ".cache", "pi-chrome", PI_CHROME_VERSION, "daemon.log");
}

// Spawn the daemon as a detached child so it survives the parent Pi exiting. The child is
// unref()'d immediately; from the Pi's perspective it's fire-and-forget. Returns the child's
// PID for diagnostic purposes only.
function spawnDaemon(host: string, port: number): number {
	const daemonPath = ensureVersionedDaemon();
	const logPath = daemonLogPath();
	try { mkdirSync(dirname(logPath), { recursive: true }); } catch {}
	let logFd: number;
	try { logFd = openSync(logPath, "a"); } catch { logFd = openSync("/dev/null", "a"); }
	const child = spawn(process.execPath, [
		daemonPath,
		"--host", host,
		"--port", String(port),
		"--version", PI_CHROME_VERSION,
		"--log", logPath,
	], {
		detached: true,
		stdio: ["ignore", logFd, logFd],
	});
	child.unref();
	return child.pid ?? -1;
}

// Wait up to `timeoutMs` for /status to respond with the expected version. Returns the
// observed status (or undefined on timeout).
function waitForDaemonReady(host: string, port: number, timeoutMs = 4_000): Record<string, unknown> | undefined {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const probed = probeBridgeStatus(host, port);
		if (probed && typeof (probed as { bridgeVersion?: string }).bridgeVersion === "string"
			&& sameMajorMinor((probed as { bridgeVersion: string }).bridgeVersion, PI_CHROME_VERSION)) {
			return probed;
		}
		spawnSync("sleep", ["0.1"]);
	}
	return undefined;
}

function killProcessGracefully(pid: number): boolean {
	try { process.kill(pid, "SIGTERM"); } catch { return false; }
	// Spin briefly waiting for the port to free; escalate to SIGKILL if SIGTERM is ignored.
	const deadline = Date.now() + 3_000;
	while (Date.now() < deadline) {
		try { process.kill(pid, 0); } catch { return true; } // kill(pid, 0) throws ESRCH when gone
		spawnSync("sleep", ["0.2"]);
	}
	try { process.kill(pid, "SIGKILL"); } catch {}
	const secondDeadline = Date.now() + 2_000;
	while (Date.now() < secondDeadline) {
		try { process.kill(pid, 0); } catch { return true; }
		spawnSync("sleep", ["0.2"]);
	}
	return false;
}

// =========================================================================================
// Pairing + signed-envelope auth.
//
// Protocol v1.
//
// Threat model: protect against (a) ordinary web pages, (b) drive-by local processes / curl
// without the pairing secret, (c) malicious Chrome extensions stealing the command channel.
// Out of scope: same-user malware that can read $XDG_CONFIG_HOME, replace native messaging
// hosts, or attach a debugger to Pi/Chrome.
//
// Pairing flow:
//   1. User runs `/chrome pair` in Pi. Pi generates a 32-byte invite secret, presents it as
//      `pcp_<base64url>`, copies to clipboard, and arms `/pair` for `PAIR_WINDOW_MS`.
//   2. User pastes the invite into the Chrome extension popup. Extension POSTs `/pair` with
//      {extensionId, extensionNonce, mac(=HMAC(invite, "pair-v1|" + extensionId + "|" + extensionNonce))}.
//   3. Bridge verifies MAC, mints a `bridgeId` + derives two 32-byte HKDF keys:
//        - extensionPairKey: signs/verifies /next and /result envelopes.
//        - brokerKey: signs/verifies /command envelopes between peer Pi processes.
//      Bridge replies signed with the invite secret so the extension knows it's talking to
//      the same Pi process that issued the invite. Invite is destroyed.
//   4. Both sides persist their copies. Pi keeps the master record at
//      ~/.config/pi/chrome-bridge.json mode 0600; extension keeps mirror in
//      chrome.storage.local.
//
// Wire format on signed requests/responses:
//   x-pi-chrome-auth: v1 ts=<ms> nonce=<base64url-16B> sig=<base64url-32B>
// where sig = HMAC-SHA256(key, canonicalSigningString).
//
// Canonical signing string (newline-separated):
//   v1\n<direction>\n<method>\n<path>\n<extensionId>\n<bridgeId>\n<ts>\n<nonce>\n<sha256-hex(body)>
//
// direction ∈ { "ext->bridge", "bridge->ext", "peer->owner", "owner->peer" }.
// For empty bodies (GET /next), body = "".
//
// Replay defense: receiver requires |now - ts| <= MAX_CLOCK_SKEW_MS and rejects re-used
// nonces via a per-direction LRU.

const AUTH_PROTOCOL = "v1";
const AUTH_HEADER = "x-pi-chrome-auth";
const PAIR_WINDOW_MS = 10 * 60_000;
const MAX_CLOCK_SKEW_MS = 30_000;
const NONCE_TTL_MS = 5 * 60_000;
const NONCE_CACHE_MAX = 4096;

function configPath(): string {
	const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
	return join(base, "pi", "chrome-bridge.json");
}
function b64url(buf: Buffer): string {
	return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(text: string): Buffer {
	const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
	return Buffer.from(padded, "base64");
}
function sha256Hex(input: string | Buffer): string {
	return createHash("sha256").update(input).digest("hex");
}
function hmacSign(key: Buffer, message: string): Buffer {
	return createHmac("sha256", key).update(message).digest();
}
function safeStringEqual(a: string, b: string): boolean {
	const aBuf = Buffer.from(a, "utf8");
	const bBuf = Buffer.from(b, "utf8");
	if (aBuf.length !== bBuf.length) return false;
	try { return timingSafeEqual(aBuf, bBuf); } catch { return false; }
}
function safeBufferEqual(a: Buffer, b: Buffer): boolean {
	if (a.length !== b.length) return false;
	try { return timingSafeEqual(a, b); } catch { return false; }
}

type PairDirection = "ext->bridge" | "bridge->ext" | "peer->owner" | "owner->peer";

function canonicalString(
	direction: PairDirection,
	method: string,
	path: string,
	extensionId: string,
	bridgeId: string,
	ts: number,
	nonce: string,
	body: string,
): string {
	return [AUTH_PROTOCOL, direction, method.toUpperCase(), path, extensionId, bridgeId, String(ts), nonce, sha256Hex(body)].join("\n");
}

function buildAuthHeader(key: Buffer, direction: PairDirection, method: string, path: string, extensionId: string, bridgeId: string, body: string): { header: string; ts: number; nonce: string } {
	const ts = Date.now();
	const nonce = b64url(randomBytes(16));
	const sig = b64url(hmacSign(key, canonicalString(direction, method, path, extensionId, bridgeId, ts, nonce, body)));
	return { header: `${AUTH_PROTOCOL} ts=${ts} nonce=${nonce} sig=${sig}`, ts, nonce };
}

function parseAuthHeader(raw: string | string[] | undefined): { ts: number; nonce: string; sig: string } | undefined {
	const value = Array.isArray(raw) ? raw[0] : raw;
	if (!value || typeof value !== "string") return undefined;
	const parts = value.trim().split(/\s+/);
	if (parts.length !== 4 || parts[0] !== AUTH_PROTOCOL) return undefined;
	const kv: Record<string, string> = {};
	for (const p of parts.slice(1)) {
		const eq = p.indexOf("=");
		if (eq <= 0) return undefined;
		kv[p.slice(0, eq)] = p.slice(eq + 1);
	}
	const ts = Number(kv.ts);
	if (!Number.isFinite(ts) || !kv.nonce || !kv.sig) return undefined;
	return { ts, nonce: kv.nonce, sig: kv.sig };
}

// Bounded LRU of (nonce -> ts) per direction for replay defense. Map iteration order is
// insertion order, so evicting `keys().next()` removes the oldest entry. Two callers:
//
//  - `has(nonce)` checks duplicates *before* MAC verification (cheap; lets us reject obvious
//    replays without wasting an HMAC compute).
//  - `store(nonce, ts)` records the nonce *after* MAC verification succeeds, so an attacker
//    sending fresh-nonce bogus signatures cannot pin memory or pollute the cache.
class NonceCache {
	private readonly entries = new Map<string, number>();
	has(nonce: string): boolean { return this.entries.has(nonce); }
	store(nonce: string, ts: number): void {
		const now = Date.now();
		// Drop stale entries opportunistically.
		for (const [k, t] of this.entries) {
			if (now - t > NONCE_TTL_MS) this.entries.delete(k); else break;
		}
		// Hard cap: evict oldest insertions until we're under the limit, even if not stale.
		while (this.entries.size >= NONCE_CACHE_MAX) {
			const oldest = this.entries.keys().next().value;
			if (oldest === undefined) break;
			this.entries.delete(oldest);
		}
		this.entries.set(nonce, ts);
	}
}

type PersistedAuthState = {
	protocol: "v1";
	bridgeId: string;
	extensionId: string;
	extensionPairKey: string; // base64url, shared with the Chrome extension
	brokerKey: string; // base64url, Pi-side only — never sent to the extension
};

class BridgeAuth {
	private state: PersistedAuthState | undefined;
	private pendingInvite: { secret: Buffer; expiresAt: number } | undefined;
	private extNonces = new NonceCache(); // request: ext->bridge
	private peerNonces = new NonceCache(); // request: peer->owner
	private ownerRespNonces = new NonceCache(); // response: owner->peer (verified peer-side)
	private lastStateMtimeMs: number = 0;
	private watcher: FSWatcher | undefined;

	constructor() {
		this.load();
		this.startWatching();
	}

	private startWatching(): void {
		// fs.watch the config file so cross-process changes (e.g. another Pi running `/chrome
		// unpair`, or an external `rm` of the file) immediately propagate to this owner's
		// in-memory state. Without this, an owner that already cached `state` keeps verifying
		// signatures with stale keys long after the file is gone. fs.watch is best-effort
		// across platforms; we also re-check mtime synchronously on every privileged request
		// (see refreshIfStale) so a missed watch event can never silently desync.
		const path = configPath();
		const dir = dirname(path);
		try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch {}
		try {
			this.watcher = fsWatch(dir, { persistent: false }, (_event, filename) => {
				if (!filename || filename.toString() !== "chrome-bridge.json") return;
				this.refreshIfStale();
			});
		} catch (error) {
			console.warn(`pi-chrome: fs.watch on ${dir} failed (${(error as Error).message}); falling back to per-request mtime checks.`);
		}
	}

	stop(): void {
		try { this.watcher?.close(); } catch {}
		this.watcher = undefined;
	}

	// Synchronously re-stat the config file and reload if anything changed on disk. Called
	// before every privileged verification so that cross-process mutations (peer unpair,
	// external file edits) can never let stale in-memory keys validate a request.
	refreshIfStale(): void {
		const path = configPath();
		let mtimeMs = 0;
		try { mtimeMs = statSync(path).mtimeMs; } catch { mtimeMs = -1; }
		if (mtimeMs === this.lastStateMtimeMs) return;
		this.lastStateMtimeMs = mtimeMs;
		const prevExtId = this.state?.extensionId;
		const prevBridgeId = this.state?.bridgeId;
		this.load();
		const rotated = (this.state?.extensionId !== prevExtId) || (this.state?.bridgeId !== prevBridgeId);
		if (rotated) {
			// Keys rotated (or pairing cleared). Drop replay caches; old nonces signed under the
			// previous keys are meaningless under the new ones and would otherwise needlessly
			// occupy cache slots.
			this.extNonces = new NonceCache();
			this.peerNonces = new NonceCache();
			this.ownerRespNonces = new NonceCache();
		}
	}

	get paired(): boolean { this.refreshIfStale(); return Boolean(this.state); }
	get bridgeId(): string { this.refreshIfStale(); return this.state?.bridgeId ?? ""; }
	get pinnedExtensionId(): string { this.refreshIfStale(); return this.state?.extensionId ?? ""; }

	private load(): void {
		try {
			const raw = readFileSync(configPath(), "utf8");
			const parsed = JSON.parse(raw);
			if (parsed?.protocol === "v1" && parsed.bridgeId && parsed.extensionId && parsed.extensionPairKey && parsed.brokerKey) {
				this.state = parsed as PersistedAuthState;
			} else {
				// File exists but doesn't carry a valid v1 record (e.g. peer reset wrote `{}`).
				// Drop in-memory state so this owner stops accepting signatures keyed by the
				// now-deleted record.
				this.state = undefined;
			}
		} catch {
			// File missing or unreadable: treat as unpaired.
			this.state = undefined;
		}
	}

	private persist(): void {
		if (!this.state) return;
		const path = configPath();
		try {
			const dir = dirname(path);
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			writeFileSync(path, JSON.stringify(this.state), { mode: 0o600 });
			try { chmodSync(path, 0o600); } catch {}
			try { chmodSync(dir, 0o700); } catch {}
			try { this.lastStateMtimeMs = statSync(path).mtimeMs; } catch {}
		} catch (error) {
			console.warn(`pi-chrome: failed to persist auth state at ${path}: ${(error as Error).message}`);
		}
	}

	// `/chrome pair` calls this; returns the invite to display to the user.
	startPairWindow(): string {
		const secret = randomBytes(32);
		this.pendingInvite = { secret, expiresAt: Date.now() + PAIR_WINDOW_MS };
		return `pcp_${b64url(secret)}`;
	}

	cancelPairWindow(): void { this.pendingInvite = undefined; }

	pairWindowActive(): boolean {
		if (!this.pendingInvite) return false;
		if (this.pendingInvite.expiresAt < Date.now()) { this.pendingInvite = undefined; return false; }
		return true;
	}

	reset(): void {
		this.state = undefined;
		this.pendingInvite = undefined;
		const path = configPath();
		try { writeFileSync(path, JSON.stringify({}), { mode: 0o600 }); } catch {}
		try { chmodSync(path, 0o600); } catch {}
		try { chmodSync(dirname(path), 0o700); } catch {}
	}

	// Verify extension's /pair POST. Returns the response payload + signed header on success.
	completePairing(body: { extensionId?: string; extensionNonce?: string; mac?: string }): { response: Record<string, unknown>; signedHeader: string } {
		if (!this.pairWindowActive()) throw new Error("no active pairing window; run /chrome pair first");
		if (!body.extensionId || !body.extensionNonce || !body.mac) throw new Error("pair: missing fields");
		// Chrome extension IDs are 32 lowercase a-p characters. Reject uppercase or mixed case
		// so a malicious caller can't smuggle a value that looks like one ID and matches another
		// after case folding.
		if (!/^[a-p]{32}$/.test(body.extensionId)) throw new Error("pair: invalid extensionId");
		const invite = this.pendingInvite!.secret;
		const expected = hmacSign(invite, `pair-v1|${body.extensionId}|${body.extensionNonce}`);
		const supplied = b64urlDecode(body.mac);
		if (!safeBufferEqual(expected, supplied)) throw new Error("pair: bad mac");
		const bridgeId = b64url(randomBytes(16));
		const extensionPairKey = Buffer.from(hkdfSync("sha256", invite, Buffer.from("pi-chrome-pair-salt"), Buffer.from("ext-pair-key:" + bridgeId), 32));
		const brokerKey = Buffer.from(hkdfSync("sha256", invite, Buffer.from("pi-chrome-pair-salt"), Buffer.from("broker-key:" + bridgeId), 32));
		this.state = {
			protocol: "v1",
			bridgeId,
			extensionId: body.extensionId,
			extensionPairKey: b64url(extensionPairKey),
			brokerKey: b64url(brokerKey),
		};
		this.persist();
		this.pendingInvite = undefined;
		// Sign response with the invite (extension still has it) so it can verify before storing
		// the long-lived keys returned in the body.
		//
		// IMPORTANT: do NOT include brokerKey in the response. The extension never uses it;
		// it is exclusively for peer Pi sessions reading `~/.config/pi/chrome-bridge.json`.
		// Leaking it into the browser would broaden blast radius if the extension is later
		// compromised.
		const response: Record<string, unknown> = {
			ok: true,
			bridgeId,
			extensionId: body.extensionId,
			extensionPairKey: this.state.extensionPairKey,
			protocol: AUTH_PROTOCOL,
		};
		const bodyText = JSON.stringify(response);
		const { header } = buildAuthHeader(invite, "bridge->ext", "POST", "/pair", body.extensionId, bridgeId, bodyText);
		return { response, signedHeader: header };
	}

	private verifyEnvelope(
		key: Buffer,
		cache: NonceCache,
		direction: PairDirection,
		method: string,
		path: string,
		extensionId: string,
		bridgeId: string,
		header: string | string[] | undefined,
		body: string,
	): boolean {
		const parsed = parseAuthHeader(header);
		if (!parsed) return false;
		if (Math.abs(Date.now() - parsed.ts) > MAX_CLOCK_SKEW_MS) return false;
		// Cheap replay check BEFORE the HMAC compute: reject duplicates immediately.
		if (cache.has(parsed.nonce)) return false;
		const expected = hmacSign(key, canonicalString(direction, method, path, extensionId, bridgeId, parsed.ts, parsed.nonce, body));
		let supplied: Buffer;
		try { supplied = b64urlDecode(parsed.sig); } catch { return false; }
		if (!safeBufferEqual(expected, supplied)) return false;
		// Only record AFTER MAC verifies so bogus-signature spam cannot bloat the cache.
		cache.store(parsed.nonce, parsed.ts);
		return true;
	}

	verifyExtensionRequest(method: string, path: string, header: string | string[] | undefined, originExtensionId: string, body: string): boolean {
		this.refreshIfStale();
		if (!this.state) return false;
		if (!safeStringEqual(originExtensionId, this.state.extensionId)) return false;
		return this.verifyEnvelope(
			b64urlDecode(this.state.extensionPairKey),
			this.extNonces,
			"ext->bridge",
			method,
			path,
			this.state.extensionId,
			this.state.bridgeId,
			header,
			body,
		);
	}

	signBridgeResponse(method: string, path: string, body: string): string | undefined {
		if (!this.state) return undefined;
		const { header } = buildAuthHeader(
			b64urlDecode(this.state.extensionPairKey),
			"bridge->ext",
			method,
			path,
			this.state.extensionId,
			this.state.bridgeId,
			body,
		);
		return header;
	}

	verifyPeerRequest(method: string, path: string, header: string | string[] | undefined, body: string): boolean {
		this.refreshIfStale();
		if (!this.state) return false;
		return this.verifyEnvelope(
			b64urlDecode(this.state.brokerKey),
			this.peerNonces,
			"peer->owner",
			method,
			path,
			this.state.extensionId,
			this.state.bridgeId,
			header,
			body,
		);
	}

	signPeerRequest(method: string, path: string, body: string): string | undefined {
		if (!this.state) return undefined;
		const { header } = buildAuthHeader(
			b64urlDecode(this.state.brokerKey),
			"peer->owner",
			method,
			path,
			this.state.extensionId,
			this.state.bridgeId,
			body,
		);
		return header;
	}

	signOwnerResponse(method: string, path: string, body: string): string | undefined {
		if (!this.state) return undefined;
		const { header } = buildAuthHeader(
			b64urlDecode(this.state.brokerKey),
			"owner->peer",
			method,
			path,
			this.state.extensionId,
			this.state.bridgeId,
			body,
		);
		return header;
	}

	verifyOwnerResponse(method: string, path: string, header: string | string[] | undefined, body: string): boolean {
		this.refreshIfStale();
		if (!this.state) return false;
		const parsed = parseAuthHeader(header);
		if (!parsed) return false;
		if (Math.abs(Date.now() - parsed.ts) > MAX_CLOCK_SKEW_MS) return false;
		if (this.ownerRespNonces.has(parsed.nonce)) return false;
		const expected = hmacSign(
			b64urlDecode(this.state.brokerKey),
			canonicalString("owner->peer", method, path, this.state.extensionId, this.state.bridgeId, parsed.ts, parsed.nonce, body),
		);
		let supplied: Buffer;
		try { supplied = b64urlDecode(parsed.sig); } catch { return false; }
		if (!safeBufferEqual(expected, supplied)) return false;
		this.ownerRespNonces.store(parsed.nonce, parsed.ts);
		return true;
	}
}
const MAX_TEXT_CHARS = 30_000;
const MAX_ELEMENTS = 80;

function truncateText(text: string, maxChars = MAX_TEXT_CHARS): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n\n[truncated ${text.length - maxChars} characters]`;
}

function safeJson(value: unknown): string {
	return JSON.stringify(value, null, 2);
}

function extensionRoot(): string {
	// Resolve relative to this extension file, not ctx.cwd. ctx.cwd can temporarily be
	// an attachment/clipboard path when Pi is handling pasted images.
	if (typeof __dirname === "string") return __dirname;
	return process.cwd();
}

function workspaceCwd(ctx: ExtensionContext): string {
	for (const candidate of [ctx.cwd, process.cwd()]) {
		if (!candidate) continue;
		try {
			if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
		} catch {
			// try next candidate
		}
	}
	return process.cwd();
}

function browserExtensionPath(): string {
	return join(extensionRoot(), "browser-extension");
}

function hostnameOf(url: string | undefined): string {
	if (!url) return "";
	try { return new URL(url).hostname; } catch { return ""; }
}

// Description of a click/type/fill result's significant fields so the agent doesn't have to
// guess whether the action actually changed the page.
function summarizeActionResult(result: unknown): string | undefined {
	if (!result || typeof result !== "object") return undefined;
	const r = result as Record<string, unknown>;
	const parts: string[] = [];
	if (r.pageMutated === false) parts.push("pageMutated=false");
	if (r.defaultPrevented === true) parts.push("defaultPrevented=true");
	if (r.elementVisible === false) parts.push("element NOT visible");
	if (r.occludedBy) {
		const o = r.occludedBy as { tag?: string; id?: string };
		parts.push(`occluded by <${o.tag ?? "?"}${o.id ? "#" + o.id : ""}>`);
	}
	if (r.valueMatches === false) parts.push("input value did not stick");
	if (r.autoplayHint) parts.push("autoplay-gated affordance");
	return parts.length ? parts.join("; ") : undefined;
}

class RequestBodyTooLargeError extends Error {
	constructor() { super("request body too large"); this.name = "RequestBodyTooLargeError"; }
}
function readRequestBody(request: IncomingMessage, maxBytes = MAX_REQUEST_BODY_BYTES): Promise<string> {
	return new Promise((resolveBody, rejectBody) => {
		// Reject too-large bodies up front when Content-Length advertises it.
		const declared = Number(request.headers["content-length"]);
		if (Number.isFinite(declared) && declared > maxBytes) {
			rejectBody(new RequestBodyTooLargeError());
			request.resume();
			return;
		}
		const chunks: Buffer[] = [];
		let size = 0;
		request.on("data", (chunk) => {
			const buf = Buffer.from(chunk);
			size += buf.length;
			if (size > maxBytes) {
				rejectBody(new RequestBodyTooLargeError());
				request.destroy();
				return;
			}
			chunks.push(buf);
		});
		request.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
		request.on("error", rejectBody);
	});
}
async function readJsonBody<T = unknown>(request: IncomingMessage, response: ServerResponse, extraHeaders?: Record<string, string>): Promise<T | undefined> {
	let raw: string;
	try {
		raw = await readRequestBody(request);
	} catch (error) {
		if (error instanceof RequestBodyTooLargeError) {
			sendJson(response, 413, { ok: false, error: "request body too large" }, extraHeaders);
		} else {
			sendJson(response, 400, { ok: false, error: `failed to read request body: ${(error as Error).message}` }, extraHeaders);
		}
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw || "{}");
	} catch (error) {
		sendJson(response, 400, { ok: false, error: `invalid JSON body: ${(error as Error).message}` }, extraHeaders);
		return undefined;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		sendJson(response, 400, { ok: false, error: "expected JSON object" }, extraHeaders);
		return undefined;
	}
	return parsed as T;
}

function corsHeadersFor(request: IncomingMessage): Record<string, string> {
	const origin = String(request.headers.origin ?? "");
	if (!origin.startsWith("chrome-extension://")) return {};
	return {
		"access-control-allow-origin": origin,
		"access-control-allow-methods": "GET,POST,OPTIONS",
		"access-control-allow-headers": `content-type, ${AUTH_HEADER}`,
		"access-control-expose-headers": `x-pi-chrome-version, ${AUTH_HEADER}`,
		"vary": "origin",
	};
}

function isBrowserOriginAllowed(request: IncomingMessage): boolean {
	const origin = String(request.headers.origin ?? "");
	if (origin) return origin.startsWith("chrome-extension://");
	const secFetchSite = String(request.headers["sec-fetch-site"] ?? "");
	return !secFetchSite || secFetchSite === "none" || secFetchSite === "same-origin";
}

function isLocalProcessRequest(request: IncomingMessage): boolean {
	return !request.headers.origin && !request.headers["sec-fetch-site"];
}

function sendJson(response: ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		...(extraHeaders ?? {}),
	});
	response.end(JSON.stringify(body));
}

class ChromeProfileBridge {
	private server: Server | undefined;
	private pending = new Map<string, PendingCommand>();
	private queue: BridgeCommand[] = [];
	private waiters: Array<(command: BridgeCommand | undefined) => void> = [];
	private lastSeenAt: number | undefined;
	private clientName: string | undefined;
	private mode: "server" | "client" | undefined;
	private readonly auth: BridgeAuth;

	constructor(
		private readonly host: string,
		private readonly port: number,
	) {
		this.auth = new BridgeAuth();
	}

	get bridgeAuth(): BridgeAuth { return this.auth; }

	private extensionIdFromOrigin(request: IncomingMessage): string | undefined {
		const origin = String(request.headers.origin ?? "");
		// Match Chrome's own format strictly: exact lowercase a-p, no trailing slash or path.
		const match = origin.match(/^chrome-extension:\/\/([a-p]{32})$/);
		return match ? match[1] : undefined;
	}

	get url(): string {
		return `http://${this.host}:${this.port}`;
	}

	get connected(): boolean {
		// MV3 service workers can pause between polls/alarms. Treat a recent poll as
		// connected without sending a probe command; real chrome_* tool calls are
		// the authoritative end-to-end health check.
		return this.lastSeenAt !== undefined && Date.now() - this.lastSeenAt < 5 * 60_000;
	}

	status(): Record<string, unknown> {
		return {
			url: this.url,
			mode: this.mode ?? "starting",
			connected: this.connected,
			lastSeenAt: this.lastSeenAt,
			clientName: this.clientName,
			queuedCommands: this.queue.length,
			pendingCommands: this.pending.size,
			// Version is broadcast in /status so peer Pi sessions can decide at session_start
			// whether to join as client (compatible same major.minor) or to auto-takeover an
			// older/wedged owner.
			bridgeVersion: PI_CHROME_VERSION,
		};
	}

	// 0.17+ daemon model: pi-chrome no longer hosts the HTTP server in this Pi process. The
	// bridge runs as a detached daemon (extensions/chrome-profile-bridge/daemon.cjs, staged at
	// ~/.cache/pi-chrome/<version>/daemon.cjs) and Pi sessions are uniform clients that POST
	// signed /command envelopes. `start()` ensures the daemon is running and up-to-date;
	// `send()` continues to go through the same sendViaOwner path used by previous releases'
	// client mode.
	async start(): Promise<void> {
		if (this.mode === "client") return;
		await this.ensureDaemonRunning();
	}

	private async ensureDaemonRunning(): Promise<void> {
		const probed = probeBridgeStatus(this.host, this.port);
		const ownerVersion = typeof (probed as { bridgeVersion?: string })?.bridgeVersion === "string"
			? (probed as { bridgeVersion: string }).bridgeVersion
			: undefined;
		const compatible = ownerVersion ? sameMajorMinor(ownerVersion, PI_CHROME_VERSION) : false;
		if (probed && compatible) {
			this.mode = "client";
			return;
		}
		if (probed && !compatible) {
			// Incompatible owner; auto-takeover (kill + replace with our-version daemon).
			await this.handleEaddrinuse();
			if (this.mode === "client") return;
			// fall through to spawn
		}
		const pid = spawnDaemon(this.host, this.port);
		const ready = waitForDaemonReady(this.host, this.port, 4_000);
		if (!ready) {
			console.warn(`pi-chrome: daemon spawn (pid ${pid}) did not become ready within 4s; check ${daemonLogPath()}`);
		}
		this.mode = "client";
	}

	// Auto-takeover when the existing owner is unresponsive or running an incompatible
	// version. After kill, a fresh daemon is spawned by `ensureDaemonRunning`.
	private async handleEaddrinuse(): Promise<void> {
		const probed = probeBridgeStatus(this.host, this.port);
		const ownerVersion = typeof probed?.bridgeVersion === "string" ? probed.bridgeVersion : undefined;
		const compatible = ownerVersion ? sameMajorMinor(ownerVersion, PI_CHROME_VERSION) : false;
		if (probed && compatible) {
			this.mode = "client";
			return;
		}
		// Either no response at all, or the owner is on an incompatible (older or future)
		// version that won't honor the same wire protocol. Try to take over.
		const pid = findPortOwnerPid(this.port);
		const reason = !probed
			? "unresponsive"
			: ownerVersion
				? `version ${ownerVersion} incompatible with ${PI_CHROME_VERSION}`
				: "unknown version";
		if (!pid || pid === process.pid) {
			console.warn(`pi-chrome: bridge port :${this.port} held by ${reason} owner; cannot identify PID via lsof. Falling back to client mode (commands may fail).`);
			this.mode = "client";
			return;
		}
		console.warn(`pi-chrome: bridge port :${this.port} held by PID ${pid} (${reason}); attempting takeover.`);
		if (!killProcessGracefully(pid)) {
			console.warn(`pi-chrome: failed to kill PID ${pid}; falling back to client mode.`);
			this.mode = "client";
			return;
		}
		console.warn(`pi-chrome: killed PID ${pid}; will spawn the daemon next.`);
	}

	// Probe the daemon's /status and return its view (which is the only source of truth for
	// `connected` / `lastSeenAt` in 0.17+, since the extension polls the daemon, not Pi).
	async daemonStatus(timeoutMs = 1_000): Promise<Record<string, unknown> | undefined> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const res = await fetch(`${this.url}/status`, { signal: controller.signal });
			if (!res.ok) return undefined;
			return (await res.json()) as Record<string, unknown>;
		} catch {
			return undefined;
		} finally {
			clearTimeout(timer);
		}
	}

	// Signed admin RPC to the daemon. Used for state mutations the daemon owns: arm-pair-window,
	// reset, status. Pre-pair (when the daemon has no state file), unauthenticated; once paired,
	// the daemon requires the broker-key envelope (same signature as /command).
	async admin(op: string, body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
		const payload = JSON.stringify({ op, ...body });
		const headers: Record<string, string> = { "content-type": "application/json" };
		if (this.auth.paired) {
			const sig = this.auth.signPeerRequest("POST", "/admin", payload);
			if (sig) headers[AUTH_HEADER] = sig;
		}
		const response = await fetch(`${this.url}/admin`, { method: "POST", headers, body: payload });
		const respText = await response.text();
		// Verify owner sig when present (paired state). For pre-pair calls, no sig to verify.
		if (this.auth.paired) {
			const respAuth = response.headers.get(AUTH_HEADER) ?? undefined;
			if (!this.auth.verifyOwnerResponse("POST", "/admin", respAuth, respText)) {
				throw new Error("daemon /admin response signature invalid");
			}
		}
		let parsed: Record<string, unknown>;
		try { parsed = JSON.parse(respText); } catch { throw new Error(`daemon /admin returned non-JSON: ${respText.slice(0, 200)}`); }
		if (!response.ok || parsed.ok === false) throw new Error(String(parsed.error ?? `daemon /admin HTTP ${response.status}`));
		return parsed;
	}

	stop(): void {
		if (this.mode === "client") {
			this.mode = undefined;
			return;
		}
		this.auth.stop();
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error("Chrome profile bridge stopped"));
		}
		this.pending.clear();
		this.queue = [];
		for (const waiter of this.waiters) waiter(undefined);
		this.waiters = [];
		this.server?.close();
		this.server = undefined;
		this.mode = undefined;
	}

	send(action: string, params: Record<string, unknown>, timeoutMs = DEFAULT_TIMEOUT_MS, signal?: AbortSignal): Promise<unknown> {
		// 0.17+: all sends go through the daemon over signed /command (sendViaOwner). The
		// previous in-process queue path (sendLocal) is dead code retained only to support
		// the legacy ChromeProfileBridge.handle() HTTP server below, which is itself dead in
		// 0.17 (the daemon owns the listener).
		return this.sendViaOwner(action, params, timeoutMs, signal);
	}

	private sendLocal(action: string, params: Record<string, unknown>, timeoutMs = DEFAULT_TIMEOUT_MS, signal?: AbortSignal): Promise<unknown> {
		const id = randomUUID();
		const command = { id, action, params };
		return new Promise((resolveCommand, rejectCommand) => {
			if (signal?.aborted) {
				rejectCommand(new Error("Chrome command aborted"));
				return;
			}
			const cleanupAbort = () => {
				if (signal) signal.removeEventListener("abort", onAbort);
			};
			const onAbort = () => {
				clearTimeout(timer);
				this.pending.delete(id);
				this.queue = this.queue.filter((queued) => queued.id !== id);
				cleanupAbort();
				rejectCommand(new Error("Chrome command aborted"));
			};
			const timer = setTimeout(() => {
				this.pending.delete(id);
				this.queue = this.queue.filter((queued) => queued.id !== id);
				cleanupAbort();
				rejectCommand(
					new Error(
						`Timed out waiting for Chrome extension after ${timeoutMs}ms. Run /chrome onboard, then load the bundled browser-extension folder in your normal Chrome profile.`,
					),
				);
			}, timeoutMs);
			if (this.pending.size >= MAX_PENDING) {
				clearTimeout(timer);
				cleanupAbort();
				rejectCommand(new Error("Chrome bridge has too many in-flight commands; retry shortly"));
				return;
			}
			this.pending.set(id, {
				command,
				resolve: (value) => { cleanupAbort(); resolveCommand(value); },
				reject: (err) => { cleanupAbort(); rejectCommand(err); },
				timer,
			});
			if (signal) signal.addEventListener("abort", onAbort, { once: true });
			this.enqueue(command);
		});
	}

	private async sendViaOwner(action: string, params: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
		if (!this.auth.paired) {
			throw new Error("Chrome bridge not paired with this Pi config. Run /chrome pair in the Pi session that owns the bridge first.");
		}
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs + 2_000);
		const forwardAbort = () => controller.abort();
		if (signal) {
			if (signal.aborted) controller.abort();
			else signal.addEventListener("abort", forwardAbort, { once: true });
		}
		try {
			// Per-request signed envelope, keyed by brokerKey. No bearer token transmitted.
			const body = JSON.stringify({ action, params, timeoutMs });
			const sigHeader = this.auth.signPeerRequest("POST", "/command", body);
			if (!sigHeader) throw new Error("Chrome bridge auth not available");
			const response = await fetch(`${this.url}/command`, {
				method: "POST",
				headers: { "content-type": "application/json", [AUTH_HEADER]: sigHeader },
				body,
				signal: controller.signal,
			});
			const respText = await response.text();
			// Legacy detection: an older pi-chrome bridge owner returns 404 for /command before
			// signed envelopes existed. Match that BEFORE signature verification (the legacy
			// owner has no key to sign with), since this is an upgrade hint, not a data path.
			if (response.status === 404) {
				throw new Error(
					"A running Pi session owns the Chrome bridge but is using an older pi-chrome without multi-session support. Restart that Pi session after `pi update`, then retry.",
				);
			}
			// Verify the owner's signed response BEFORE trusting any field in the body, including
			// error strings. A pre-bind impostor without the broker key cannot produce a valid
			// signature, so we refuse to surface its arbitrary error text.
			const respAuth = response.headers.get(AUTH_HEADER) ?? undefined;
			if (!this.auth.verifyOwnerResponse("POST", "/command", respAuth, respText)) {
				throw new Error("Chrome bridge owner response signature invalid; refusing result");
			}
			const payload = (() => { try { return JSON.parse(respText); } catch { return {}; } })() as { ok?: boolean; result?: unknown; error?: string };
			if (!response.ok || !payload.ok) throw new Error(payload.error ?? `Chrome bridge owner HTTP ${response.status}`);
			return payload.result;
		} catch (error) {
			if ((error as Error).name === "AbortError") {
				if (signal?.aborted) throw new Error("Chrome command aborted");
				throw new Error(`Timed out waiting for shared Chrome bridge owner after ${timeoutMs}ms`);
			}
			throw error;
		} finally {
			clearTimeout(timer);
			if (signal) signal.removeEventListener("abort", forwardAbort);
		}
	}



	private enqueue(command: BridgeCommand): void {
		const waiter = this.waiters.shift();
		if (waiter) { waiter(command); return; }
		if (this.queue.length >= MAX_QUEUE) {
			// Reject the just-enqueued command via its pending entry instead of silently
			// dropping. Caller's promise rejects through the regular timer cleanup.
			const pending = this.pending.get(command.id);
			if (pending) {
				clearTimeout(pending.timer);
				this.pending.delete(command.id);
				pending.reject(new Error("Chrome bridge queue full; refusing new command"));
			}
			return;
		}
		this.queue.push(command);
	}

	private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const url = new URL(request.url ?? "/", this.url);
		const corsHeaders = corsHeadersFor(request);
		// Loopback enforcement applies to every endpoint, regardless of how the listening host was
		// configured. Even with PI_CHROME_BRIDGE_DANGEROUS_REMOTE=1 we never accept non-loopback
		// connections on /next, /result, /command, or /status without future authenticated
		// transports.
		if (!isLoopbackAddress(request.socket.remoteAddress ?? undefined)) {
			sendJson(response, 403, { ok: false, error: "bridge accepts only loopback connections" });
			return;
		}
		// Top-level Content-Length precheck so oversized bodies are 413'd before any auth or
		// per-endpoint logic runs. Streaming size enforcement in readRequestBody still applies
		// for chunked requests that omit Content-Length.
		const declaredLen = Number(request.headers["content-length"]);
		if (Number.isFinite(declaredLen) && declaredLen > MAX_REQUEST_BODY_BYTES) {
			sendJson(response, 413, { ok: false, error: "request body too large" });
			request.resume();
			return;
		}
		if (request.method === "OPTIONS") {
			if (!isBrowserOriginAllowed(request)) {
				sendJson(response, 403, { ok: false, error: "browser origin not allowed" });
				return;
			}
			sendJson(response, 200, { ok: true }, corsHeaders);
			return;
		}
		if (request.method === "GET" && url.pathname === "/status") {
			sendJson(response, 200, this.status());
			return;
		}
		if (request.method === "POST" && url.pathname === "/pair") {
			// /pair is browser-originated (extension popup posts here). Loopback already enforced.
			if (!isBrowserOriginAllowed(request)) {
				sendJson(response, 403, { ok: false, error: "browser origin required" }, corsHeaders);
				return;
			}
			if (!this.auth.pairWindowActive()) {
				sendJson(response, 403, { ok: false, error: "no active pairing window; run /chrome pair in Pi first" }, corsHeaders);
				return;
			}
			const body = await readJsonBody<{ extensionId?: string; extensionNonce?: string; mac?: string }>(request, response, corsHeaders);
			if (!body) return;
			// Pin the extension ID to the one the request originates from, not the body claim.
			const originExt = this.extensionIdFromOrigin(request);
			if (!originExt) {
				sendJson(response, 403, { ok: false, error: "chrome-extension origin required for pair" }, corsHeaders);
				return;
			}
			if (body.extensionId && body.extensionId !== originExt) {
				sendJson(response, 400, { ok: false, error: "extensionId mismatch with Origin" }, corsHeaders);
				return;
			}
			try {
				const { response: payload, signedHeader } = this.auth.completePairing({ ...body, extensionId: originExt });
				sendJson(response, 200, payload, { ...corsHeaders, [AUTH_HEADER]: signedHeader });
			} catch (error) {
				sendJson(response, 401, { ok: false, error: (error as Error).message }, corsHeaders);
			}
			return;
		}
		if (request.method === "POST" && url.pathname === "/command") {
			if (!isLocalProcessRequest(request)) {
				sendJson(response, 403, { ok: false, error: "Chrome commands are accepted only from local Pi processes" });
				return;
			}
			if (!this.auth.paired) {
				sendJson(response, 401, { ok: false, error: "bridge not paired; run /chrome pair" });
				return;
			}
			// Read body first so we can verify the MAC over the exact payload received.
			const rawBody = await (async () => {
				try { return await readRequestBody(request); }
				catch (error) {
					if (error instanceof RequestBodyTooLargeError) sendJson(response, 413, { ok: false, error: "request body too large" });
					else sendJson(response, 400, { ok: false, error: `failed to read body: ${(error as Error).message}` });
					return undefined;
				}
			})();
			if (rawBody === undefined) return;
			if (!this.auth.verifyPeerRequest("POST", "/command", request.headers[AUTH_HEADER], rawBody)) {
				sendJson(response, 401, { ok: false, error: "missing or invalid bridge auth header" });
				return;
			}
			let body: { action?: string; params?: Record<string, unknown>; timeoutMs?: number };
			try { body = JSON.parse(rawBody || "{}"); }
			catch (error) { sendJson(response, 400, { ok: false, error: `invalid JSON body: ${(error as Error).message}` }); return; }
			if (!body.action || typeof body.action !== "string") {
				sendJson(response, 400, { ok: false, error: "Missing command action" });
				return;
			}
			const timeoutMs = Math.min(Math.max(Number(body.timeoutMs) || DEFAULT_TIMEOUT_MS, 1_000), 5 * 60_000);
			try {
				const result = await this.sendLocal(body.action, body.params ?? {}, timeoutMs);
				const respBody = JSON.stringify({ ok: true, result });
				const sigHeader = this.auth.signOwnerResponse("POST", "/command", respBody);
				response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...(sigHeader ? { [AUTH_HEADER]: sigHeader } : {}) });
				response.end(respBody);
			} catch (error) {
				const respBody = JSON.stringify({ ok: false, error: (error as Error).message });
				const sigHeader = this.auth.signOwnerResponse("POST", "/command", respBody);
				response.writeHead(504, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...(sigHeader ? { [AUTH_HEADER]: sigHeader } : {}) });
				response.end(respBody);
			}
			return;
		}
		if (request.method === "GET" && url.pathname === "/next") {
			if (!isBrowserOriginAllowed(request)) {
				sendJson(response, 403, { ok: false, error: "browser origin not allowed" });
				return;
			}
			const originExt = this.extensionIdFromOrigin(request);
			const currentVersion = readPiChromeVersion();
			// Pre-pairing path: return a benign idle response so old/unpaired extensions can still
			// see the version-mismatch reload hint, but never deliver commands.
			if (!this.auth.paired) {
				sendJson(response, 200, { type: "none", needsPairing: true, expectedExtensionVersion: currentVersion },
					{ ...corsHeaders, "x-pi-chrome-version": currentVersion });
				return;
			}
			// Paired: pin the request origin to the paired extension and require signed envelope.
			//
			// We distinguish two failure modes:
			//   1. Origin not pinned, OR origin pinned but auth header absent. Return 200 idle +
			//      version header so older extensions that pre-date signed envelopes (no header)
			//      can still see the version mismatch and auto-reload. They never receive
			//      commands; this is purely a migration helper.
			//   2. Pinned origin sent an auth header but it failed verification (bad sig, replayed
			//      nonce, ts skew). That is an attack signal or a stale-key paired extension; we
			//      return a hard 401 with the version header so the caller backs off and the user
			//      sees a clear failure in logs.
			const hasAuthHeader = Boolean(request.headers[AUTH_HEADER]);
			if (!originExt || originExt !== this.auth.pinnedExtensionId) {
				sendJson(response, 200, { type: "none", needsPairing: true, expectedExtensionVersion: currentVersion },
					{ ...corsHeaders, "x-pi-chrome-version": currentVersion });
				return;
			}
			if (!hasAuthHeader) {
				sendJson(response, 200, { type: "none", needsPairing: true, expectedExtensionVersion: currentVersion },
					{ ...corsHeaders, "x-pi-chrome-version": currentVersion });
				return;
			}
			if (!this.auth.verifyExtensionRequest("GET", "/next", request.headers[AUTH_HEADER], originExt, "")) {
				sendJson(response, 401, { ok: false, error: "invalid /next auth (bad sig, replayed nonce, or stale ts)" },
					{ ...corsHeaders, "x-pi-chrome-version": currentVersion });
				return;
			}
			if (this.waiters.length >= MAX_WAITERS) {
				sendJson(response, 429, { ok: false, error: "too many concurrent /next pollers" }, corsHeaders);
				return;
			}
			this.lastSeenAt = Date.now();
			this.clientName = url.searchParams.get("name") ?? undefined;
			let aborted = false;
			let activeWaiter: ((command: BridgeCommand | undefined) => void) | undefined;
			request.once("close", () => {
				aborted = true;
				if (activeWaiter) this.waiters = this.waiters.filter((entry) => entry !== activeWaiter);
			});
			let command = this.queue.shift();
			if (!command) {
				command = await this.waitForCommand(25_000, (waiter) => {
					activeWaiter = waiter;
				});
			}
			if (aborted) {
				if (command) this.queue.unshift(command);
				return;
			}
			const payload = command
				? { type: "command", command, expectedExtensionVersion: currentVersion }
				: { type: "none", expectedExtensionVersion: currentVersion };
			const respBody = JSON.stringify(payload);
			const sigHeader = this.auth.signBridgeResponse("GET", "/next", respBody);
			response.writeHead(200, {
				"content-type": "application/json; charset=utf-8",
				"cache-control": "no-store",
				...corsHeaders,
				"x-pi-chrome-version": currentVersion,
				...(sigHeader ? { [AUTH_HEADER]: sigHeader } : {}),
			});
			response.end(respBody);
			return;
		}
		if (request.method === "POST" && url.pathname === "/result") {
			if (!isBrowserOriginAllowed(request)) {
				sendJson(response, 403, { ok: false, error: "browser origin not allowed" });
				return;
			}
			if (!this.auth.paired) {
				sendJson(response, 401, { ok: false, error: "bridge not paired" }, corsHeaders);
				return;
			}
			const originExt = this.extensionIdFromOrigin(request);
			if (!originExt || originExt !== this.auth.pinnedExtensionId) {
				sendJson(response, 403, { ok: false, error: "extension origin not pinned" }, corsHeaders);
				return;
			}
			this.lastSeenAt = Date.now();
			// Read raw body, verify MAC over it, then parse.
			let rawBody: string;
			try { rawBody = await readRequestBody(request); }
			catch (error) {
				if (error instanceof RequestBodyTooLargeError) sendJson(response, 413, { ok: false, error: "request body too large" }, corsHeaders);
				else sendJson(response, 400, { ok: false, error: `failed to read body: ${(error as Error).message}` }, corsHeaders);
				return;
			}
			if (!this.auth.verifyExtensionRequest("POST", "/result", request.headers[AUTH_HEADER], originExt, rawBody)) {
				sendJson(response, 401, { ok: false, error: "invalid /result auth" }, corsHeaders);
				return;
			}
			let result: BridgeResult;
			try { result = JSON.parse(rawBody || "{}") as BridgeResult; }
			catch (error) { sendJson(response, 400, { ok: false, error: `invalid JSON: ${(error as Error).message}` }, corsHeaders); return; }
			if (!result.id || typeof result.id !== "string") {
				sendJson(response, 400, { ok: false, error: "missing command id" }, corsHeaders);
				return;
			}
			const pending = this.pending.get(result.id);
			if (!pending) {
				sendJson(response, 404, { ok: false, error: "unknown command id" }, corsHeaders);
				return;
			}
			clearTimeout(pending.timer);
			this.pending.delete(result.id);
			if (result.ok) pending.resolve(result.result);
			else pending.reject(new Error(result.error ?? "Chrome extension command failed"));
			sendJson(response, 200, { ok: true }, corsHeaders);
			return;
		}
		sendJson(response, 404, { error: "not found" });
	}

	private waitForCommand(
		timeoutMs: number,
		registerWaiter?: (waiter: (command: BridgeCommand | undefined) => void) => void,
	): Promise<BridgeCommand | undefined> {
		return new Promise((resolveWait) => {
			let settled = false;
			const waiter = (command: BridgeCommand | undefined) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				this.waiters = this.waiters.filter((entry) => entry !== waiter);
				resolveWait(command);
			};
			const timer = setTimeout(() => waiter(undefined), timeoutMs);
			this.waiters.push(waiter);
			registerWaiter?.(waiter);
		});
	}
}

const tabActionValues = ["list", "new", "activate", "close", "version"] as const;
const imageFormatValues = ["png", "jpeg"] as const;
const waitForValues = ["selector", "expression"] as const;

function StringEnum<T extends readonly [string, ...string[]]>(values: T) {
	return Type.Union(values.map((value) => Type.Literal(value)) as [ReturnType<typeof Type.Literal>, ...ReturnType<typeof Type.Literal>[]]);
}

export default function (pi: ExtensionAPI): void {
	const instanceToken = Symbol("pi-chrome-instance");
	const globalState = globalThis as typeof globalThis & {
		[PI_CHROME_GLOBAL_KEY]?: { version: string; root: string; token: symbol };
	};
	const alreadyLoaded = globalState[PI_CHROME_GLOBAL_KEY];
	if (alreadyLoaded) {
		console.warn(
			`pi-chrome already loaded from ${alreadyLoaded.root} (v${alreadyLoaded.version}); skipping duplicate from ${extensionRoot()}.`,
		);
		return;
	}
	globalState[PI_CHROME_GLOBAL_KEY] = { version: PI_CHROME_VERSION, root: extensionRoot(), token: instanceToken };

	const bridge = new ChromeProfileBridge(DEFAULT_HOST, DEFAULT_PORT);
	let backgroundDefault = false;
	let chromeAuthorizedUntil: number | "indefinite" | undefined;

	const authSummary = (): string => {
		if (chromeAuthorizedUntil === "indefinite") return "authorized indefinitely";
		if (typeof chromeAuthorizedUntil === "number") {
			const remainingMs = chromeAuthorizedUntil - Date.now();
			if (remainingMs > 0) return `authorized for ~${Math.ceil(remainingMs / 60_000)}m`;
		}
		return "locked";
	};

	const chromeControlAuthorized = (): boolean => {
		if (chromeAuthorizedUntil === "indefinite") return true;
		if (typeof chromeAuthorizedUntil === "number" && chromeAuthorizedUntil > Date.now()) return true;
		chromeAuthorizedUntil = undefined;
		return false;
	};

	const requireChromeControlAuthorized = (): void => {
		if (!chromeControlAuthorized()) {
			throw new Error("Chrome control locked. Ask the user to run /chrome authorize before using chrome_* tools.");
		}
	};

	// Status bar reflects whether chrome_* tools are currently usable for this session. We only
	// surface the indicator when authorized so an idle pi-chrome doesn't take up footer space.
	const updateChromeStatus = (ctx: ExtensionContext): void => {
		if (chromeControlAuthorized()) {
			ctx.ui.setStatus("chrome", `${ctx.ui.theme.fg("success", "●")} Chrome Bridge`);
		} else {
			ctx.ui.setStatus("chrome", undefined);
		}
	};

	const authorizedBridgeSend = (action: string, params: Record<string, unknown>, timeoutMs = DEFAULT_TIMEOUT_MS, signal?: AbortSignal): Promise<unknown> => {
		requireChromeControlAuthorized();
		return bridge.send(action, params, timeoutMs, signal);
	};

	// Translate the public `background` parameter (default false = visible/foreground) into the
	// service worker's wire-level `foreground` flag, accepting legacy `foreground` as a fallback.
	const withBackground = <T extends Record<string, unknown>>(params: T): T => {
		const typed = params as { background?: boolean; foreground?: boolean };
		const explicit =
			typed.background !== undefined
				? typed.background
				: typed.foreground !== undefined
					? !typed.foreground
					: undefined;
		const background = explicit ?? backgroundDefault;
		return { ...params, foreground: !background } as T;
	};

	pi.on("session_start", async (_event, ctx) => {
		await bridge.start();
		// No setup notify or always-on status entry. Onboarding (/chrome onboard) and pairing
		// (/chrome pair) print actionable instructions when invoked; surfacing them at every
		// session_start was noisy for users who weren't using chrome_* tools that session. The
		// status bar lights up only after /chrome authorize.
		updateChromeStatus(ctx);
	});

	pi.on("session_shutdown", () => {
		bridge.stop();
		if (globalState[PI_CHROME_GLOBAL_KEY]?.token === instanceToken) {
			delete globalState[PI_CHROME_GLOBAL_KEY];
		}
	});

	pi.on("before_agent_start", (event) => {
		const primer = `
<chrome-profile-bridge>
Chrome control is available through the chrome_* tools via a companion Chrome extension installed in the user's normal Chrome profile. Tools target the existing signed-in profile: no remote-debug port, no throwaway profile.

Capability model (important):
- Interactive controls (click/type/fill/key/hover/drag/scroll/tap) use Chrome's real input layer via chrome.debugger / CDP. Events satisfy normal user-activation gates.
- Input bypasses page CSP because it is injected at browser input layer, not page JavaScript. Chrome may show the “Pi Chrome Connector started debugging this browser” banner while attached.
- \`chrome_evaluate\` and \`chrome_snapshot\` run in MAIN world via the **Function constructor**, which requires \`'unsafe-eval'\` in the page CSP. Pages with strict CSP (e.g. github.com, many bank/SaaS apps) will throw \`EvalError: ... 'unsafe-eval' is not an allowed source of script\` and chrome_snapshot will return empty. On those pages, drive the page with \`chrome_screenshot\` + viewport-coordinate \`chrome_click\`/\`chrome_type\`/\`chrome_key\`. \`chrome_navigate\`, \`chrome_screenshot\`, \`chrome_tab\`, and Chrome input all keep working under any CSP.
- Input tools return structured details and support \`includeSnapshot=true\` on click/type/fill/key. Use the fresh snapshot to verify state instead of repeating blindly.

Usage rules:
1. If a chrome_* tool says Chrome control is locked or the bridge is not paired, ask the user to run \`/chrome pair\` (one-time) and \`/chrome authorize\` before retrying.
2. \`chrome_snapshot\` before clicking/typing; pass \`uid\` over \`selector\`.
3. \`includeSnapshot=true\` on click/type/fill/key to verify in one round trip.
4. If \`chrome_evaluate\` returns null when you expected a value, the expression evaluated to null/undefined in the page; surface the value via \`JSON.stringify\` to confirm.
5. \`chrome_navigate\` supports an optional \`initScript\` that runs at document_start in MAIN world for the next navigation (good for seeding localStorage or stubbing Date.now).
6. By default chrome_* tools focus Chrome so the user can watch; pass \`background=true\` or run /chrome background on for session-wide background execution.
7. If you hit a native file-picker or privileged browser prompt gate, tell the user; generic clicks/typing/CSP gates are handled by Chrome input.
8. Run /chrome doctor when in doubt about connectivity or capabilities.
</chrome-profile-bridge>`;
		return { systemPrompt: event.systemPrompt + primer };
	});

	// Shared handlers, dispatched by the unified /chrome command below.
	const doctorHandler = async (ctx: ExtensionContext) => {
			ctx.ui.notify("Checking pi-chrome…", "info");
			const lines: string[] = [`pi-chrome v${PI_CHROME_VERSION}`];
			const status = bridge.status();
			lines.push(`• This pi session talks to the pi-chrome daemon (every session is a peer in 0.17+).`);
			if (bridge.bridgeAuth.paired) {
				lines.push(`✓ Bridge paired with extension ${bridge.bridgeAuth.pinnedExtensionId} (bridgeId ${bridge.bridgeAuth.bridgeId}).`);
			} else {
				lines.push("✗ Bridge not yet paired with the Chrome extension. Run /chrome pair, paste the invite into the extension popup, then re-run /chrome doctor.");
			}
			let extensionAlive = false;
			let versionMismatch = false;
			// Short-circuit when the bridge can't possibly round-trip: unpaired (commands never
			// delivered) or no recent /next poll (extension absent/asleep). Otherwise we'd block
			// the doctor command for the full 35s waiting for a response that will never come.
			if (!bridge.bridgeAuth.paired) {
				lines.push("✗ Skipping extension probe — bridge isn't paired yet. Run /chrome onboard.");
			} else if (!(await bridge.daemonStatus(1_500))?.connected) {
				lines.push(
					"✗ Chrome extension hasn't polled the bridge recently.",
					"  Fix: load the extension via /chrome onboard, keep that Chrome window open, then re-run /chrome doctor.",
				);
			} else {
				try {
					const started = Date.now();
					const version = (await bridge.send("tab.version", {}, 6_000)) as {
						extensionId?: string;
						extensionVersion?: string;
						bridgeUrl?: string;
					};
					const latencyMs = Date.now() - started;
					extensionAlive = true;
					if (version.extensionVersion && version.extensionVersion !== PI_CHROME_VERSION) {
						versionMismatch = true;
						lines.push(
							`✗ The Chrome companion extension is on an old version (${version.extensionVersion}); this pi-chrome is ${PI_CHROME_VERSION}.`,
							`  Every Chrome action will run with the old code until you reload the extension.`,
							`  Fix: open chrome://extensions and click the refresh icon on 'Pi Chrome Connector'.`,
							`  (After this one-time fix, future updates reload automatically.)`,
						);
					} else {
						lines.push(`✓ Chrome is connected (companion extension v${version.extensionVersion ?? "?"}, responded in ${latencyMs}ms).`);
					}
				} catch (error) {
					const message = (error as Error).message;
					lines.push(`✗ Chrome isn't responding: ${message}`);
					if (message.includes("older pi-chrome without multi-session")) {
						lines.push("  Fix: quit and restart the pi session that first opened the Chrome connection (it was on an older pi-chrome).");
					} else {
						lines.push("  Fix: re-run /chrome onboard, or reload 'Pi Chrome Connector' at chrome://extensions and keep that Chrome window open.");
					}
				}
			}

			if (extensionAlive && !versionMismatch) {
				// Sanity-check that pi-chrome can actually run code in the active tab.
				try {
					const value = await bridge.send("page.evaluate", { expression: "1+1", awaitPromise: true, foreground: false }, 10_000);
					if (value === 2) lines.push(`✓ pi-chrome can run code in the active Chrome tab.`);
					else lines.push(`⚠ pi-chrome ran code in the active tab but got an unexpected result (${JSON.stringify(value)}). The current tab may be locked-down (a Chrome internal page or a strict site).`);
				} catch (error) {
					lines.push(`✗ pi-chrome can't run code in the active tab: ${(error as Error).message}`);
				}

				// Surface obvious site-side automation flags so the user knows why a site might block pi.
				try {
					const probe = (await bridge.send("page.probe", { foreground: false }, 10_000)) as Record<string, unknown>;
					if (probe && probe.arithmetic === 2) lines.push(`✓ The active tab is ${hostnameOf(String(probe.location))} and accepts pi-chrome's commands.`);
					if (probe && probe.webdriver) lines.push(`⚠ Your Chrome is reporting itself as automated to websites. Some sites use this signal to block sign-ins or bot checks.`);
				} catch (error) {
					lines.push(`⚠ Couldn't inspect the active tab: ${(error as Error).message}`);
				}
			} else if (versionMismatch) {
				lines.push(`… Skipped the remaining checks until you reload the Chrome extension.`);
			}

		ctx.ui.notify(lines.join("\n"), "info");
	};

	// Run-in-background (Chrome focus) handler. No args = toggle. Explicit on/off/status.
	const BACKGROUND_DESC: Record<string, string> = {
		on: "pi-chrome runs in the background; Chrome won't pop up or steal focus.",
		off: "Chrome pops to the front and switches tabs so you can watch what pi-chrome is doing.",
	};

	const backgroundHandler = async (ctx: ExtensionContext, args: string) => {
		const arg = (args || "").trim().toLowerCase();
		const currentLabel = backgroundDefault ? "on" : "off";

		if (arg === "status") {
			ctx.ui.notify(`Run in background is ${currentLabel}. ${BACKGROUND_DESC[currentLabel]}`, "info");
			return;
		}

		if (arg === "on" || arg === "true" || arg === "1") backgroundDefault = true;
		else if (arg === "off" || arg === "false" || arg === "0") backgroundDefault = false;
		else if (arg === "toggle" || arg === "") backgroundDefault = !backgroundDefault;
		else {
			ctx.ui.notify(`Unknown background setting '${arg}'. Pick one of: on | off | toggle | status.`, "warning");
			return;
		}

		const nextLabel = backgroundDefault ? "on" : "off";
		ctx.ui.notify(`Run in background → ${nextLabel}. ${BACKGROUND_DESC[nextLabel]}`, "info");
	};

	const authorizeFor = async (ctx: ExtensionContext, label: string, until: number | "indefinite") => {
		const ok = await ctx.ui.confirm(
			"Authorize pi-chrome control?",
			`This Pi session will be allowed to inspect and control your existing Chrome profile for ${label}.\n\nChrome actions use your signed-in browser state and real input. Only approve if you trust the current agent/task.`,
		);
		if (!ok) {
			ctx.ui.notify("Chrome control remains locked.", "info");
			return;
		}
		chromeAuthorizedUntil = until;
		ctx.ui.notify(`Chrome control authorized for ${label}.`, "info");
		updateChromeStatus(ctx);
	};

	const parseAuthorizeArg = (arg: string): { label: string; until: number | "indefinite" } | undefined => {
		const normalized = arg.trim().toLowerCase() || "15m";
		if (normalized === "indefinite" || normalized === "forever") return { label: "indefinitely", until: "indefinite" };
		const minutes = normalized.endsWith("m") ? Number(normalized.slice(0, -1)) : Number(normalized);
		if (!Number.isFinite(minutes) || minutes <= 0) return undefined;
		return { label: `${minutes} minutes`, until: Date.now() + minutes * 60_000 };
	};

	const authorizeHandler = async (ctx: ExtensionContext, args: string) => {
		const grant = parseAuthorizeArg(args);
		if (!grant) {
			ctx.ui.notify("Unknown authorize duration. Use minutes (15m, 30m, 45) or indefinite.", "warning");
			return;
		}
		return authorizeFor(ctx, grant.label, grant.until);
	};

	const revokeHandler = (ctx: ExtensionContext) => {
		chromeAuthorizedUntil = undefined;
		updateChromeStatus(ctx);
		ctx.ui.notify("Chrome control locked. Run /chrome authorize to allow chrome_* tools again.", "info");
	};

	// `/chrome pair` is the bare-bones pairing step, useful when the extension is already
	// installed and you just need to re-arm or re-pair. First-time setup should use
	// /chrome onboard which wraps this with installation guidance. The daemon owns the
	// pair-window state; Pi just RPCs in.
	const pairHandler = async (ctx: ExtensionContext) => {
		let replace = false;
		if (bridge.bridgeAuth.paired) {
			const ok = await ctx.ui.confirm(
				"Re-pair Chrome bridge?",
				"The bridge is already paired with a Chrome extension. Re-pairing will invalidate the current keys and you'll need to re-paste the new invite into the extension popup.\n\nPress Enter to continue, or Esc to cancel.",
			);
			if (!ok) { ctx.ui.notify("Pairing cancelled.", "info"); return; }
			replace = true;
		}
		let invite: string;
		try {
			const resp = await bridge.admin("arm-pair-window", { replace });
			invite = String(resp.invite);
		} catch (error) {
			ctx.ui.notify(`Failed to arm pair window: ${(error as Error).message}`, "warning");
			return;
		}
		await copyToClipboard(ctx, invite);
		ctx.ui.notify(
			[
				"Pairing invite (also copied to clipboard):",
				"",
				`    ${invite}`,
				"",
				"In Chrome, click the Pi Chrome Connector toolbar icon, paste this invite, and click 'Pair'.",
				`Invite expires in ${Math.round(PAIR_WINDOW_MS / 60_000)} minutes. After pairing, run /chrome authorize to allow chrome_* tools.`,
			].join("\n"),
			"info",
		);
	};

	const unpairHandler = async (ctx: ExtensionContext) => {
		if (!bridge.bridgeAuth.paired) {
			ctx.ui.notify("pi-chrome is not currently paired.", "info");
			return;
		}
		const proceed = await ctx.ui.confirm(
			"Unpair Chrome bridge?",
			"This clears the stored extension ID + HMAC keys. Every Pi session will need to re-pair (and the Chrome extension popup will need to be re-armed).\n\nPress Enter to confirm, or Esc to cancel.",
		);
		if (!proceed) { ctx.ui.notify("Unpair cancelled.", "info"); return; }
		try {
			await bridge.admin("reset");
			ctx.ui.notify("pi-chrome unpaired. Run /chrome pair to start a new pairing.", "info");
		} catch (error) {
			ctx.ui.notify(`Failed to unpair: ${(error as Error).message}`, "warning");
		}
	};

	const copyToClipboard = async (ctx: ExtensionContext, text: string): Promise<void> => {
		if (process.platform === "darwin") {
			await pi.exec("sh", ["-lc", `printf %s ${JSON.stringify(text)} | pbcopy`], { cwd: workspaceCwd(ctx), timeout: 5_000 }).catch(() => undefined);
		} else if (process.platform === "linux") {
			await pi.exec("sh", ["-lc", `printf %s ${JSON.stringify(text)} | (xclip -selection clipboard 2>/dev/null || xsel --clipboard --input 2>/dev/null || wl-copy 2>/dev/null) || true`], { cwd: workspaceCwd(ctx), timeout: 5_000 }).catch(() => undefined);
		}
	};

	// `/chrome onboard` (aliased as `/chrome install`) is the idempotent recovery path. It can
	// be re-run any number of times to bring a broken machine back to a known-good state,
	// regardless of what older versions of pi-chrome left behind:
	//
	//   * It always resets the Pi-side pairing record before issuing a new invite, so a stale
	//     `~/.config/pi/chrome-bridge.json` (e.g. paired against an old extension instance whose
	//     keys were never persisted in Chrome's storage) cannot silently keep the bridge in a
	//     half-paired state.
	//   * It opens chrome://extensions + the extension folder and tells the user to either Load
	//     unpacked (first install) OR click the reload icon on the existing card (covers the
	//     v0.15.x → 0.16.x migration where the SW must be re-loaded to gain the /pair logic).
	//   * It then **actively verifies** progress at each step rather than trusting confirm()
	//     clicks: it polls `bridge.status().connected` to confirm the extension is polling
	//     `/next`, polls `bridge.bridgeAuth.paired` to confirm the popup successfully completed
	//     the /pair handshake, and finally round-trips a real `tab.version` call to confirm the
	//     end-to-end signed-envelope path works.
	//
	// If any of those steps fail, it prints a concrete fix and stops; rerunning is always safe.
	const onboardHandler = async (ctx: ExtensionContext) => {
		// Note: we deliberately do NOT early-return on client mode here. Onboarding is precisely
		// the recovery path for the case where a foreign Pi process owns the bridge — the Step 0
		// foreign-owner takeover below will kill that process and re-bind locally.
		const extensionPath = browserExtensionPath();

		const proceed = await ctx.ui.confirm(
			"pi-chrome onboard",
			[
				"This will set up Chrome control from scratch:",
				"  1. Reset any stale pairing state on the Pi side.",
				"  2. Walk you through (re-)loading the Chrome extension.",
				"  3. Mint a fresh pairing invite and wait for you to paste it into the popup.",
				"  4. Verify a real Chrome round-trip works.",
				"",
				"Safe to re-run any time; nothing else changes.",
				"",
				"Press Enter to continue, or Esc to cancel.",
			].join("\n"),
		);
		if (!proceed) {
			ctx.ui.notify("Cancelled. Run /chrome onboard again whenever you're ready.", "info");
			return;
		}

		// --- Step 1: reset daemon-side pairing state. ------------------------------------
		// In 0.17 the daemon is automatically spawned/upgraded at session_start (see
		// ChromeProfileBridge.ensureDaemonRunning), so /chrome onboard no longer needs to
		// detect-and-kill stale owners. We just admin-reset the pairing record and proceed.
		// Daemon clears `~/.config/pi/chrome-bridge.json` on its side. Any cached extension keys
		// in chrome.storage.local will become invalid, but that's fine because we're about to
		// mint a fresh invite and re-pair. fs.watch + refreshIfStale on the daemon's BridgeAuth
		// also propagates the reset to in-memory state immediately.
		const hadPriorPairing = bridge.bridgeAuth.paired;
		try { await bridge.admin("reset"); } catch (error) {
			ctx.ui.notify(`Failed to reset prior pairing: ${(error as Error).message}`, "warning");
			return;
		}
		if (hadPriorPairing) {
			ctx.ui.notify(
				"Cleared the previous pairing record. The extension popup may still show 'Paired' until it polls again; that's fine — we'll re-pair below.",
				"info",
			);
		}

		// --- Step 2: install or reload the Chrome extension. -----------------------------
		if (process.platform === "darwin") {
			await pi.exec("open", ["-a", "Google Chrome", "chrome://extensions"], { cwd: workspaceCwd(ctx), timeout: 5_000 }).catch(() => undefined);
			await pi.exec("open", ["-R", extensionPath], { cwd: workspaceCwd(ctx), timeout: 5_000 }).catch(() => undefined);
		}
		await copyToClipboard(ctx, extensionPath);
		ctx.ui.notify(
			[
				"Step 1 of 3 — install or reload the Chrome extension",
				"",
				"Open chrome://extensions. Two cases:",
				"",
				"  A. If 'Pi Chrome Connector' is NOT listed:",
				"     • Toggle Developer mode (top-right).",
				"     • Click 'Load unpacked'.",
				`     • Pick the folder that just opened in Finder, or paste this path (it's on your clipboard):`,
				`         ${extensionPath}`,
				"",
				"  B. If 'Pi Chrome Connector' IS listed:",
				"     • Click the refresh (↻) icon on its card so the service worker reloads with the current code.",
				"",
				"Press Enter once the extension card shows 'Pi Chrome Connector' (recent load time).",
			].join("\n"),
			"info",
		);
		const ready = await ctx.ui.confirm(
			"Extension loaded / reloaded?",
			"Confirm once Pi Chrome Connector is listed and active. Press Esc to abort.",
		);
		if (!ready) {
			ctx.ui.notify("Cancelled before pairing. Re-run /chrome onboard whenever ready.", "info");
			return;
		}

		// --- Step 2.5: wait for the SW to start polling /next. ---------------------------
		// Without this gate, a paused service worker (or an extension that didn't actually
		// reload) lets the user proceed to step 3 only to have pairing silently fail. Active
		// poll = lastSeenAt updates = `bridge.status().connected` flips true.
		ctx.ui.notify("Waiting for the extension to wake up and poll the bridge…", "info");
		const connectStart = Date.now();
		let connected = false;
		while (Date.now() - connectStart < 15_000) {
			const ds = await bridge.daemonStatus(1_500);
			if (ds && ds.connected === true) { connected = true; break; }
			await new Promise((r) => setTimeout(r, 500));
		}
		if (!connected) {
			ctx.ui.notify(
				[
					"✗ The Chrome extension didn't poll the bridge within 15 s.",
					"  Common causes:",
					"    • Service worker is suspended. Open chrome://extensions → 'service worker' link on the Pi Chrome Connector card to wake it.",
					"    • The extension didn't load (folder permission, wrong path). Try Load unpacked again with the path on your clipboard.",
					"    • The extension is disabled. Toggle it on.",
					"",
					"  Fix and re-run /chrome onboard — it's idempotent.",
				].join("\n"),
				"warning",
			);
			return;
		}
		ctx.ui.notify("✓ Extension is polling.", "info");

		// --- Step 3: mint invite, wait for the popup to complete the /pair handshake. ----
		let invite: string;
		try {
			const resp = await bridge.admin("arm-pair-window", { replace: true });
			invite = String(resp.invite);
		} catch (error) {
			ctx.ui.notify(`Failed to arm pair window: ${(error as Error).message}`, "warning");
			return;
		}
		await copyToClipboard(ctx, invite);
		ctx.ui.notify(
			[
				"Step 2 of 3 — pair the extension with this bridge",
				"",
				"  1. Click the Pi Chrome Connector icon in Chrome's toolbar (puzzle-piece menu, pin it if needed).",
				"  2. Paste the invite below into the popup and click 'Pair'.",
				"",
				`  Invite (also on your clipboard):  ${invite}`,
				"",
				`  Window: ${Math.round(PAIR_WINDOW_MS / 60_000)} min. Pi will detect the pair automatically; you don't need to press anything here.`,
			].join("\n"),
			"info",
		);
		const pairStart = Date.now();
		while (Date.now() - pairStart < PAIR_WINDOW_MS) {
			if (bridge.bridgeAuth.paired) break;
			await new Promise((r) => setTimeout(r, 500));
		}
		if (!bridge.bridgeAuth.paired) {
			ctx.ui.notify("✗ Pairing window expired with no /pair from the extension. Re-run /chrome onboard.", "warning");
			return;
		}
		ctx.ui.notify("✓ Bridge paired with the extension.", "info");

		// --- Step 4: verify a real round-trip. -------------------------------------------
		try {
			const version = (await bridge.send("tab.version", {}, 5_000)) as { extensionVersion?: string };
			ctx.ui.notify(`✓ Step 3 of 3 — Chrome round-trip OK (extension v${version.extensionVersion ?? "?"}).`, "info");
		} catch (error) {
			ctx.ui.notify(
				[
					`⚠ Pairing succeeded but a test round-trip failed: ${(error as Error).message}`,
					"  Possible causes:",
					"    • Chrome was switched to a chrome:// or chrome-extension:// tab; pi-chrome can't run there. Switch to a normal http(s) tab and run /chrome doctor.",
					"    • Service worker went back to sleep between pair and probe. Click the extension icon once and re-run /chrome doctor.",
				].join("\n"),
				"warning",
			);
			return;
		}

		ctx.ui.notify(
			"All set. Run /chrome authorize 15m (or longer) before using chrome_* tools.",
			"info",
		);
	};

	// `probeExtension` short-circuits before issuing a bridge.send when we already know the
	// command can't round-trip, so /chrome status / doctor / onboard don't block for the full
	// timeout. Returns a single line summarising the result.
	//
	// Order of checks:
	//   1. Bridge unpaired — no command will ever be delivered (/next returns idle), so don't
	//      bother sending. Tell the user to run /chrome onboard.
	//   2. Extension hasn't polled /next recently — the bridge has no live connection. Skip the
	//      send and report disconnected immediately.
	//   3. Otherwise probe with a short timeout (paired + recent /next means a round-trip
	//      should complete in <1s; 3s is plenty).
	const probeExtension = async (timeoutMs = 3_000): Promise<string> => {
		if (!bridge.bridgeAuth.paired) {
			return "✗ Chrome bridge not paired (run /chrome onboard)";
		}
		const ds = await bridge.daemonStatus(1_000);
		if (!ds?.connected) {
			return "✗ Chrome extension not polling (load extension via /chrome onboard, keep Chrome open)";
		}
		try {
			const version = (await bridge.send("tab.version", {}, timeoutMs)) as { extensionVersion?: string };
			if (version.extensionVersion && version.extensionVersion !== PI_CHROME_VERSION) {
				return `⚠ Chrome extension v${version.extensionVersion} (pi-chrome v${PI_CHROME_VERSION}, reload extension)`;
			}
			return `✓ Chrome connected`;
		} catch {
			return `✗ Chrome not responding within ${timeoutMs}ms`;
		}
	};

	// One-line snapshot of pi-chrome's current state. Used as a header in the bare-/chrome
	// picker and as the body of /chrome status.
	const statusSummary = async (): Promise<string> => {
		return [
			await probeExtension(2_000),
			`auth: ${authSummary()}`,
			`background: ${backgroundDefault ? "on" : "off"}`,
		].join(" · ");
	};

	const statusHandler = async (ctx: ExtensionContext) => {
		ctx.ui.notify("Checking Chrome connection…", "info");
		ctx.ui.notify(await statusSummary(), "info");
	};

	const openAuthorizeMenu = async (ctx: ExtensionContext): Promise<void> => {
		while (true) {
			const choice = await ctx.ui.select("Authorize Chrome control", [
				"15 minutes",
				"30 minutes",
				"Indefinite",
				"Custom minutes",
			]);
			if (!choice) return;
			switch (choice) {
				case "15 minutes": return authorizeHandler(ctx, "15m");
				case "30 minutes": return authorizeHandler(ctx, "30m");
				case "Indefinite": return authorizeHandler(ctx, "indefinite");
				case "Custom minutes": {
					const value = await ctx.ui.input("Authorize for how many minutes?", "45");
					if (!value) continue;
					return authorizeHandler(ctx, value);
				}
			}
		}
	};

	const openBackgroundMenu = async (ctx: ExtensionContext): Promise<void> => {
		const choice = await ctx.ui.select("Background / watch mode", [
			"Use Chrome in background",
			"Use Chrome in foreground",
		]);
		if (!choice) return;
		switch (choice) {
			case "Use Chrome in background": return backgroundHandler(ctx, "on");
			case "Use Chrome in foreground": return backgroundHandler(ctx, "off");
		}
	};

	const openCommandMenu = async (ctx: ExtensionContext): Promise<void> => {
		while (true) {
			ctx.ui.notify("Checking Chrome connection…", "info");
			const choice = await ctx.ui.select(`pi-chrome\n${await statusSummary()}`, [
				"Authorize Chrome control…",
				"Lock Chrome control",
				"Doctor / troubleshoot",
				"Background / watch mode…",
				"Install / onboard extension",
			]);
			if (!choice) return;
			switch (choice) {
				case "Authorize Chrome control…": await openAuthorizeMenu(ctx); continue;
				case "Lock Chrome control": return revokeHandler(ctx);
				case "Doctor / troubleshoot": return doctorHandler(ctx);
				case "Background / watch mode…": await openBackgroundMenu(ctx); continue;
				case "Install / onboard extension": return onboardHandler(ctx);
			}
		}
	};

	pi.registerCommand("chrome", {
		description:
			"All pi-chrome controls in one place.\n\n  First-time setup (do these once, in this order):\n    /chrome onboard  — idempotent: install/reload the Chrome extension AND pair it with this Pi bridge. Safe to re-run any time — it'll bring a broken machine back to a known-good state.\n    /chrome install  — alias for /chrome onboard.\n    /chrome authorize [15m|30m|<minutes>|indefinite] — unlock chrome_* tools for this Pi session.\n\n  Day-to-day:\n    /chrome authorize — unlock chrome_* tools (per session).\n    /chrome revoke    — lock chrome_* tools again.\n    /chrome status    — one-line snapshot of connection, auth, and background setting.\n    /chrome doctor    — full health check; tells you exactly what's missing.\n\n  Maintenance (rare):\n    /chrome pair      — (re-)pair the extension when only pairing is missing.\n    /chrome unpair    — clear pairing keys; every Pi session will need to re-pair.\n    /chrome background [on|off|status|toggle] — run without focusing Chrome.\n\nRun with no arguments for an interactive picker that shows current state.",
		getArgumentCompletions: (prefix) => {
			const raw = prefix;
			const trimmedRight = raw.replace(/\s+$/, "");
			const tokens = trimmedRight ? trimmedRight.split(/\s+/) : [];
			const endsWithSpace = raw.length > 0 && raw !== trimmedRight;
			// Path = completed tokens; partial = the token currently being typed (or "" if cursor sits right after a space).
			const partial = endsWithSpace ? "" : (tokens.pop() ?? "");
			const path = tokens.map((t) => t.toLowerCase());
			const partialLower = partial.toLowerCase();

			// Build candidate set with FULL argument-text values so pi-tui's apply-completion
			// (which replaces the entire argument) lands correctly even for nested paths.
			type Item = { fullValue: string; label: string; description: string };
			let candidates: Item[] = [];
			if (path.length === 0) {
				candidates = [
					{ fullValue: "onboard", label: "onboard", description: "Idempotent recovery flow: install/reload extension + (re-)pair + verify round-trip. Safe to re-run anytime." },
					{ fullValue: "install", label: "install", description: "Alias for /chrome onboard." },
					{ fullValue: "authorize", label: "authorize", description: "Unlock chrome_* tools for this Pi session." },
					{ fullValue: "revoke", label: "revoke", description: "Lock chrome_* tools again." },
					{ fullValue: "status", label: "status", description: "One-line summary: connection, auth, and background setting." },
					{ fullValue: "doctor", label: "doctor", description: "Full health check. Tells you exactly what's missing if chrome_* isn't working." },
					{ fullValue: "pair", label: "pair", description: "Re-pair an already-installed extension (use /chrome onboard for first-time setup)." },
					{ fullValue: "unpair", label: "unpair", description: "Clear pairing keys (forces every Pi session to re-pair)." },
					{ fullValue: "background", label: "background", description: "Run pi-chrome in the background without focusing Chrome?" },
				];
			} else if (path[0] === "authorize" && path.length === 1) {
				candidates = [
					{ fullValue: "authorize 15m", label: "15m", description: "Authorize Chrome control for 15 minutes." },
					{ fullValue: "authorize 30m", label: "30m", description: "Authorize Chrome control for 30 minutes." },
					{ fullValue: "authorize indefinite", label: "indefinite", description: "Authorize Chrome control until revoked or Pi exits." },
				];
			} else if (path[0] === "background" && path.length === 1) {
				candidates = [
					{ fullValue: "background on", label: "on", description: "Run in background. Chrome stays in the background. Your editor keeps focus." },
					{ fullValue: "background off", label: "off", description: "Bring Chrome to the front so you can watch (default)." },
					{ fullValue: "background toggle", label: "toggle", description: "Flip whichever way it's currently set." },
					{ fullValue: "background status", label: "status", description: "Show the current setting." },
				];
			}
			if (candidates.length === 0) return null;
			const filtered = candidates.filter((c) => c.label.toLowerCase().startsWith(partialLower));
			if (filtered.length === 0) return null;
			return filtered.map((c) => ({ value: c.fullValue, label: c.label, description: c.description }));
		},
		handler: async (args, ctx) => {
			const tokens = (args || "").trim().split(/\s+/).filter(Boolean);
			if (tokens.length === 0) {
				await openCommandMenu(ctx);
				return;
			}
			const [head, ...rest] = tokens;
			const subArgs = rest.join(" ");
			switch (head) {
				case "pair": return pairHandler(ctx);
				case "unpair": return unpairHandler(ctx);
				case "install": return onboardHandler(ctx);
				case "authorize": return authorizeHandler(ctx, subArgs);
				case "revoke": return revokeHandler(ctx);
				case "status": return statusHandler(ctx);
				case "doctor": return doctorHandler(ctx);
				case "onboard": return onboardHandler(ctx);
				case "background":
					return backgroundHandler(ctx, subArgs);
				case "settings": {
					// Legacy nested form: /chrome settings background ...
					const [setting, ...settingArgs] = rest;
					if (setting === "background") return backgroundHandler(ctx, settingArgs.join(" "));
					ctx.ui.notify(`'/chrome settings' was removed. Use /chrome background directly.`, "warning");
					return;
				}
				default:
					ctx.ui.notify(`Unknown subcommand '${head}'. Try: /chrome authorize | revoke | status | doctor | onboard | background.`, "warning");
			}
		},
	});

	pi.registerTool({
		name: "chrome_launch",
		label: "Chrome Bridge Setup",
		description:
			"Start/check the local bridge used by the companion Chrome extension. This does not launch a separate Chrome profile; install the unpacked Chrome extension in your existing Chrome profile to connect.",
		promptSnippet: "Show instructions for connecting Pi to the user's existing Chrome profile via the companion extension.",
		parameters: Type.Object({
			port: Type.Optional(Type.Number({ description: "Ignored. The bundled Chrome extension polls 127.0.0.1:17318." })),
			url: Type.Optional(Type.String({ description: "Optional URL to open in the existing Chrome profile after the extension is connected." })),
			userDataDir: Type.Optional(Type.String({ description: "Ignored. This bridge intentionally uses the user's existing Chrome profile through the companion extension." })),
			useDefaultProfile: Type.Optional(Type.Boolean({ description: "Ignored; existing-profile access comes from the companion Chrome extension." })),
			headless: Type.Optional(Type.Boolean({ description: "Ignored." })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx): Promise<ToolTextResult> {
			if (params.url && bridge.connected) {
				const result = await authorizedBridgeSend("tab.new", { url: params.url }, DEFAULT_TIMEOUT_MS, signal);
				return { content: [{ type: "text", text: `Chrome bridge connected; opened ${params.url}` }], details: { status: bridge.status(), result } };
			}
			return {
				content: [
					{
						type: "text",
						text:
							`Chrome profile bridge is listening at ${bridge.url}.\n\n` +
							`To connect your existing Chrome profile:\n` +
							`1. Open chrome://extensions in the Chrome profile you normally use.\n` +
							`2. Enable Developer mode.\n` +
							`3. Click “Load unpacked”.\n` +
							`4. Select: ${browserExtensionPath()}\n\n` +
							`Status: ${bridge.connected ? "connected" : "waiting for extension"}.`,
					},
				],
				details: { status: bridge.status(), extensionPath: browserExtensionPath() },
			};
		},
	});

	pi.registerTool({
		name: "chrome_tab",
		label: "Chrome Tab",
		description: "List, create, activate, close, or inspect tabs in the user's existing Chrome profile via the companion extension.",
		promptSnippet: "List/open/activate/close existing Chrome tabs through the companion extension.",
		parameters: Type.Object({
			action: StringEnum(tabActionValues),
			url: Type.Optional(Type.String({ description: "URL for action=new." })),
			targetId: Type.Optional(Type.String({ description: "Chrome tab id for activate/close." })),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const result = await authorizedBridgeSend(`tab.${params.action}`, params, DEFAULT_TIMEOUT_MS, signal);
			if (params.action === "list") {
				const tabs = result as Array<{ id: number; title: string; url: string; active: boolean; windowId: number }>;
				const text = tabs.map((tab) => `${tab.id}\t${tab.active ? "*" : " "}\t${tab.title || "(untitled)"}\t${tab.url}`).join("\n") || "No tabs.";
				return { content: [{ type: "text", text }], details: { tabs } };
			}
			return { content: [{ type: "text", text: safeJson(result) }], details: { result: result as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_snapshot",
		label: "Chrome Snapshot",
		description:
			"Inspect a page in the user's existing Chrome profile: title, URL, visible body text, viewport, and clickable/focusable elements with stable uids plus CSS selectors. Brings Chrome to the foreground by default so the user can watch; pass background=true to inspect silently.",
		promptSnippet: "Inspect the current Chrome page and get CSS selectors for browser automation.",
		parameters: Type.Object({
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			maxElements: Type.Optional(Type.Number({ default: MAX_ELEMENTS })),
			containingText: Type.Optional(Type.String({ description: "Only return elements whose label/text contains this string (case-insensitive). Useful when the page has many controls." })),
			roleFilter: Type.Optional(Type.String({ description: "Only return elements matching this ARIA role or tag name (case-insensitive). e.g. 'button', 'link', 'textbox'." })),
			nearUid: Type.Optional(Type.String({ description: "Sort elements by proximity to this snapshot uid. Useful for finding controls near a known anchor." })),
			background: Type.Optional(
				Type.Boolean({ description: "If true, run silently in the background without focusing Chrome. Default false (Chrome focuses + tab activates so the user can watch)." }),
			),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const snapshot = await authorizedBridgeSend(
				"page.snapshot",
				withBackground({ ...params, maxElements: params.maxElements ?? MAX_ELEMENTS }),
				DEFAULT_TIMEOUT_MS,
				signal,
			);
			return { content: [{ type: "text", text: truncateText(safeJson(snapshot)) }], details: { snapshot } };
		},
	});

	pi.registerTool({
		name: "chrome_navigate",
		label: "Chrome Navigate",
		description:
			"Navigate an existing Chrome tab to a URL via the companion extension. By default focuses Chrome and activates the tab so the user can watch; pass background=true to navigate silently. Optionally waits for load completion.",
		promptSnippet: "Navigate a Chrome tab in the user's existing profile.",
		parameters: Type.Object({
			url: Type.String(),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			waitUntilLoad: Type.Optional(Type.Boolean({ default: true })),
			timeoutMs: Type.Optional(Type.Number({ default: 15_000 })),
			initScript: Type.Optional(Type.String({ description: "Optional JavaScript source to run in MAIN world at document_start of the next navigation. Useful for seeding localStorage, stubbing Date.now(), or defining navigator.webdriver=undefined. Requires the companion extension's webNavigation permission." })),
			background: Type.Optional(
				Type.Boolean({ description: "If true, navigate silently without focusing Chrome. Default false." }),
			),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const result = await authorizedBridgeSend("page.navigate", withBackground(params), (params.timeoutMs ?? 15_000) + 2_000, signal);
			return { content: [{ type: "text", text: `Navigated to ${params.url}${params.initScript ? " (with initScript)" : ""}` }], details: { result: result as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_evaluate",
		label: "Chrome Evaluate",
		description:
			"Evaluate JavaScript in an existing Chrome tab through the companion extension. Runs in the page context and returns JSON-serializable values when possible. By default focuses Chrome and activates the tab; pass background=true to evaluate silently.",
		promptSnippet: "Evaluate JavaScript in the active Chrome tab through the companion extension.",
		parameters: Type.Object({
			expression: Type.String(),
			awaitPromise: Type.Optional(Type.Boolean({ default: true })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(
				Type.Boolean({ description: "If true, evaluate silently without focusing Chrome. Default false." }),
			),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const value = await authorizedBridgeSend("page.evaluate", withBackground(params), DEFAULT_TIMEOUT_MS, signal);
			const text = value === undefined
				? "undefined"
				: typeof value === "string"
					? value
					: safeJson(value) ?? "undefined";
			return { content: [{ type: "text", text: truncateText(text) }], details: { value: value as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_click",
		label: "Chrome Click",
		description:
			"Click a snapshot uid, CSS selector, or viewport coordinate using Chrome's real input layer. Pass includeSnapshot=true to return a fresh snapshot after the click.",
		promptSnippet: "Click page elements in Chrome by snapshot uid, selector, or viewport coordinate.",
		parameters: Type.Object({
			uid: Type.Optional(Type.String({ description: "Stable element uid from chrome_snapshot. Prefer uid over selector after taking a snapshot." })),
			selector: Type.Optional(Type.String({ description: "CSS selector to click. Prefer uid from chrome_snapshot when available." })),
			x: Type.Optional(Type.Number({ description: "Viewport x coordinate if uid/selector is omitted." })),
			y: Type.Optional(Type.Number({ description: "Viewport y coordinate if uid/selector is omitted." })),
			includeSnapshot: Type.Optional(Type.Boolean({ description: "If true, include a fresh chrome_snapshot result after the click." })),
			maxElements: Type.Optional(Type.Number({ default: MAX_ELEMENTS, description: "Max elements in the included snapshot." })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(
				Type.Boolean({ description: "If true, click silently without focusing Chrome. Default false." }),
			),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const raw = await authorizedBridgeSend("page.click", withBackground(params), DEFAULT_TIMEOUT_MS, signal);
			const result = (params.includeSnapshot ? (raw as { result: unknown }).result : raw) as Json;
			const summary = summarizeActionResult(result);
			const target = params.uid ?? params.selector ?? `${params.x},${params.y}`;
			const text = summary ? `Clicked ${target} — ${summary}` : `Clicked ${target}`;
			return { content: [{ type: "text", text }], details: { result: raw as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_type",
		label: "Chrome Type",
		description:
			"Focus an optional snapshot uid or CSS selector, then type text using Chrome's real keyboard input. Pass includeSnapshot=true to return a fresh snapshot after typing.",
		promptSnippet: "Type text into Chrome, optionally focusing a snapshot uid or selector first.",
		parameters: Type.Object({
			text: Type.String(),
			uid: Type.Optional(Type.String({ description: "Stable element uid from chrome_snapshot." })),
			selector: Type.Optional(Type.String({ description: "CSS selector to focus before typing." })),
			includeSnapshot: Type.Optional(Type.Boolean({ description: "If true, include a fresh chrome_snapshot result after typing." })),
			maxElements: Type.Optional(Type.Number({ default: MAX_ELEMENTS, description: "Max elements in the included snapshot." })),
			pressEnter: Type.Optional(Type.Boolean()),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(
				Type.Boolean({ description: "If true, type silently without focusing Chrome. Default false." }),
			),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const raw = await authorizedBridgeSend("page.type", withBackground(params), DEFAULT_TIMEOUT_MS, signal);
			const result = (params.includeSnapshot ? (raw as { result: unknown }).result : raw) as Json;
			const summary = summarizeActionResult(result);
			const into = params.uid || params.selector ? ` into ${params.uid ?? params.selector}` : "";
			const base = `Typed ${params.text.length} character(s)${into}.`;
			return { content: [{ type: "text", text: summary ? `${base} (${summary})` : base }], details: { result: raw as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_fill",
		label: "Chrome Fill",
		description:
			"Set the full value of a text input, textarea, or contenteditable element using Chrome click/select/delete/type input. Accepts a snapshot uid or CSS selector. Pass includeSnapshot=true to verify after filling.",
		promptSnippet: "Fill a Chrome form field by snapshot uid or selector, optionally returning a fresh snapshot.",
		parameters: Type.Object({
			text: Type.String(),
			uid: Type.Optional(Type.String({ description: "Stable element uid from chrome_snapshot." })),
			selector: Type.Optional(Type.String({ description: "CSS selector to fill if uid is omitted." })),
			submit: Type.Optional(Type.Boolean({ description: "If true, press Enter after filling." })),
			includeSnapshot: Type.Optional(Type.Boolean({ description: "If true, include a fresh chrome_snapshot result after filling." })),
			maxElements: Type.Optional(Type.Number({ default: MAX_ELEMENTS, description: "Max elements in the included snapshot." })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(
				Type.Boolean({ description: "If true, fill silently without focusing Chrome. Default false." }),
			),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const raw = await authorizedBridgeSend("page.fill", withBackground(params), DEFAULT_TIMEOUT_MS, signal);
			const result = (params.includeSnapshot ? (raw as { result: unknown }).result : raw) as Json;
			const summary = summarizeActionResult(result);
			const into = params.uid || params.selector ? ` into ${params.uid ?? params.selector}` : "";
			const base = `Filled ${params.text.length} character(s)${into}.`;
			return { content: [{ type: "text", text: summary ? `${base} (${summary})` : base }], details: { result: raw as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_key",
		label: "Chrome Key",
		description:
			"Send a keyboard key to an existing Chrome tab (Enter, Escape, Tab, Backspace, Delete, ArrowUp/Down/Left/Right, or one character). By default focuses Chrome and activates the tab so the user can watch; pass background=true to send the key silently. Pass includeSnapshot=true to verify after the keypress.",
		promptSnippet: "Press keys in Chrome through the companion extension.",
		parameters: Type.Object({
			key: Type.String(),
			modifiers: Type.Optional(Type.Object({
				shiftKey: Type.Optional(Type.Boolean()),
				ctrlKey: Type.Optional(Type.Boolean()),
				altKey: Type.Optional(Type.Boolean()),
				metaKey: Type.Optional(Type.Boolean()),
			}, { description: "Modifier keys to hold while pressing the key (chord)." })),
			includeSnapshot: Type.Optional(Type.Boolean({ description: "If true, include a fresh chrome_snapshot result after the keypress." })),
			maxElements: Type.Optional(Type.Number({ default: MAX_ELEMENTS, description: "Max elements in the included snapshot." })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(
				Type.Boolean({ description: "If true, send the key silently without focusing Chrome. Default false." }),
			),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const raw = await authorizedBridgeSend("page.key", withBackground(params), DEFAULT_TIMEOUT_MS, signal);
			const result = (params.includeSnapshot ? (raw as { result: unknown }).result : raw) as Json;
			const summary = summarizeActionResult(result);
			const base = `Pressed ${params.key}.`;
			return { content: [{ type: "text", text: summary ? `${base} (${summary})` : base }], details: { result: raw as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_wait_for",
		label: "Chrome Wait For",
		description: "Poll an existing Chrome tab until a selector exists or a JavaScript expression returns truthy.",
		promptSnippet: "Wait for page state in Chrome before further automation.",
		parameters: Type.Object({
			kind: StringEnum(waitForValues),
			value: Type.String({ description: "CSS selector when kind=selector; JavaScript expression when kind=expression." }),
			timeoutMs: Type.Optional(Type.Number({ default: 10_000 })),
			intervalMs: Type.Optional(Type.Number({ default: 250 })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const result = await authorizedBridgeSend("page.waitFor", params, (params.timeoutMs ?? 10_000) + 2_000, signal);
			return { content: [{ type: "text", text: `Observed ${params.kind}: ${params.value}` }], details: { result: result as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_list_console_messages",
		label: "Chrome Console Messages",
		description:
			"List console messages captured in the page by the companion extension. Capture starts after any chrome_snapshot, chrome_evaluate, chrome_list_console_messages, or chrome_list_network_requests call installs page instrumentation.",
		promptSnippet: "List captured console messages from the active Chrome page.",
		parameters: Type.Object({
			clear: Type.Optional(Type.Boolean({ description: "Clear the captured console log after reading." })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean({ description: "If true, run silently without focusing Chrome. Default false." })),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const result = await authorizedBridgeSend("page.console.list", withBackground(params), DEFAULT_TIMEOUT_MS, signal);
			return { content: [{ type: "text", text: truncateText(safeJson(result)) }], details: { result: result as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_list_network_requests",
		label: "Chrome Network Requests",
		description:
			"List fetch/XMLHttpRequest activity captured in the page by the companion extension. Capture starts after instrumentation is installed by snapshot/evaluate/network/console tools; browser document/static asset requests are not captured. Use includePreservedRequests=true to keep requests from earlier same-tab navigations that were captured before navigation.",
		promptSnippet: "List captured XHR/fetch requests from the active Chrome page before doing DOM-heavy debugging.",
		parameters: Type.Object({
			includePreservedRequests: Type.Optional(Type.Boolean({ description: "Include captured requests from earlier locations in the same tab/session." })),
			clear: Type.Optional(Type.Boolean({ description: "Clear the captured request log after reading." })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean({ description: "If true, run silently without focusing Chrome. Default false." })),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const result = await authorizedBridgeSend("page.network.list", withBackground(params), DEFAULT_TIMEOUT_MS, signal);
			return { content: [{ type: "text", text: truncateText(safeJson(result)) }], details: { result: result as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_get_network_request",
		label: "Chrome Network Request",
		description: "Retrieve one captured fetch/XMLHttpRequest entry, including response body when available, by requestId from chrome_list_network_requests.",
		promptSnippet: "Fetch captured request details and response body by requestId.",
		parameters: Type.Object({
			requestId: Type.String({ description: "Request id returned by chrome_list_network_requests." }),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean({ description: "If true, run silently without focusing Chrome. Default false." })),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const result = await authorizedBridgeSend("page.network.get", withBackground(params), DEFAULT_TIMEOUT_MS, signal);
			return { content: [{ type: "text", text: truncateText(safeJson(result)) }], details: { result: result as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_screenshot",
		label: "Chrome Screenshot",
		description:
			"Capture a screenshot of an existing Chrome tab via the companion extension and save it to disk. Chrome's extension screenshot API requires the target tab to be the active tab in its window. By default Chrome is focused and the tab activates so the user can watch; pass background=true to capture silently (the tab is briefly activated within its window for the capture, then the previous active tab is restored).",
		promptSnippet: "Capture Chrome screenshots and save them under .pi/chrome-screenshots by default.",
		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: "Output path. Defaults to .pi/chrome-screenshots/<timestamp>.<format>." })),
			format: Type.Optional(StringEnum(imageFormatValues)),
			quality: Type.Optional(Type.Number({ description: "JPEG quality 0-100." })),
			fullPage: Type.Optional(Type.Boolean({ description: "Not supported by the extension bridge yet; viewport screenshots are captured." })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(
				Type.Boolean({ description: "If true, capture silently without focusing the Chrome window (the target tab is briefly activated within its window for the capture, then restored). Default false." }),
			),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal, _onUpdate, ctx: ExtensionContext): Promise<ToolTextResult> {
			const format = params.format ?? "png";
			const cwd = workspaceCwd(ctx);
			const defaultPath = join(cwd, ".pi", "chrome-screenshots", `${new Date().toISOString().replace(/[:.]/g, "-")}.${format}`);
			const outputPath = params.path ? resolve(cwd, params.path) : defaultPath;
			const result = (await authorizedBridgeSend("page.screenshot", withBackground(params), params.fullPage ? 120_000 : DEFAULT_TIMEOUT_MS, signal)) as {
				dataUrl?: string;
				tab?: unknown;
				fullPage?: boolean;
				dimensions?: { width: number; height: number; viewportHeight: number; dpr: number };
				tiles?: Array<{ y: number; dataUrl: string }>;
			};
			await mkdir(dirname(outputPath), { recursive: true });
			if (result.fullPage && result.tiles && result.dimensions) {
				// Stitch via PNG if format is png; otherwise we fall back to writing tile files and a
				// manifest. We avoid pulling in an image library by writing each tile next to the main
				// path with a -tileN suffix and a stitched.json manifest.
				const { width, height, viewportHeight, dpr } = result.dimensions;
				const manifest: Array<{ path: string; y: number }> = [];
				for (let i = 0; i < result.tiles.length; i++) {
					const tile = result.tiles[i];
					const tilePath = outputPath.replace(/(\.[^.]+)$/, `-tile${i}$1`);
					const base64 = tile.dataUrl.replace(/^data:image\/(?:png|jpeg);base64,/, "");
					await writeFile(tilePath, Buffer.from(base64, "base64"));
					manifest.push({ path: tilePath, y: tile.y });
				}
				await writeFile(outputPath + ".json", JSON.stringify({ width, height, viewportHeight, dpr, tiles: manifest }, null, 2));
				return {
					content: [{ type: "text", text: `Saved ${result.tiles.length} full-page tile(s) for ${width}×${height}px page. Manifest: ${outputPath}.json` }],
					details: { manifest: outputPath + ".json", tiles: manifest, dimensions: result.dimensions, tab: result.tab } as unknown as Record<string, unknown>,
				};
			}
			if (!result.dataUrl) throw new Error("Screenshot returned no dataUrl");
			const base64 = result.dataUrl.replace(/^data:image\/(?:png|jpeg);base64,/, "");
			await writeFile(outputPath, Buffer.from(base64, "base64"));
			return { content: [{ type: "text", text: `Saved Chrome screenshot to ${outputPath}` }], details: { path: outputPath, format, tab: result.tab } };
		},
	});

	pi.registerTool({
		name: "chrome_hover",
		label: "Chrome Hover",
		description: "Hover over an element by uid, selector, or x/y using Chrome pointer movement.",
		promptSnippet: "Hover a Chrome element to trigger :hover / mouseover handlers.",
		parameters: Type.Object({
			uid: Type.Optional(Type.String()),
			selector: Type.Optional(Type.String()),
			x: Type.Optional(Type.Number()),
			y: Type.Optional(Type.Number()),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const result = await authorizedBridgeSend("page.hover", withBackground(params), DEFAULT_TIMEOUT_MS, signal);
			return { content: [{ type: "text", text: `Hovered ${params.uid ?? params.selector ?? `${params.x},${params.y}`}` }], details: { result: result as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_drag",
		label: "Chrome Drag",
		description: "Drag from one uid/selector/point to another using Chrome pointer input.",
		promptSnippet: "Drag a Chrome element from one point to another.",
		parameters: Type.Object({
			fromUid: Type.Optional(Type.String()),
			fromSelector: Type.Optional(Type.String()),
			fromX: Type.Optional(Type.Number()),
			fromY: Type.Optional(Type.Number()),
			toUid: Type.Optional(Type.String()),
			toSelector: Type.Optional(Type.String()),
			toX: Type.Optional(Type.Number()),
			toY: Type.Optional(Type.Number()),
			steps: Type.Optional(Type.Number({ default: 12 })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const result = await authorizedBridgeSend("page.drag", withBackground(params), DEFAULT_TIMEOUT_MS, signal);
			return { content: [{ type: "text", text: `Dragged from ${params.fromUid ?? params.fromSelector} to ${params.toUid ?? params.toSelector}` }], details: { result: result as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_tap",
		label: "Chrome Tap (Touch)",
		description:
			"Dispatch a real touchstart/touchend tap through Chrome's input layer. Use for sites that gate on TouchEvent rather than MouseEvent (mobile-first PWAs, swipe carousels). Chrome may show its debugging banner while attached.",
		promptSnippet: "Tap (real touch) a Chrome element by snapshot uid, selector, or coordinate.",
		parameters: Type.Object({
			uid: Type.Optional(Type.String()),
			selector: Type.Optional(Type.String()),
			x: Type.Optional(Type.Number()),
			y: Type.Optional(Type.Number()),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const result = await authorizedBridgeSend("page.tap", withBackground(params), DEFAULT_TIMEOUT_MS, signal);
			const target = params.uid ?? params.selector ?? `${params.x},${params.y}`;
			return { content: [{ type: "text", text: `Tapped ${target} (touch)` }], details: { result: result as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_scroll",
		label: "Chrome Scroll",
		description: "Scroll the page or a specific scrollable element by dispatching real wheel events with momentum-shaped deltas, then applying the scroll. Positive deltaY scrolls down. Pass uid/selector to scroll within a container, otherwise the document scrolls.",
		promptSnippet: "Scroll a Chrome page or container via wheel events (not raw scrollTop).",
		parameters: Type.Object({
			uid: Type.Optional(Type.String()),
			selector: Type.Optional(Type.String()),
			deltaY: Type.Optional(Type.Number({ description: "Pixels to scroll vertically. Positive = down." })),
			deltaX: Type.Optional(Type.Number({ description: "Pixels to scroll horizontally. Positive = right." })),
			steps: Type.Optional(Type.Number({ description: "Number of wheel events to dispatch. Defaults to ceil(|deltaY|/100)." })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const result = await authorizedBridgeSend("page.scroll", withBackground(params), DEFAULT_TIMEOUT_MS, signal);
			return { content: [{ type: "text", text: `Scrolled dy=${params.deltaY ?? 0} dx=${params.deltaX ?? 0}` }], details: { result: result as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_upload_file",
		label: "Chrome Upload File",
		description: "Attach local files to an <input type=file> element using Chrome DevTools file-input control. Does NOT open the native file picker; works with React/Vue/Angular controlled inputs.",
		promptSnippet: "Attach local files to a Chrome <input type=file> without opening the native file picker.",
		parameters: Type.Object({
			uid: Type.Optional(Type.String()),
			selector: Type.Optional(Type.String()),
			paths: Type.Array(Type.String(), { description: "Local absolute file paths to upload." }),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params, signal, _onUpdate, ctx): Promise<ToolTextResult> {
			const cwd = workspaceCwd(ctx);
			const paths = params.paths.map((p) => resolve(cwd, p));
			const result = await authorizedBridgeSend("page.upload", withBackground({ ...params, paths }), DEFAULT_TIMEOUT_MS, signal);
			return { content: [{ type: "text", text: `Uploaded ${paths.length} file(s) to ${params.uid ?? params.selector}` }], details: { result: result as Json } };
		},
	});
}
