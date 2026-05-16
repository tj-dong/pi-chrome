#!/usr/bin/env node
//
// pi-chrome bridge daemon — standalone version of the Chrome bridge.
//
// Runs as a detached process spawned by a Pi session at session_start. Owns:
//   - the TCP listener on :17318
//   - the BridgeAuth state (~/.config/pi/chrome-bridge.json mode 0600)
//   - the command queue between Pi clients and the Chrome extension service worker
//
// Pi sessions talk to the daemon via signed /command HTTP requests; the Chrome extension
// long-polls /next. Both sides use the v1 signed-envelope protocol documented in SECURITY.md.
//
// This file is shipped in the npm tarball and copied to ~/.cache/pi-chrome/<version>/daemon.cjs
// by the supervisor on first use. It must remain dependency-free (only node: builtins) so
// it can run anywhere Node ≥18 is installed regardless of node_modules state.

"use strict";

const { createServer } = require("node:http");
const { createHash, createHmac, hkdfSync, randomBytes, randomUUID, timingSafeEqual } = require("node:crypto");
const { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, statSync, watch: fsWatch } = require("node:fs");
const { homedir } = require("node:os");
const { dirname, join } = require("node:path");

// ---------------------------------------------------------------------------------------------
// Configuration + constants
// ---------------------------------------------------------------------------------------------

const ARGS = (() => {
	const out = { host: "127.0.0.1", port: 17318, version: "0.0.0-dev", idleShutdownMs: 10 * 60_000, logPath: undefined };
	for (let i = 2; i < process.argv.length; i++) {
		const arg = process.argv[i];
		const [k, v] = arg.includes("=") ? arg.split("=", 2) : [arg, process.argv[++i]];
		switch (k) {
			case "--host": out.host = v; break;
			case "--port": out.port = Number(v); break;
			case "--version": out.version = v; break;
			case "--idle-ms": out.idleShutdownMs = Number(v); break;
			case "--log": out.logPath = v; break;
		}
	}
	return out;
})();

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_REQUEST_BODY_BYTES = 1 * 1024 * 1024;
const MAX_QUEUE = 256;
const MAX_PENDING = 256;
const MAX_WAITERS = 4;

const AUTH_PROTOCOL = "v1";
const AUTH_HEADER = "x-pi-chrome-auth";
const PAIR_WINDOW_MS = 10 * 60_000;
const MAX_CLOCK_SKEW_MS = 30_000;
const NONCE_TTL_MS = 5 * 60_000;
const NONCE_CACHE_MAX = 4096;

function logLine(level, msg) {
	const line = `[${new Date().toISOString()}] [${level}] ${msg}\n`;
	process.stderr.write(line);
}

// ---------------------------------------------------------------------------------------------
// Signed-envelope auth (mirrors index.ts BridgeAuth; see SECURITY.md for spec).
// ---------------------------------------------------------------------------------------------

