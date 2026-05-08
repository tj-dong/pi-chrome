import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { existsSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";

/**
 * Existing-profile Chrome bridge for pi.
 *
 * This is intentionally not a Chrome DevTools Protocol integration. CDP cannot attach to
 * already-running normal Chrome windows and recent Chrome builds block default-profile
 * remote debugging. Instead, install the companion Chrome extension from the
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

const PI_CHROME_VERSION = "0.7.0";
const DEFAULT_HOST = process.env.PI_CHROME_BRIDGE_HOST ?? "127.0.0.1";
const DEFAULT_PORT = Number(process.env.PI_CHROME_BRIDGE_PORT ?? "17318");
const DEFAULT_TIMEOUT_MS = 30_000;
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

function readRequestBody(request: IncomingMessage): Promise<string> {
	return new Promise((resolveBody, rejectBody) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
		request.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
		request.on("error", rejectBody);
	});
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"access-control-allow-origin": "*",
		"access-control-allow-methods": "GET,POST,OPTIONS",
		"access-control-allow-headers": "content-type",
		"cache-control": "no-store",
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

	constructor(
		private readonly host: string,
		private readonly port: number,
	) {}

	get url(): string {
		return `http://${this.host}:${this.port}`;
	}

	get connected(): boolean {
		// MV3 service workers can pause between polls/alarms. Treat a recent poll as
		// connected without sending a synthetic command; real chrome_* tool calls are
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
		};
	}

	async start(): Promise<void> {
		if (this.server || this.mode === "client") return;
		this.server = createServer((request, response) => {
			void this.handle(request, response).catch((error) => {
				sendJson(response, 500, { error: (error as Error).message });
			});
		});
		try {
			await new Promise<void>((resolveStart, rejectStart) => {
				this.server!.once("error", rejectStart);
				this.server!.listen(this.port, this.host, () => {
					this.server!.off("error", rejectStart);
					resolveStart();
				});
			});
			this.mode = "server";
		} catch (error) {
			this.server.close();
			this.server = undefined;
			if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
			// Another Pi session already owns the bridge port. Use it as the shared
			// machine-local broker so multiple Pi sessions can control Chrome at once.
			this.mode = "client";
		}
	}

	stop(): void {
		if (this.mode === "client") {
			this.mode = undefined;
			return;
		}
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

	send(action: string, params: Record<string, unknown>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
		if (this.mode === "client") return this.sendViaOwner(action, params, timeoutMs);
		return this.sendLocal(action, params, timeoutMs);
	}

	private sendLocal(action: string, params: Record<string, unknown>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
		const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
		const command = { id, action, params };
		return new Promise((resolveCommand, rejectCommand) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				this.queue = this.queue.filter((queued) => queued.id !== id);
				rejectCommand(
					new Error(
						`Timed out waiting for Chrome extension after ${timeoutMs}ms. Run /chrome-onboard, then load the bundled browser-extension folder in your normal Chrome profile.`,
					),
				);
			}, timeoutMs);
			this.pending.set(id, { command, resolve: resolveCommand, reject: rejectCommand, timer });
			this.enqueue(command);
		});
	}

	private async sendViaOwner(action: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs + 2_000);
		try {
			const response = await fetch(`${this.url}/command`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ action, params, timeoutMs }),
				signal: controller.signal,
			});
			const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; result?: unknown; error?: string };
			if (response.status === 404) {
				throw new Error(
					"A running Pi session owns the Chrome bridge but is using an older pi-chrome without multi-session support. Restart that Pi session after `pi update`, then retry.",
				);
			}
			if (!response.ok || !payload.ok) throw new Error(payload.error ?? `Chrome bridge owner HTTP ${response.status}`);
			return payload.result;
		} catch (error) {
			if ((error as Error).name === "AbortError") {
				throw new Error(`Timed out waiting for shared Chrome bridge owner after ${timeoutMs}ms`);
			}
			throw error;
		} finally {
			clearTimeout(timer);
		}
	}

	private enqueue(command: BridgeCommand): void {
		const waiter = this.waiters.shift();
		if (waiter) waiter(command);
		else this.queue.push(command);
	}

	private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		if (request.method === "OPTIONS") {
			sendJson(response, 200, { ok: true });
			return;
		}
		const url = new URL(request.url ?? "/", this.url);
		if (request.method === "GET" && url.pathname === "/status") {
			sendJson(response, 200, this.status());
			return;
		}
		if (request.method === "POST" && url.pathname === "/command") {
			const body = JSON.parse(await readRequestBody(request)) as {
				action?: string;
				params?: Record<string, unknown>;
				timeoutMs?: number;
			};
			if (!body.action) {
				sendJson(response, 400, { ok: false, error: "Missing command action" });
				return;
			}
			try {
				const result = await this.sendLocal(body.action, body.params ?? {}, body.timeoutMs ?? DEFAULT_TIMEOUT_MS);
				sendJson(response, 200, { ok: true, result });
			} catch (error) {
				sendJson(response, 504, { ok: false, error: (error as Error).message });
			}
			return;
		}
		if (request.method === "GET" && url.pathname === "/next") {
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
				// Long-poll connection died before we could deliver. Requeue any command we pulled
				// so the next live /next picks it up instead of dropping it on the floor.
				if (command) this.queue.unshift(command);
				return;
			}
			sendJson(response, 200, command ? { type: "command", command } : { type: "none" });
			return;
		}
		if (request.method === "POST" && url.pathname === "/result") {
			this.lastSeenAt = Date.now();
			const result = JSON.parse(await readRequestBody(request)) as BridgeResult;
			const pending = this.pending.get(result.id);
			if (!pending) {
				sendJson(response, 404, { ok: false, error: "unknown command id" });
				return;
			}
			clearTimeout(pending.timer);
			this.pending.delete(result.id);
			if (result.ok) pending.resolve(result.result);
			else pending.reject(new Error(result.error ?? "Chrome extension command failed"));
			sendJson(response, 200, { ok: true });
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

export default function (pi: ExtensionAPI): void {
	const bridge = new ChromeProfileBridge(DEFAULT_HOST, DEFAULT_PORT);
	let backgroundDefault = false;

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
		const status = bridge.status();
		ctx.ui.setStatus("chrome", `Chrome bridge :${DEFAULT_PORT}`);
		ctx.ui.notify(
			status.mode === "client"
				? `Chrome profile bridge connected to shared bridge at ${bridge.url}.`
				: `Chrome profile bridge listening at ${bridge.url}. Run /chrome-onboard to load the bundled browser extension in your normal Chrome profile.`,
			"info",
		);
	});

	pi.on("session_shutdown", () => {
		bridge.stop();
	});

	pi.on("before_agent_start", (event) => {
		const primer = `
<chrome-profile-bridge>
Chrome control is available through the chrome_* tools via a companion Chrome extension installed in the user's normal Chrome profile.
This is not CDP: it can use the user's existing Chrome windows and authenticated sessions after the user loads the companion browser extension.
If chrome_* tools time out, ask the user to run /chrome-onboard, then load the bundled browser-extension folder in chrome://extensions. Prefer chrome_snapshot before clicking/typing; use stable element uids from snapshots with chrome_click/chrome_type when available. For form work, use includeSnapshot=true on actions to verify in one round trip. Avoid destructive actions unless explicitly requested. By default chrome_* tools focus Chrome and activate the target tab so the user can watch the agent work. The user can switch to silent/background mode for the whole session via /chrome-background; you can also pass background=true on a single tool call when the user explicitly wants the action to be silent (for example, scraping while they keep working in another app).
</chrome-profile-bridge>`;
		return { systemPrompt: event.systemPrompt + primer };
	});

	pi.registerCommand("chrome-doctor", {
		description:
			"Check Chrome bridge connectivity and diagnose setup. Reports the local bridge, companion Chrome extension status (ID + version), and a one-line fix for common failures (extension not loaded, stale service worker, version drift).",
		handler: async (_args, ctx) => {
			ctx.ui.notify("Performing Chrome bridge health check", "info");
			const lines: string[] = [`pi-chrome v${PI_CHROME_VERSION}`];
			const status = bridge.status();
			lines.push(`• Local bridge: mode=${status.mode}, url=${status.url}`);
			try {
				const started = Date.now();
				const version = (await bridge.send("tab.version", {}, 35_000)) as {
					extensionId?: string;
					extensionVersion?: string;
					bridgeUrl?: string;
				};
				const latencyMs = Date.now() - started;
				if (version.extensionId)
					lines.push(`✓ Companion Chrome extension responding (ID: ${version.extensionId}, ext v${version.extensionVersion ?? "unknown"}, latency ${latencyMs}ms)`);
				else lines.push(`✓ Companion Chrome extension responding (no extension ID reported, latency ${latencyMs}ms)`);
				if (version.bridgeUrl) lines.push(`• Extension polling: ${version.bridgeUrl}`);
				if (version.extensionVersion && version.extensionVersion !== PI_CHROME_VERSION) {
					lines.push(
						`⚠ Extension version (${version.extensionVersion}) differs from pi-chrome (${PI_CHROME_VERSION}). Reload "Pi Existing Chrome Profile Bridge" in chrome://extensions to pick up the latest service worker.`,
					);
				}
			} catch (error) {
				const message = (error as Error).message;
				lines.push(`✗ Companion Chrome extension not responding: ${message}`);
				if (message.includes("older pi-chrome without multi-session")) {
					lines.push("  Fix: restart the Pi session that owns the bridge (it was started on an older pi-chrome).");
				} else {
					lines.push("  Fix: run /chrome-onboard, then load the bundled browser-extension folder in chrome://extensions and keep that Chrome window open.");
				}
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("chrome-background", {
		description:
			"Toggle silent/background mode for chrome_* tools. Background ON: chrome_* tools act silently — your editor/terminal keeps focus, Chrome does not pop up, your workflow is not interrupted. Background OFF (default): Chrome focuses and activates the target tab so you can watch the agent work, useful for demos, pair-driving, and debugging — tradeoff: Chrome pops up and steals focus. Pass `on` / `off` to set explicitly, or no argument to toggle.",
		getArgumentCompletions: (prefix) => {
			const items = [
				{ value: "on", label: "on", description: "Run chrome_* actions silently without focusing Chrome" },
				{ value: "off", label: "off", description: "Bring Chrome to the foreground for chrome_* actions (default)" },
			];
			const lowered = prefix.toLowerCase();
			const matches = items.filter((item) => item.value.startsWith(lowered));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			const arg = (args || "").trim().toLowerCase();
			if (arg === "on" || arg === "true" || arg === "1") backgroundDefault = true;
			else if (arg === "off" || arg === "false" || arg === "0") backgroundDefault = false;
			else backgroundDefault = !backgroundDefault;
			ctx.ui.notify(
				backgroundDefault
					? "Chrome background mode ON. chrome_* tools will run silently. Your current app keeps focus."
					: "Chrome background mode OFF. chrome_* tools will focus Chrome and activate the target tab so you can watch the agent work.",
				"info",
			);
		},
	});

	pi.registerCommand("chrome-onboard", {
		description: "Guide Chrome extension setup for the existing-profile bridge",
		handler: async (_args, ctx) => {
			const extensionPath = browserExtensionPath();
			const proceed = await ctx.ui.confirm(
				"Chrome bridge setup",
				`This will open chrome://extensions and reveal the extension folder in Finder.\n\nAfter the windows open: enable Developer mode → Load unpacked → select:\n${extensionPath}\n\nPress Enter to continue, or Esc to cancel.`,
			);
			if (!proceed) {
				ctx.ui.notify("Chrome bridge setup cancelled", "info");
				return;
			}
			if (process.platform === "darwin") {
				await pi.exec("open", ["-a", "Google Chrome", "chrome://extensions"], { cwd: workspaceCwd(ctx), timeout: 5_000 }).catch(() => undefined);
				await pi.exec("open", ["-R", extensionPath], { cwd: workspaceCwd(ctx), timeout: 5_000 }).catch(() => undefined);
				await pi.exec("sh", ["-lc", `printf %s ${JSON.stringify(extensionPath)} | pbcopy`], { cwd: workspaceCwd(ctx), timeout: 5_000 }).catch(() => undefined);
			}
			ctx.ui.notify(
				"Chrome bridge setup opened. The extension path has been copied to your clipboard. After loading it, run /chrome-doctor.",
				"info",
			);
		},
	});

	pi.registerTool({
		name: "chrome_launch",
		label: "Chrome Bridge Setup",
		description:
			"Start/check the local bridge used by the companion Chrome extension. This does not launch a separate Chrome profile; install the unpacked Chrome extension in your existing Chrome profile to connect.",
		promptSnippet: "Show instructions for connecting Pi to the user's existing Chrome profile via the companion extension.",
		parameters: Type.Object({
			port: Type.Optional(Type.Number({ description: "Ignored unless PI_CHROME_BRIDGE_PORT is set before Pi starts." })),
			url: Type.Optional(Type.String({ description: "Optional URL to open in the existing Chrome profile after the extension is connected." })),
			userDataDir: Type.Optional(Type.String({ description: "Ignored. This bridge intentionally uses the user's existing Chrome profile through the companion extension." })),
			useDefaultProfile: Type.Optional(Type.Boolean({ description: "Ignored; existing-profile access comes from the companion Chrome extension." })),
			headless: Type.Optional(Type.Boolean({ description: "Ignored." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx): Promise<ToolTextResult> {
			if (params.url && bridge.connected) {
				const result = await bridge.send("tab.new", { url: params.url }, DEFAULT_TIMEOUT_MS);
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
		async execute(_id, params): Promise<ToolTextResult> {
			const result = await bridge.send(`tab.${params.action}`, params, DEFAULT_TIMEOUT_MS);
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
			background: Type.Optional(
				Type.Boolean({ description: "If true, run silently in the background without focusing Chrome. Default false (Chrome focuses + tab activates so the user can watch)." }),
			),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params): Promise<ToolTextResult> {
			const snapshot = await bridge.send(
				"page.snapshot",
				withBackground({ ...params, maxElements: params.maxElements ?? MAX_ELEMENTS }),
				DEFAULT_TIMEOUT_MS,
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
			background: Type.Optional(
				Type.Boolean({ description: "If true, navigate silently without focusing Chrome. Default false." }),
			),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params): Promise<ToolTextResult> {
			const result = await bridge.send("page.navigate", withBackground(params), params.timeoutMs ?? 15_000);
			return { content: [{ type: "text", text: `Navigated to ${params.url}` }], details: { result: result as Json } };
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
			returnByValue: Type.Optional(Type.Boolean({ default: true })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(
				Type.Boolean({ description: "If true, evaluate silently without focusing Chrome. Default false." }),
			),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params): Promise<ToolTextResult> {
			const value = await bridge.send("page.evaluate", withBackground(params), DEFAULT_TIMEOUT_MS);
			return { content: [{ type: "text", text: truncateText(typeof value === "string" ? value : safeJson(value)) }], details: { value: value as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_click",
		label: "Chrome Click",
		description:
			"Click a snapshot uid, CSS selector, or viewport coordinate in an existing Chrome tab through the companion extension. The click is dispatched as a synthetic DOM event; by default Chrome is focused so the user can watch, pass background=true to click silently. Pass includeSnapshot=true to return a fresh snapshot after the click.",
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
		async execute(_id, params): Promise<ToolTextResult> {
			const result = await bridge.send("page.click", withBackground(params), DEFAULT_TIMEOUT_MS);
			return { content: [{ type: "text", text: `Clicked ${params.uid ?? params.selector ?? `${params.x},${params.y}`}` }], details: { result: result as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_type",
		label: "Chrome Type",
		description:
			"Focus an optional snapshot uid or CSS selector, then type text into an existing Chrome tab through the companion extension. By default focuses Chrome and activates the tab so the user can watch; pass background=true to type silently. Pass includeSnapshot=true to return a fresh snapshot after typing.",
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
		async execute(_id, params): Promise<ToolTextResult> {
			const result = await bridge.send("page.type", withBackground(params), DEFAULT_TIMEOUT_MS);
			return { content: [{ type: "text", text: `Typed ${params.text.length} character(s)${params.uid || params.selector ? ` into ${params.uid ?? params.selector}` : ""}.` }], details: { result: result as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_fill",
		label: "Chrome Fill",
		description:
			"Set the full value of a text input, textarea, or contenteditable element using framework-aware native value setters and input/change events. Accepts a snapshot uid or CSS selector. Pass includeSnapshot=true to verify after filling.",
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
		async execute(_id, params): Promise<ToolTextResult> {
			const result = await bridge.send("page.fill", withBackground(params), DEFAULT_TIMEOUT_MS);
			return { content: [{ type: "text", text: `Filled ${params.text.length} character(s)${params.uid || params.selector ? ` into ${params.uid ?? params.selector}` : ""}.` }], details: { result: result as Json } };
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
		async execute(_id, params): Promise<ToolTextResult> {
			const result = await bridge.send("page.key", withBackground(params), DEFAULT_TIMEOUT_MS);
			return { content: [{ type: "text", text: `Pressed ${params.key}.` }], details: { result: result as Json } };
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
		async execute(_id, params): Promise<ToolTextResult> {
			const result = await bridge.send("page.waitFor", params, (params.timeoutMs ?? 10_000) + 2_000);
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
		async execute(_id, params): Promise<ToolTextResult> {
			const result = await bridge.send("page.console.list", withBackground(params), DEFAULT_TIMEOUT_MS);
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
		async execute(_id, params): Promise<ToolTextResult> {
			const result = await bridge.send("page.network.list", withBackground(params), DEFAULT_TIMEOUT_MS);
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
		async execute(_id, params): Promise<ToolTextResult> {
			const result = await bridge.send("page.network.get", withBackground(params), DEFAULT_TIMEOUT_MS);
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
		async execute(_id, params, _signal, _onUpdate, ctx: ExtensionContext): Promise<ToolTextResult> {
			const format = params.format ?? "png";
			const cwd = workspaceCwd(ctx);
			const defaultPath = join(cwd, ".pi", "chrome-screenshots", `${new Date().toISOString().replace(/[:.]/g, "-")}.${format}`);
			const outputPath = params.path ? resolve(cwd, params.path) : defaultPath;
			const result = (await bridge.send("page.screenshot", withBackground(params), DEFAULT_TIMEOUT_MS)) as { dataUrl: string; tab?: unknown };
			const base64 = result.dataUrl.replace(/^data:image\/(?:png|jpeg);base64,/, "");
			await mkdir(dirname(outputPath), { recursive: true });
			await writeFile(outputPath, Buffer.from(base64, "base64"));
			return { content: [{ type: "text", text: `Saved Chrome screenshot to ${outputPath}` }], details: { path: outputPath, format, tab: result.tab } };
		},
	});
}