function configPath() {
	const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
	return join(base, "pi", "chrome-bridge.json");
}
function b64url(buf) { return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function b64urlDecode(text) {
	const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
	return Buffer.from(padded, "base64");
}
function sha256Hex(input) { return createHash("sha256").update(input).digest("hex"); }
function hmacSign(key, message) { return createHmac("sha256", key).update(message).digest(); }
function safeBufferEqual(a, b) {
	if (a.length !== b.length) return false;
	try { return timingSafeEqual(a, b); } catch { return false; }
}
function safeStringEqual(a, b) {
	const aBuf = Buffer.from(a, "utf8");
	const bBuf = Buffer.from(b, "utf8");
	return safeBufferEqual(aBuf, bBuf);
}
function canonicalString(direction, method, path, extensionId, bridgeId, ts, nonce, body) {
	return [AUTH_PROTOCOL, direction, method.toUpperCase(), path, extensionId, bridgeId, String(ts), nonce, sha256Hex(body)].join("\n");
}
function buildAuthHeader(key, direction, method, path, extensionId, bridgeId, body) {
	const ts = Date.now();
	const nonce = b64url(randomBytes(16));
	const sig = b64url(hmacSign(key, canonicalString(direction, method, path, extensionId, bridgeId, ts, nonce, body)));
	return { header: `${AUTH_PROTOCOL} ts=${ts} nonce=${nonce} sig=${sig}`, ts, nonce };
}
function parseAuthHeader(raw) {
	const value = Array.isArray(raw) ? raw[0] : raw;
	if (!value || typeof value !== "string") return undefined;
	const parts = value.trim().split(/\s+/);
	if (parts.length !== 4 || parts[0] !== AUTH_PROTOCOL) return undefined;
	const kv = {};
	for (const p of parts.slice(1)) {
		const eq = p.indexOf("=");
		if (eq <= 0) return undefined;
		kv[p.slice(0, eq)] = p.slice(eq + 1);
	}
	const ts = Number(kv.ts);
	if (!Number.isFinite(ts) || !kv.nonce || !kv.sig) return undefined;
	return { ts, nonce: kv.nonce, sig: kv.sig };
}

class NonceCache {
	constructor() { this.entries = new Map(); }
	has(nonce) { return this.entries.has(nonce); }
	store(nonce, ts) {
		const now = Date.now();
		for (const [k, t] of this.entries) {
			if (now - t > NONCE_TTL_MS) this.entries.delete(k); else break;
		}
		while (this.entries.size >= NONCE_CACHE_MAX) {
			const oldest = this.entries.keys().next().value;
			if (oldest === undefined) break;
			this.entries.delete(oldest);
		}
		this.entries.set(nonce, ts);
	}
}

class BridgeAuth {
	constructor() {
		this.state = undefined;
		this.pendingInvite = undefined;
		this.extNonces = new NonceCache();
		this.peerNonces = new NonceCache();
		this.ownerRespNonces = new NonceCache();
		this.lastStateMtimeMs = 0;
		this.watcher = undefined;
		this.load();
		this.startWatching();
	}
	get paired() { this.refreshIfStale(); return Boolean(this.state); }
	get bridgeId() { this.refreshIfStale(); return this.state?.bridgeId ?? ""; }
	get pinnedExtensionId() { this.refreshIfStale(); return this.state?.extensionId ?? ""; }
	load() {
		try {
			const raw = readFileSync(configPath(), "utf8");
			const parsed = JSON.parse(raw);
			if (parsed?.protocol === "v1" && parsed.bridgeId && parsed.extensionId && parsed.extensionPairKey && parsed.brokerKey) {
				this.state = parsed;
			} else {
				this.state = undefined;
			}
		} catch {
			this.state = undefined;
		}
	}
	persist() {
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
			logLine("warn", `failed to persist auth state at ${path}: ${error.message}`);
		}
	}
	startWatching() {
		const path = configPath();
		const dir = dirname(path);
		try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch {}
		try {
			this.watcher = fsWatch(dir, { persistent: false }, (_event, filename) => {
				if (!filename || filename.toString() !== "chrome-bridge.json") return;
				this.refreshIfStale();
			});
		} catch (error) {
			logLine("warn", `fs.watch on ${dir} failed: ${error.message}`);
		}
	}
	stop() { try { this.watcher?.close(); } catch {} this.watcher = undefined; }
	refreshIfStale() {
		const path = configPath();
		let mtimeMs = 0;
		try { mtimeMs = statSync(path).mtimeMs; } catch { mtimeMs = -1; }
		if (mtimeMs === this.lastStateMtimeMs) return;
		this.lastStateMtimeMs = mtimeMs;
		const prevExt = this.state?.extensionId;
		const prevBridge = this.state?.bridgeId;
		this.load();
		if (this.state?.extensionId !== prevExt || this.state?.bridgeId !== prevBridge) {
			this.extNonces = new NonceCache();
			this.peerNonces = new NonceCache();
			this.ownerRespNonces = new NonceCache();
		}
	}
	startPairWindow() {
		const secret = randomBytes(32);
		this.pendingInvite = { secret, expiresAt: Date.now() + PAIR_WINDOW_MS };
		return `pcp_${b64url(secret)}`;
	}
	pairWindowActive() {
		if (!this.pendingInvite) return false;
		if (this.pendingInvite.expiresAt < Date.now()) { this.pendingInvite = undefined; return false; }
		return true;
	}
	reset() {
		this.state = undefined;
		this.pendingInvite = undefined;
		const path = configPath();
		try { writeFileSync(path, JSON.stringify({}), { mode: 0o600 }); } catch {}
		try { chmodSync(path, 0o600); } catch {}
		try { chmodSync(dirname(path), 0o700); } catch {}
	}
	completePairing(body) {
		if (!this.pairWindowActive()) throw new Error("no active pairing window");
		if (!body.extensionId || !body.extensionNonce || !body.mac) throw new Error("pair: missing fields");
		if (!/^[a-p]{32}$/.test(body.extensionId)) throw new Error("pair: invalid extensionId");
		const invite = this.pendingInvite.secret;
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
		const response = {
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
	verifyEnvelope(key, cache, direction, method, path, extensionId, bridgeId, header, body) {
		const parsed = parseAuthHeader(header);
		if (!parsed) return false;
		if (Math.abs(Date.now() - parsed.ts) > MAX_CLOCK_SKEW_MS) return false;
		if (cache.has(parsed.nonce)) return false;
		const expected = hmacSign(key, canonicalString(direction, method, path, extensionId, bridgeId, parsed.ts, parsed.nonce, body));
		let supplied;
		try { supplied = b64urlDecode(parsed.sig); } catch { return false; }
		if (!safeBufferEqual(expected, supplied)) return false;
		cache.store(parsed.nonce, parsed.ts);
		return true;
	}
	verifyExtensionRequest(method, path, header, originExtensionId, body) {
		this.refreshIfStale();
		if (!this.state) return false;
		if (!safeStringEqual(originExtensionId, this.state.extensionId)) return false;
		return this.verifyEnvelope(b64urlDecode(this.state.extensionPairKey), this.extNonces, "ext->bridge", method, path, this.state.extensionId, this.state.bridgeId, header, body);
	}
	signBridgeResponse(method, path, body) {
		if (!this.state) return undefined;
		const { header } = buildAuthHeader(b64urlDecode(this.state.extensionPairKey), "bridge->ext", method, path, this.state.extensionId, this.state.bridgeId, body);
		return header;
	}
	verifyPeerRequest(method, path, header, body) {
		this.refreshIfStale();
		if (!this.state) return false;
		return this.verifyEnvelope(b64urlDecode(this.state.brokerKey), this.peerNonces, "peer->owner", method, path, this.state.extensionId, this.state.bridgeId, header, body);
	}
	signOwnerResponse(method, path, body) {
		if (!this.state) return undefined;
		const { header } = buildAuthHeader(b64urlDecode(this.state.brokerKey), "owner->peer", method, path, this.state.extensionId, this.state.bridgeId, body);
		return header;
	}
}

// ---------------------------------------------------------------------------------------------
// HTTP utilities
// ---------------------------------------------------------------------------------------------

function isLoopback(addr) {
	return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}
function corsFor(req) {
	const origin = String(req.headers.origin ?? "");
	if (!origin.startsWith("chrome-extension://")) return {};
	return {
		"access-control-allow-origin": origin,
		"access-control-allow-methods": "GET,POST,OPTIONS",
		"access-control-allow-headers": `content-type, ${AUTH_HEADER}`,
		"access-control-expose-headers": `x-pi-chrome-version, ${AUTH_HEADER}`,
		"vary": "origin",
	};
}
function isBrowserOriginAllowed(req) {
	const origin = String(req.headers.origin ?? "");
	if (origin) return origin.startsWith("chrome-extension://");
	const secFetchSite = String(req.headers["sec-fetch-site"] ?? "");
	return !secFetchSite || secFetchSite === "none" || secFetchSite === "same-origin";
}
function isLocalProcessRequest(req) {
	return !req.headers.origin && !req.headers["sec-fetch-site"];
}
function sendJson(res, status, body, extra) {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...(extra ?? {}) });
	res.end(JSON.stringify(body));
}
function extensionIdFromOrigin(req) {
	const origin = String(req.headers.origin ?? "");
	const match = origin.match(/^chrome-extension:\/\/([a-p]{32})$/);
	return match ? match[1] : undefined;
}

class RequestBodyTooLargeError extends Error { constructor() { super("request body too large"); this.name = "RequestBodyTooLargeError"; } }
function readBody(req, maxBytes = MAX_REQUEST_BODY_BYTES) {
	return new Promise((resolve, reject) => {
		const declared = Number(req.headers["content-length"]);
		if (Number.isFinite(declared) && declared > maxBytes) { reject(new RequestBodyTooLargeError()); req.resume(); return; }
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			const buf = Buffer.from(chunk);
			size += buf.length;
			if (size > maxBytes) { reject(new RequestBodyTooLargeError()); req.destroy(); return; }
			chunks.push(buf);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}
async function readJsonObject(req, res, extraHeaders) {
	let raw;
	try { raw = await readBody(req); }
	catch (error) {
		if (error instanceof RequestBodyTooLargeError) sendJson(res, 413, { ok: false, error: "request body too large" }, extraHeaders);
		else sendJson(res, 400, { ok: false, error: `failed to read body: ${error.message}` }, extraHeaders);
		return undefined;
	}
	let parsed;
	try { parsed = JSON.parse(raw || "{}"); }
	catch (error) { sendJson(res, 400, { ok: false, error: `invalid JSON: ${error.message}` }, extraHeaders); return undefined; }
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		sendJson(res, 400, { ok: false, error: "expected JSON object" }, extraHeaders);
		return undefined;
	}
	return parsed;
}

// ---------------------------------------------------------------------------------------------
// Bridge daemon
// ---------------------------------------------------------------------------------------------

const startedAt = Date.now();
let lastActivityAt = Date.now();

const auth = new BridgeAuth();
const pending = new Map();
let queue = [];
let waiters = [];
let lastSeenAt;
let clientName;

function touchActivity() { lastActivityAt = Date.now(); }

function enqueue(command) {
	const w = waiters.shift();
	if (w) { w(command); return; }
	if (queue.length >= MAX_QUEUE) {
		const p = pending.get(command.id);
		if (p) { clearTimeout(p.timer); pending.delete(command.id); p.reject(new Error("queue full")); }
		return;
	}
	queue.push(command);
}

function sendCommandLocal(action, params, timeoutMs = DEFAULT_TIMEOUT_MS) {
	const id = randomUUID();
	const command = { id, action, params };
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pending.delete(id);
			queue = queue.filter((q) => q.id !== id);
			reject(new Error(`Timed out waiting for Chrome extension after ${timeoutMs}ms.`));
		}, timeoutMs);
		if (pending.size >= MAX_PENDING) { clearTimeout(timer); reject(new Error("too many in-flight commands")); return; }
		pending.set(id, { command, resolve, reject, timer });
		enqueue(command);
	});
}

function waitForCommand(timeoutMs, register) {
	return new Promise((resolve) => {
		let settled = false;
		const w = (cmd) => { if (settled) return; settled = true; clearTimeout(t); waiters = waiters.filter((e) => e !== w); resolve(cmd); };
		const t = setTimeout(() => w(undefined), timeoutMs);
		waiters.push(w);
		register?.(w);
	});
}

async function handle(req, res) {
	touchActivity();
	const url = new URL(req.url ?? "/", `http://${ARGS.host}:${ARGS.port}`);
	const corsHeaders = corsFor(req);

	if (!isLoopback(req.socket.remoteAddress)) {
		sendJson(res, 403, { ok: false, error: "bridge accepts only loopback connections" });
		return;
	}
	const declaredLen = Number(req.headers["content-length"]);
	if (Number.isFinite(declaredLen) && declaredLen > MAX_REQUEST_BODY_BYTES) {
		sendJson(res, 413, { ok: false, error: "request body too large" });
		req.resume();
		return;
	}

	if (req.method === "OPTIONS") {
		if (!isBrowserOriginAllowed(req)) { sendJson(res, 403, { ok: false, error: "browser origin not allowed" }); return; }
		sendJson(res, 200, { ok: true }, corsHeaders);
		return;
	}

	if (req.method === "GET" && url.pathname === "/status") {
		sendJson(res, 200, {
			url: `http://${ARGS.host}:${ARGS.port}`,
			mode: "daemon",
			bridgeVersion: ARGS.version,
			daemonPid: process.pid,
			daemonStartedAt: startedAt,
			connected: lastSeenAt !== undefined && Date.now() - lastSeenAt < 5 * 60_000,
			lastSeenAt,
			clientName,
			queuedCommands: queue.length,
			pendingCommands: pending.size,
			paired: auth.paired,
		});
		return;
	}

	if (req.method === "GET" && url.pathname === "/heartbeat") {
		// Pi clients hit this to keep the daemon's idle timer alive between long gaps of
		// chrome_* tool activity. Loopback-only, no auth needed.
		sendJson(res, 200, { ok: true, ts: Date.now() });
		return;
	}

	if (req.method === "POST" && url.pathname === "/pair") {
		if (!isBrowserOriginAllowed(req)) { sendJson(res, 403, { ok: false, error: "browser origin required" }, corsHeaders); return; }
		if (!auth.pairWindowActive()) {
			sendJson(res, 403, { ok: false, error: "no active pairing window; run /chrome pair in Pi first" }, corsHeaders);
			return;
		}
		const body = await readJsonObject(req, res, corsHeaders);
		if (!body) return;
		const originExt = extensionIdFromOrigin(req);
		if (!originExt) { sendJson(res, 403, { ok: false, error: "chrome-extension origin required" }, corsHeaders); return; }
		if (body.extensionId && body.extensionId !== originExt) { sendJson(res, 400, { ok: false, error: "extensionId mismatch with Origin" }, corsHeaders); return; }
		try {
			const { response, signedHeader } = auth.completePairing({ ...body, extensionId: originExt });
			sendJson(res, 200, response, { ...corsHeaders, [AUTH_HEADER]: signedHeader });
		} catch (error) {
			sendJson(res, 401, { ok: false, error: error.message }, corsHeaders);
		}
		return;
	}

	if (req.method === "POST" && url.pathname === "/admin") {
		// Admin RPC for Pi clients: arm-pair-window, reset, etc. Requires a signed
		// peer->owner envelope (same broker key used for /command).
		if (!isLocalProcessRequest(req)) { sendJson(res, 403, { ok: false, error: "admin endpoint local-only" }); return; }
		let rawBody;
		try { rawBody = await readBody(req); }
		catch (error) {
			if (error instanceof RequestBodyTooLargeError) sendJson(res, 413, { ok: false, error: "body too large" });
			else sendJson(res, 400, { ok: false, error: `body read: ${error.message}` });
			return;
		}
		if (auth.paired) {
			// Once paired, admin calls must be authenticated. Pre-pairing, the first /admin
			// call is `arm-pair-window` from the local Pi user and is allowed unauthenticated
			// (loopback-only + isLocalProcessRequest already gate it).
			if (!auth.verifyPeerRequest("POST", "/admin", req.headers[AUTH_HEADER], rawBody)) {
				sendJson(res, 401, { ok: false, error: "missing or invalid admin auth" });
				return;
			}
		}
		let body;
		try { body = JSON.parse(rawBody || "{}"); }
		catch (error) { sendJson(res, 400, { ok: false, error: `invalid JSON: ${error.message}` }); return; }
		const op = body && body.op;
		const respond = (status, payload) => {
			const text = JSON.stringify(payload);
			const sig = auth.signOwnerResponse("POST", "/admin", text);
			res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...(sig ? { [AUTH_HEADER]: sig } : {}) });
			res.end(text);
		};
		try {
			switch (op) {
				case "arm-pair-window": {
					if (auth.paired && !body.replace) {
						respond(409, { ok: false, error: "already paired; pass replace:true to re-pair" });
						return;
					}
					if (body.replace) auth.reset();
					const invite = auth.startPairWindow();
					respond(200, { ok: true, invite, windowMs: PAIR_WINDOW_MS });
					return;
				}
				case "reset": {
					auth.reset();
					respond(200, { ok: true });
					return;
				}
				case "status": {
					respond(200, { ok: true, paired: auth.paired, bridgeId: auth.bridgeId, pinnedExtensionId: auth.pinnedExtensionId });
					return;
				}
				default:
					respond(400, { ok: false, error: `unknown admin op: ${op}` });
			}
		} catch (error) {
			respond(500, { ok: false, error: error.message });
		}
		return;
	}

	if (req.method === "POST" && url.pathname === "/command") {
		if (!isLocalProcessRequest(req)) { sendJson(res, 403, { ok: false, error: "/command local-only" }); return; }
		if (!auth.paired) { sendJson(res, 401, { ok: false, error: "bridge not paired; run /chrome pair" }); return; }
		let rawBody;
		try { rawBody = await readBody(req); }
		catch (error) {
			if (error instanceof RequestBodyTooLargeError) sendJson(res, 413, { ok: false, error: "body too large" });
			else sendJson(res, 400, { ok: false, error: `body read: ${error.message}` });
			return;
		}
		if (!auth.verifyPeerRequest("POST", "/command", req.headers[AUTH_HEADER], rawBody)) {
			sendJson(res, 401, { ok: false, error: "missing or invalid bridge auth header" });
			return;
		}
		let body;
		try { body = JSON.parse(rawBody || "{}"); }
		catch (error) { sendJson(res, 400, { ok: false, error: `invalid JSON: ${error.message}` }); return; }
		if (!body.action || typeof body.action !== "string") { sendJson(res, 400, { ok: false, error: "missing action" }); return; }
		const timeoutMs = Math.min(Math.max(Number(body.timeoutMs) || DEFAULT_TIMEOUT_MS, 1_000), 5 * 60_000);
		const respond = (status, payload) => {
			const text = JSON.stringify(payload);
			const sig = auth.signOwnerResponse("POST", "/command", text);
			res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...(sig ? { [AUTH_HEADER]: sig } : {}) });
			res.end(text);
		};
		try {
			const result = await sendCommandLocal(body.action, body.params ?? {}, timeoutMs);
			respond(200, { ok: true, result });
		} catch (error) {
			respond(504, { ok: false, error: error.message });
		}
		return;
	}

	if (req.method === "GET" && url.pathname === "/next") {
		if (!isBrowserOriginAllowed(req)) { sendJson(res, 403, { ok: false, error: "browser origin not allowed" }); return; }
		const originExt = extensionIdFromOrigin(req);
		const currentVersion = ARGS.version;
		// Any /next from a chrome-extension origin counts as 'extension is alive'. We record
		// lastSeenAt here — before the auth/pair checks below — so that /chrome onboard's
		// connect-wait loop can detect a polling-but-unpaired extension (which is precisely
		// the state during the pair step).
		if (originExt) {
			lastSeenAt = Date.now();
			clientName = url.searchParams.get("name") ?? undefined;
		}
		if (!auth.paired) {
			sendJson(res, 200, { type: "none", needsPairing: true, expectedExtensionVersion: currentVersion },
				{ ...corsHeaders, "x-pi-chrome-version": currentVersion });
			return;
		}
		const hasAuthHeader = Boolean(req.headers[AUTH_HEADER]);
		if (!originExt || originExt !== auth.pinnedExtensionId) {
			sendJson(res, 200, { type: "none", needsPairing: true, expectedExtensionVersion: currentVersion },
				{ ...corsHeaders, "x-pi-chrome-version": currentVersion });
			return;
		}
		if (!hasAuthHeader) {
			sendJson(res, 200, { type: "none", needsPairing: true, expectedExtensionVersion: currentVersion },
				{ ...corsHeaders, "x-pi-chrome-version": currentVersion });
			return;
		}
		if (!auth.verifyExtensionRequest("GET", "/next", req.headers[AUTH_HEADER], originExt, "")) {
			sendJson(res, 401, { ok: false, error: "invalid /next auth" }, { ...corsHeaders, "x-pi-chrome-version": currentVersion });
			return;
		}
		if (waiters.length >= MAX_WAITERS) { sendJson(res, 429, { ok: false, error: "too many pollers" }, corsHeaders); return; }
		let aborted = false;
		let active;
		req.once("close", () => { aborted = true; if (active) waiters = waiters.filter((e) => e !== active); });
		let command = queue.shift();
		if (!command) command = await waitForCommand(25_000, (w) => { active = w; });
		if (aborted) { if (command) queue.unshift(command); return; }
		const payload = command
			? { type: "command", command, expectedExtensionVersion: currentVersion }
			: { type: "none", expectedExtensionVersion: currentVersion };
		const respBody = JSON.stringify(payload);
		const sig = auth.signBridgeResponse("GET", "/next", respBody);
		res.writeHead(200, {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
			...corsHeaders,
			"x-pi-chrome-version": currentVersion,
			...(sig ? { [AUTH_HEADER]: sig } : {}),
		});
		res.end(respBody);
		return;
	}

	if (req.method === "POST" && url.pathname === "/result") {
		if (!isBrowserOriginAllowed(req)) { sendJson(res, 403, { ok: false, error: "browser origin not allowed" }); return; }
		if (!auth.paired) { sendJson(res, 401, { ok: false, error: "bridge not paired" }, corsHeaders); return; }
		const originExt = extensionIdFromOrigin(req);
		if (!originExt || originExt !== auth.pinnedExtensionId) {
			sendJson(res, 403, { ok: false, error: "extension origin not pinned" }, corsHeaders);
			return;
		}
		lastSeenAt = Date.now();
		let rawBody;
		try { rawBody = await readBody(req); }
		catch (error) {
			if (error instanceof RequestBodyTooLargeError) sendJson(res, 413, { ok: false, error: "body too large" }, corsHeaders);
			else sendJson(res, 400, { ok: false, error: `body read: ${error.message}` }, corsHeaders);
			return;
		}
		if (!auth.verifyExtensionRequest("POST", "/result", req.headers[AUTH_HEADER], originExt, rawBody)) {
			sendJson(res, 401, { ok: false, error: "invalid /result auth" }, corsHeaders);
			return;
		}
		let result;
		try { result = JSON.parse(rawBody || "{}"); }
		catch (error) { sendJson(res, 400, { ok: false, error: `invalid JSON: ${error.message}` }, corsHeaders); return; }
		if (!result.id || typeof result.id !== "string") { sendJson(res, 400, { ok: false, error: "missing command id" }, corsHeaders); return; }
		const p = pending.get(result.id);
		if (!p) { sendJson(res, 404, { ok: false, error: "unknown command id" }, corsHeaders); return; }
		clearTimeout(p.timer);
		pending.delete(result.id);
		if (result.ok) p.resolve(result.result);
		else p.reject(new Error(result.error ?? "Chrome extension command failed"));
		sendJson(res, 200, { ok: true }, corsHeaders);
		return;
	}

	sendJson(res, 404, { error: "not found" });
}

// ---------------------------------------------------------------------------------------------
// Process lifecycle
// ---------------------------------------------------------------------------------------------

const server = createServer((req, res) => {
	handle(req, res).catch((error) => {
		try { sendJson(res, 500, { error: error?.message ?? String(error) }); } catch {}
	});
});

server.on("error", (error) => {
	if (error.code === "EADDRINUSE") {
		logLine("info", `port ${ARGS.port} already in use; exiting cleanly so the existing daemon wins`);
		process.exit(0);
	}
	logLine("error", `server error: ${error.message}`);
	process.exit(1);
});

server.listen(ARGS.port, ARGS.host, () => {
	logLine("info", `pi-chrome daemon v${ARGS.version} listening on http://${ARGS.host}:${ARGS.port} (pid ${process.pid})`);
});

// Idle shutdown: exit if no activity (extension poll or command) for IDLE_SHUTDOWN_MS.
setInterval(() => {
	const idle = Date.now() - lastActivityAt;
	if (idle > ARGS.idleShutdownMs) {
		logLine("info", `idle for ${Math.round(idle / 1000)}s; shutting down`);
		auth.stop();
		server.close(() => process.exit(0));
		setTimeout(() => process.exit(0), 2_000).unref();
	}
}, 30_000).unref();

// Graceful signal handling.
for (const sig of ["SIGTERM", "SIGINT"]) {
	process.on(sig, () => {
		logLine("info", `received ${sig}; shutting down`);
		auth.stop();
		server.close(() => process.exit(0));
		setTimeout(() => process.exit(0), 2_000).unref();
	});
}
