const BRIDGE_URL = "http://127.0.0.1:17318";
const CLIENT_NAME = `Pi Chrome Bridge ${chrome.runtime.id}`;
const POLL_ERROR_BACKOFF_MS = 2000;
let polling = false;

function armKeepaliveAlarm() {
  chrome.alarms.create("pi-bridge-keepalive", { periodInMinutes: 0.5 });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeText({ text: "pi" });
  chrome.action.setBadgeBackgroundColor({ color: "#4f46e5" });
  armKeepaliveAlarm();
  void pollLoop();
});

chrome.runtime.onStartup.addListener(() => {
  armKeepaliveAlarm();
  void pollLoop();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "pi-bridge-keepalive") void pollLoop();
});

chrome.action.onClicked.addListener(() => {
  armKeepaliveAlarm();
  void pollLoop();
});

armKeepaliveAlarm();

setInterval(() => {
  void pollLoop();
}, 1000);

async function pollLoop() {
  if (polling) return;
  polling = true;
  try {
    while (true) {
      const response = await fetch(`${BRIDGE_URL}/next?name=${encodeURIComponent(CLIENT_NAME)}`, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`bridge /next HTTP ${response.status}`);
      const payload = await response.json();
      if (payload.type === "command") await handleCommand(payload.command);
    }
  } catch (error) {
    await sleep(POLL_ERROR_BACKOFF_MS);
  } finally {
    polling = false;
  }
}

async function handleCommand(command) {
  try {
    const result = await dispatch(command.action, command.params ?? {});
    await postResult({ id: command.id, ok: true, result });
  } catch (error) {
    await postResult({ id: command.id, ok: false, error: error?.message ?? String(error) });
  }
}

async function postResult(result) {
  await fetch(`${BRIDGE_URL}/result`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(result),
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function dispatch(action, params) {
  switch (action) {
    case "tab.version":
      return {
        extensionId: chrome.runtime.id,
        extensionVersion: chrome.runtime.getManifest().version,
        bridgeUrl: BRIDGE_URL,
        userAgent: navigator.userAgent,
      };
    case "tab.list":
      return (await chrome.tabs.query({})).map(formatTab);
    case "tab.new": {
      const tab = await chrome.tabs.create({ url: params.url || "about:blank", active: true });
      return formatTab(tab);
    }
    case "tab.activate": {
      const tab = await getTabByParams(params);
      await chrome.windows.update(tab.windowId, { focused: true });
      return formatTab(await chrome.tabs.update(tab.id, { active: true }));
    }
    case "tab.close": {
      const tab = await getTabByParams(params);
      await chrome.tabs.remove(tab.id);
      return { closed: tab.id };
    }
    case "page.snapshot":
      return executeInTab(params, snapshotPage, [
        params.maxElements || 80,
        params.containingText ?? null,
        params.roleFilter ?? null,
        params.nearUid ?? null,
      ]);
    case "page.evaluate":
      return evaluateInTab(params);
    case "page.click":
      return executeActionInTab(params, clickPage, [params.selector ?? null, params.uid ?? null, params.x ?? null, params.y ?? null]);
    case "page.hover":
      return executeActionInTab(params, hoverPage, [params.selector ?? null, params.uid ?? null, params.x ?? null, params.y ?? null]);
    case "page.drag":
      return executeActionInTab(params, dragPage, [params.fromUid ?? null, params.fromSelector ?? null, params.fromX ?? null, params.fromY ?? null, params.toUid ?? null, params.toSelector ?? null, params.toX ?? null, params.toY ?? null, params.steps ?? 12]);
    case "page.upload":
      return executeActionInTab(params, uploadFiles, [params.selector ?? null, params.uid ?? null, params.files || []]);
    case "page.type":
      return executeActionInTab(params, typeIntoPage, [params.selector ?? null, params.uid ?? null, params.text || "", Boolean(params.pressEnter)]);
    case "page.fill":
      return executeActionInTab(params, fillPage, [params.selector ?? null, params.uid ?? null, params.text || "", params.submit === true]);
    case "page.key":
      return executeActionInTab(params, pressKeyInPage, [params.key]);
    case "page.console.list":
      return executeInTab(params, listConsoleMessages, [params.clear === true]);
    case "page.network.list":
      return executeInTab(params, listNetworkRequests, [params.includePreservedRequests === true, params.clear === true]);
    case "page.network.get":
      return executeInTab(params, getNetworkRequest, [params.requestId]);
    case "page.waitFor":
      return executeInTab(params, waitForPage, [params.kind, params.value, params.timeoutMs || 10000, params.intervalMs || 250]);
    case "page.probe":
      // Lightweight capability probe for /chrome-doctor. Runs in MAIN world.
      return executeInTab(params, probePage, []);
    case "page.navigate": {
      const tab = await getTabByParams(params);
      if (params.foreground) await bringToFront(tab);
      if (params.initScript) {
        // Register a one-shot document_start content script. We register, navigate, wait, then unregister.
        await registerInitScript(tab.id, params.initScript);
      }
      const wait = params.waitUntilLoad !== false ? waitForTabComplete(tab.id, params.timeoutMs || 15000) : Promise.resolve(undefined);
      const updated = await chrome.tabs.update(tab.id, { url: params.url });
      try {
        await wait;
      } finally {
        if (params.initScript) await unregisterInitScript(tab.id).catch(() => undefined);
      }
      return formatTab(await chrome.tabs.get(updated.id));
    }
    case "page.screenshot":
      return takeScreenshot(params);
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

function formatTab(tab) {
  return {
    id: tab.id,
    windowId: tab.windowId,
    active: tab.active,
    highlighted: tab.highlighted,
    title: tab.title || "",
    url: tab.url || "",
    status: tab.status,
    pinned: tab.pinned,
    incognito: tab.incognito,
  };
}

async function getTabByParams(params) {
  const tabs = await chrome.tabs.query({});
  let tab;
  if (params.targetId !== undefined) {
    const id = Number(params.targetId);
    tab = tabs.find((candidate) => candidate.id === id);
  } else if (params.urlIncludes) {
    tab = tabs.find((candidate) => (candidate.url || "").includes(params.urlIncludes));
  } else if (params.titleIncludes) {
    tab = tabs.find((candidate) => (candidate.title || "").includes(params.titleIncludes));
  } else {
    const active = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    tab = active[0] || tabs.find((candidate) => candidate.active) || tabs[0];
  }
  if (!tab?.id) throw new Error("No matching Chrome tab found");
  if ((tab.url || "").startsWith("chrome://") || (tab.url || "").startsWith("chrome-extension://")) {
    throw new Error(`Chrome blocks extension automation on protected URL: ${tab.url}`);
  }
  return tab;
}

// Helper sources that get concatenated into the injected MAIN-world script. Kept as separate
// functions so callers below can reference them by `.toString()`. The helpers do not perform any
// eval themselves — they're plain function declarations.
const HELPER_FUNCS = [
  getPiChromeState,
  rememberElement,
  elementBySelectorOrUid,
  installPiChromeInstrumentation,
  resolvePoint,
  dispatchInputEvents,
  setNativeValue,
  normalizeKey,
  isElementVisible,
  occluderAt,
  pageHash,
  pointerEventSequence,
];

async function executeInTab(params, func, args) {
  const tab = await getTabByParams(params);
  if (params.foreground) await bringToFront(tab);
  const helperSource = HELPER_FUNCS.map((helper) => helper.toString()).join("\n");
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "MAIN",
    func: async (helperSource, source, invocationArgs) => {
      try {
        // Helpers are plain function declarations; injecting them via Function constructor avoids
        // running through `eval` (which is restricted under strict CSP) and keeps them isolated.
        new Function(helperSource).call(globalThis);
        // The action itself is reconstructed from its source text. We use `new Function` rather
        // than `eval` because the latter is blocked by `script-src 'self'` (no `'unsafe-eval'`)
        // CSPs that are common on production sites.
        const injected = new Function(helperSource + "\nreturn (" + source + ");").call(globalThis);
        return { ok: true, value: await injected(...invocationArgs) };
      } catch (error) {
        return { ok: false, error: error?.stack || error?.message || String(error) };
      }
    },
    args: [helperSource, func.toString(), args],
  });
  const first = results?.[0];
  if (first?.error) {
    const message = typeof first.error === "string" ? first.error : (first.error.message || JSON.stringify(first.error));
    throw new Error(message);
  }
  const envelope = first?.result;
  if (envelope && typeof envelope === "object" && envelope.ok === false) {
    throw new Error(envelope.error || "Chrome page script failed");
  }
  return envelope?.value;
}

// Dedicated executor for page.evaluate. Doesn't go through the helper-source injection chain;
// that chain was the root cause of `chrome_evaluate` silently returning null on pages with strict
// CSP. We build a single Function in MAIN world and invoke it directly.
async function evaluateInTab(params) {
  const tab = await getTabByParams(params);
  if (params.foreground) await bringToFront(tab);
  const expression = String(params.expression ?? "");
  const awaitPromise = params.awaitPromise !== false;
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "MAIN",
    func: async (expression, awaitPromise) => {
      const stringify = (v) => {
        if (v === undefined) return { kind: "undefined" };
        if (typeof v === "function") return { kind: "function", source: v.toString().slice(0, 500) };
        if (typeof v === "symbol") return { kind: "symbol", description: v.description };
        if (typeof v === "bigint") return { kind: "bigint", value: v.toString() };
        if (v instanceof Error) return { kind: "error", name: v.name, message: v.message, stack: v.stack };
        return v;
      };
      // Compile via the Function constructor. We try expression form first so callers can pass
      // `1+1` or `document.title` without a `return`; if that's a SyntaxError we retry with the
      // statement form so callers can use multi-statement bodies (loops, var decls, etc).
      const compile = (src) => {
        try {
          return { fn: new Function(`return (async () => (${src}))();`), mode: "expression" };
        } catch (e1) {
          if (e1 && e1.name === "SyntaxError") {
            try {
              return { fn: new Function(`return (async () => { ${src} })();`), mode: "statement" };
            } catch (e2) {
              throw e2;
            }
          }
          throw e1;
        }
      };
      try {
        const { fn } = compile(expression);
        const value = await fn.call(globalThis);
        const resolved = awaitPromise && value && typeof value.then === "function" ? await value : value;
        return { ok: true, value: stringify(resolved) };
      } catch (error) {
        return { ok: false, error: error?.stack || error?.message || String(error) };
      }
    },
    args: [expression, awaitPromise],
  });
  const first = results?.[0];
  if (first?.error) {
    const message = typeof first.error === "string" ? first.error : (first.error.message || JSON.stringify(first.error));
    throw new Error(`chrome_evaluate failed: ${message}`);
  }
  const envelope = first?.result;
  if (!envelope) throw new Error("chrome_evaluate returned no envelope from MAIN world");
  if (envelope.ok === false) throw new Error(envelope.error || "chrome_evaluate failed");
  const v = envelope.value;
  // Unwrap special markers from MAIN world
  if (v && typeof v === "object" && !Array.isArray(v)) {
    if (v.kind === "undefined") return undefined;
    if (v.kind === "function") return `[Function: ${v.source}]`;
    if (v.kind === "symbol") return `[Symbol: ${v.description}]`;
    if (v.kind === "bigint") return v.value;
    if (v.kind === "error") throw new Error(`${v.name}: ${v.message}\n${v.stack || ""}`);
  }
  return v;
}

async function executeActionInTab(params, func, args) {
  const result = await executeInTab(params, func, args);
  if (params.includeSnapshot) {
    const snapshot = await executeInTab({ ...params, foreground: false }, snapshotPage, [params.maxElements || 80, null, null, null]);
    return { result, snapshot };
  }
  return result;
}

// One-shot init script registry, scoped per tab. The script source is injected at
// document_start of the next committed navigation in that tab, in MAIN world, then cleared.
const initScriptIds = new Map();
async function registerInitScript(tabId, source) {
  initScriptIds.set(tabId, source);
}
async function unregisterInitScript(tabId) {
  initScriptIds.delete(tabId);
}

if (chrome.webNavigation && chrome.webNavigation.onCommitted) {
  chrome.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId !== 0) return;
    const source = initScriptIds.get(details.tabId);
    if (!source) return;
    chrome.scripting.executeScript({
      target: { tabId: details.tabId, frameIds: [0] },
      world: "MAIN",
      injectImmediately: true,
      func: (code) => { try { new Function(code).call(globalThis); } catch (e) { console.error("[pi-chrome init script]", e); } },
      args: [source],
    }).catch(() => undefined);
  });
}

async function bringToFront(tab) {
  await chrome.windows.update(tab.windowId, { focused: true });
  await chrome.tabs.update(tab.id, { active: true });
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for tab ${tabId} to load`));
    }, timeoutMs);
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(true);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function takeScreenshot(params) {
  const tab = await getTabByParams(params);
  if (params.foreground) await bringToFront(tab);
  let previousActiveId;
  if (!tab.active) {
    const activeBefore = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    previousActiveId = activeBefore[0]?.id;
    await chrome.tabs.update(tab.id, { active: true });
  }
  try {
    if (params.fullPage) {
      // Tile-stitched full page capture: scroll, capture, paste, repeat.
      const tiles = await executeInTab({ ...params, foreground: false }, captureFullPageTiles, []);
      // captureFullPageTiles only computes scroll positions / metrics; we capture per scroll here
      // (chrome.tabs.captureVisibleTab can't be called from MAIN world).
      const captured = [];
      for (const tile of tiles.tiles) {
        await executeInTab({ ...params, foreground: false }, scrollToY, [tile.scrollY]);
        // Small settle delay; many sites have on-scroll animations / lazy-load.
        await sleep(120);
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
          format: params.format || "png",
          quality: params.format === "jpeg" ? params.quality : undefined,
        });
        captured.push({ y: tile.y, dataUrl });
      }
      await executeInTab({ ...params, foreground: false }, scrollToY, [tiles.originalScrollY]);
      return {
        fullPage: true,
        tab: formatTab(tab),
        dimensions: { width: tiles.width, height: tiles.height, viewportHeight: tiles.viewportHeight, dpr: tiles.dpr },
        tiles: captured,
      };
    }
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: params.format || "png",
      quality: params.format === "jpeg" ? params.quality : undefined,
    });
    return { dataUrl, tab: formatTab(tab) };
  } finally {
    if (previousActiveId !== undefined && previousActiveId !== tab.id) {
      await chrome.tabs.update(previousActiveId, { active: true }).catch(() => undefined);
    }
  }
}

// ---------------------------------------------------------------------------
// MAIN-world helpers (function declarations injected into the page).
// ---------------------------------------------------------------------------

function getPiChromeState() {
  const state = window.__PI_CHROME_STATE__ || {
    nextElementUid: 1,
    elements: {},
    console: [],
    network: [],
    nextRequestId: 1,
    instrumentationInstalled: false,
  };
  window.__PI_CHROME_STATE__ = state;
  return state;
}

function rememberElement(element) {
  const state = getPiChromeState();
  if (!element.__piChromeUid) element.__piChromeUid = "el-" + state.nextElementUid++;
  state.elements[element.__piChromeUid] = element;
  return element.__piChromeUid;
}

function elementBySelectorOrUid(selector, uid) {
  if (uid) {
    const element = getPiChromeState().elements[uid];
    if (!element || !element.isConnected) throw new Error(`No live element for uid: ${uid}. Take a fresh chrome_snapshot.`);
    return element;
  }
  if (selector) {
    const element = document.querySelector(selector);
    if (!element) throw new Error(`No element matches selector: ${selector}`);
    return element;
  }
  return null;
}

function isElementVisible(element) {
  if (!element || !element.getBoundingClientRect) return false;
  const style = getComputedStyle(element);
  if (style.visibility === "hidden" || style.display === "none") return false;
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  if (rect.bottom < 0 || rect.right < 0) return false;
  if (rect.top > innerHeight || rect.left > innerWidth) return false;
  return true;
}

function occluderAt(x, y, expected) {
  const top = document.elementFromPoint(x, y);
  if (!top || top === expected) return null;
  if (expected && expected.contains(top)) return null;
  if (top.contains(expected)) return null;
  return {
    tag: top.tagName.toLowerCase(),
    id: top.id || undefined,
    className: typeof top.className === "string" ? top.className : undefined,
  };
}

function pageHash() {
  // Cheap rolling hash used for `pageMutated`. Combines first 4kb of body innerText with the
  // current values of inputs/textareas (which are not part of innerText) and the count of
  // descendants of <body>. This catches: text changes, input value edits, and DOM structure
  // changes — the three things a click/type/fill might cause.
  const body = document.body;
  const text = (body ? body.innerText : "").slice(0, 4000);
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  if (body) {
    const inputs = body.querySelectorAll("input,textarea,select");
    let valueBlob = "";
    for (let i = 0; i < inputs.length && valueBlob.length < 4000; i++) {
      const v = inputs[i].value;
      if (typeof v === "string") valueBlob += v + "\x00";
    }
    for (let i = 0; i < valueBlob.length; i++) h = (h * 31 + valueBlob.charCodeAt(i)) | 0;
    h = (h * 31 + body.getElementsByTagName("*").length) | 0;
  }
  return h;
}

function pointerEventSequence(element, x, y, sequence) {
  let defaultPrevented = false;
  for (const type of sequence) {
    const isPointer = type.startsWith("pointer");
    const Ctor = isPointer ? PointerEvent : MouseEvent;
    const init = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: type === "pointermove" || type === "mousemove" ? 0 : 1,
    };
    if (isPointer) {
      init.pointerType = "mouse";
      init.pointerId = 1;
      init.isPrimary = true;
    }
    const ev = new Ctor(type, init);
    element.dispatchEvent(ev);
    if (ev.defaultPrevented) defaultPrevented = true;
  }
  return defaultPrevented;
}

function installPiChromeInstrumentation() {
  const state = getPiChromeState();
  if (state.instrumentationInstalled) return;
  state.instrumentationInstalled = true;
  const pushConsole = (level, args) => {
    state.console.push({
      id: state.console.length + 1,
      level,
      timestamp: Date.now(),
      url: location.href,
      args: Array.from(args).map((arg) => {
        try {
          if (typeof arg === "string") return arg;
          if (arg instanceof Error) return { name: arg.name, message: arg.message, stack: arg.stack };
          return JSON.parse(JSON.stringify(arg));
        } catch {
          return String(arg);
        }
      }),
    });
    if (state.console.length > 500) state.console.splice(0, state.console.length - 500);
  };
  for (const level of ["debug", "log", "info", "warn", "error"]){
    const original = console[level];
    if (typeof original !== "function" || original.__piChromeWrapped) continue;
    const wrapped = function(...args) {
      pushConsole(level, args);
      return original.apply(this, args);
    };
    wrapped.__piChromeWrapped = true;
    console[level] = wrapped;
  }
  window.addEventListener("error", (event) => pushConsole("pageerror", [event.message, event.filename + ":" + event.lineno + ":" + event.colno]));
  window.addEventListener("unhandledrejection", (event) => pushConsole("unhandledrejection", [event.reason]));

  const trimBody = (text) => typeof text === "string" && text.length > 200000 ? text.slice(0, 200000) + `\n[truncated ${text.length - 200000} chars]` : text;
  const record = (entry) => {
    state.network.push(entry);
    if (state.network.length > 1000) state.network.splice(0, state.network.length - 1000);
    return entry;
  };
  if (window.fetch && !window.fetch.__piChromeWrapped) {
    const originalFetch = window.fetch.bind(window);
    const wrappedFetch = async (...args) => {
      const id = "req-" + state.nextRequestId++;
      const startedAt = Date.now();
      const input = args[0];
      const init = args[1] || {};
      const url = typeof input === "string" ? input : input?.url;
      const method = (init.method || input?.method || "GET").toUpperCase();
      const entry = record({ id, type: "fetch", method, url: String(url || ""), startedAt, pageUrl: location.href, status: "pending" });
      try {
        const response = await originalFetch(...args);
        entry.status = response.status;
        entry.statusText = response.statusText;
        entry.ok = response.ok;
        entry.responseUrl = response.url;
        entry.durationMs = Date.now() - startedAt;
        entry.responseHeaders = Array.from(response.headers.entries());
        response.clone().text().then((text) => {
          entry.responseBody = trimBody(text);
          entry.responseBodyTruncated = typeof text === "string" && text.length > 200000;
        }).catch((error) => { entry.responseBodyError = error?.message || String(error); });
        return response;
      } catch (error) {
        entry.error = error?.message || String(error);
        entry.durationMs = Date.now() - startedAt;
        throw error;
      }
    };
    wrappedFetch.__piChromeWrapped = true;
    window.fetch = wrappedFetch;
  }
  if (window.XMLHttpRequest && !XMLHttpRequest.prototype.open.__piChromeWrapped) {
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      this.__piChromeRequest = { method: String(method || "GET").toUpperCase(), url: String(url || "") };
      return originalOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.open.__piChromeWrapped = true;
    XMLHttpRequest.prototype.send = function(body) {
      const id = "req-" + state.nextRequestId++;
      const startedAt = Date.now();
      const info = this.__piChromeRequest || {};
      const entry = record({ id, type: "xhr", method: info.method || "GET", url: info.url || "", startedAt, pageUrl: location.href, status: "pending" });
      this.addEventListener("loadend", () => {
        entry.status = this.status;
        entry.statusText = this.statusText;
        entry.responseUrl = this.responseURL;
        entry.durationMs = Date.now() - startedAt;
        try { entry.responseHeadersText = this.getAllResponseHeaders(); } catch {}
        try {
          if (typeof this.responseText === "string") {
            entry.responseBody = trimBody(this.responseText);
            entry.responseBodyTruncated = this.responseText.length > 200000;
          }
        } catch (error) { entry.responseBodyError = error?.message || String(error); }
      });
      this.addEventListener("error", () => { entry.error = "XMLHttpRequest error"; entry.durationMs = Date.now() - startedAt; });
      return originalSend.call(this, body);
    };
  }
}

function snapshotPage(maxElements, containingText, roleFilter, nearUid) {
  installPiChromeInstrumentation();
  const unique = (selector) => {
    try { return document.querySelectorAll(selector).length === 1; } catch { return false; }
  };
  const cssEscape = (value) => (window.CSS && CSS.escape) ? CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  const selectorFor = (element) => {
    if (element.id && unique("#" + cssEscape(element.id))) return "#" + cssEscape(element.id);
    const attr = ["aria-label", "name", "placeholder", "data-testid", "role"].find((name) => element.getAttribute(name));
    if (attr) {
      const candidate = element.tagName.toLowerCase() + "[" + attr + "=" + JSON.stringify(element.getAttribute(attr)) + "]";
      if (unique(candidate)) return candidate;
    }
    const parts = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 5) {
      let part = current.tagName.toLowerCase();
      if (current.classList.length > 0) part += "." + Array.from(current.classList).slice(0, 2).map(cssEscape).join(".");
      const siblings = Array.from(current.parentElement?.children ?? []).filter((sibling) => sibling.tagName === current.tagName);
      if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")";
      parts.unshift(part);
      const candidate = parts.join(" > ");
      if (unique(candidate)) return candidate;
      current = current.parentElement;
    }
    return parts.join(" > ");
  };
  const visible = (element) => isElementVisible(element);
  const labelFor = (element) => (
    element.getAttribute("aria-label") ||
    element.getAttribute("title") ||
    element.getAttribute("placeholder") ||
    element.innerText ||
    element.value ||
    element.textContent ||
    ""
  ).trim().replace(/\s+/g, " ").slice(0, 160);
  let candidates = Array.from(document.querySelectorAll('a, button, input, textarea, select, summary, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="checkbox"], [contenteditable="true"], [tabindex]:not([tabindex="-1"])'));
  if (containingText) {
    const needle = String(containingText).toLowerCase();
    candidates = candidates.filter((element) => labelFor(element).toLowerCase().includes(needle));
  }
  if (roleFilter) {
    const wanted = String(roleFilter).toLowerCase();
    candidates = candidates.filter((element) => {
      const role = (element.getAttribute("role") || element.tagName).toLowerCase();
      return role === wanted;
    });
  }
  let near;
  if (nearUid) {
    const state = getPiChromeState();
    near = state.elements[nearUid];
  }
  if (near) {
    const nearRect = near.getBoundingClientRect();
    const cx = nearRect.left + nearRect.width / 2;
    const cy = nearRect.top + nearRect.height / 2;
    candidates.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      const da = Math.hypot(ra.left + ra.width / 2 - cx, ra.top + ra.height / 2 - cy);
      const db = Math.hypot(rb.left + rb.width / 2 - cx, rb.top + rb.height / 2 - cy);
      return da - db;
    });
  }
  const elements = candidates.filter(visible).slice(0, maxElements).map((element, index) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const occluded = occluderAt(cx, cy, element);
    return {
      index,
      uid: rememberElement(element),
      tag: element.tagName.toLowerCase(),
      selector: selectorFor(element),
      label: labelFor(element),
      href: element.href || undefined,
      type: element.getAttribute("type") || undefined,
      role: element.getAttribute("role") || undefined,
      disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"),
      inert: Boolean(element.closest?.("[inert]")),
      pointerEvents: style.pointerEvents,
      occluded: occluded || undefined,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
    };
  });
  return {
    title: document.title,
    url: location.href,
    viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY },
    text: document.body ? document.body.innerText.replace(/\s+\n/g, "\n").trim().slice(0, 30000) : "",
    elements,
    filter: { containingText: containingText || undefined, roleFilter: roleFilter || undefined, nearUid: nearUid || undefined },
  };
}

function probePage() {
  // Sanity probe used by /chrome-doctor. Returns evidence that MAIN-world execution works.
  return {
    arithmetic: 1 + 1,
    location: location.href,
    title: document.title,
    documentReady: document.readyState,
    userAgent: navigator.userAgent.slice(0, 200),
    webdriver: !!navigator.webdriver,
  };
}

function captureFullPageTiles() {
  // Returns the *plan* for tile capture; the actual chrome.tabs.captureVisibleTab calls happen
  // in the SW. We just report the scroll positions and metrics.
  const html = document.documentElement;
  const body = document.body;
  const width = Math.max(html.scrollWidth, body ? body.scrollWidth : 0, innerWidth);
  const height = Math.max(html.scrollHeight, body ? body.scrollHeight : 0, innerHeight);
  const viewportHeight = innerHeight;
  const dpr = window.devicePixelRatio || 1;
  const originalScrollY = scrollY;
  const tiles = [];
  let y = 0;
  while (y < height) {
    tiles.push({ y, scrollY: y });
    y += viewportHeight;
  }
  return { width, height, viewportHeight, dpr, originalScrollY, tiles };
}

function scrollToY(y) {
  window.scrollTo({ top: y, left: 0, behavior: "instant" });
  return { scrollY };
}

function resolvePoint(selector, uid, x, y) {
  const element = elementBySelectorOrUid(selector, uid);
  if (element) {
    element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const rect = element.getBoundingClientRect();
    return { element, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, rect };
  }
  if (typeof x !== "number" || typeof y !== "number") throw new Error("Provide selector, uid, or x/y");
  return { element: document.elementFromPoint(x, y), x, y, rect: undefined };
}

function clickPage(selector, uid, x, y) {
  installPiChromeInstrumentation();
  const before = pageHash();
  const point = resolvePoint(selector, uid, x, y);
  if (!point.element) throw new Error("No element at click point");
  const visible = isElementVisible(point.element);
  const occluded = occluderAt(point.x, point.y, point.element);
  const defaultPrevented = pointerEventSequence(point.element, point.x, point.y, [
    "pointerdown", "mousedown", "pointerup", "mouseup", "click",
  ]);
  // Heuristic: if the clicked thing looks like a media play affordance and the page has paused
  // audio/video, the synthetic click may not unlock autoplay. Surface a warning.
  let autoplayHint;
  const label = (point.element.getAttribute("aria-label") || point.element.textContent || "").toLowerCase();
  if (/^(play|start|begin|next|continue|unmute)/.test(label.trim())) {
    const idleMedia = Array.from(document.querySelectorAll("audio,video")).some((m) => m.paused);
    if (idleMedia) autoplayHint = "This element looks like a media affordance and the page has paused media. Synthetic clicks do not satisfy user-activation gates; audio/video may not start.";
  }
  return {
    x: point.x,
    y: point.y,
    selector,
    uid,
    tag: point.element.tagName,
    isTrusted: false,
    defaultPrevented,
    elementVisible: visible,
    occludedBy: occluded || undefined,
    pageMutated: pageHash() !== before,
    autoplayHint,
  };
}

function hoverPage(selector, uid, x, y) {
  installPiChromeInstrumentation();
  const point = resolvePoint(selector, uid, x, y);
  if (!point.element) throw new Error("No element to hover");
  const defaultPrevented = pointerEventSequence(point.element, point.x, point.y, [
    "pointerover", "mouseover", "pointerenter", "mouseenter", "pointermove", "mousemove",
  ]);
  return { x: point.x, y: point.y, selector, uid, tag: point.element.tagName, defaultPrevented, isTrusted: false };
}

function dragPage(fromUid, fromSelector, fromX, fromY, toUid, toSelector, toX, toY, steps) {
  installPiChromeInstrumentation();
  const before = pageHash();
  const from = resolvePoint(fromSelector, fromUid, fromX, fromY);
  const to = resolvePoint(toSelector, toUid, toX, toY);
  if (!from.element) throw new Error("Drag source element not found");
  if (!to.element) throw new Error("Drag target element not found");
  pointerEventSequence(from.element, from.x, from.y, ["pointerover", "pointerdown", "mousedown"]);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = from.x + (to.x - from.x) * t;
    const y = from.y + (to.y - from.y) * t;
    const overEl = document.elementFromPoint(x, y) || to.element;
    pointerEventSequence(overEl, x, y, ["pointermove", "mousemove"]);
  }
  pointerEventSequence(to.element, to.x, to.y, ["pointerover", "mouseover", "pointerup", "mouseup"]);
  return {
    from: { x: from.x, y: from.y },
    to: { x: to.x, y: to.y },
    steps,
    pageMutated: pageHash() !== before,
    note: "Synthetic pointer drag. HTML5 DataTransfer is not synthesized; native drag-and-drop targets may not respond.",
  };
}

function uploadFiles(selector, uid, files) {
  installPiChromeInstrumentation();
  const element = elementBySelectorOrUid(selector, uid);
  if (!element || element.tagName !== "INPUT" || element.type !== "file") {
    throw new Error("Target must be <input type=file>");
  }
  const dt = new DataTransfer();
  for (const f of files) {
    const bytes = Uint8Array.from(atob(f.base64 || ""), (c) => c.charCodeAt(0));
    dt.items.add(new File([bytes], f.name, { type: f.type || "application/octet-stream" }));
  }
  element.files = dt.files;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return { uploaded: files.map((f) => ({ name: f.name, type: f.type, size: (f.base64 || "").length })) };
}

function dispatchInputEvents(element, data, inputType = "insertText") {
  element.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType, data }));
  element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType, data }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function setNativeValue(element, value) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  if (descriptor?.set) descriptor.set.call(element, value);
  else element.value = value;
}

function typeIntoPage(selector, uid, text, pressEnter) {
  installPiChromeInstrumentation();
  const before = pageHash();
  let element = elementBySelectorOrUid(selector, uid) || document.activeElement;
  if (!element) throw new Error(selector || uid ? `No element for ${selector || uid}` : "No active element");
  element.focus();
  if (element.isContentEditable) {
    document.execCommand("insertText", false, text);
  } else if ("value" in element) {
    const start = element.selectionStart ?? element.value.length;
    const end = element.selectionEnd ?? element.value.length;
    setNativeValue(element, element.value.slice(0, start) + text + element.value.slice(end));
    element.selectionStart = element.selectionEnd = start + text.length;
    dispatchInputEvents(element, text, "insertText");
  } else {
    throw new Error("Focused element is not text-editable");
  }
  if (pressEnter) pressKeyInPage("Enter");
  return {
    selector, uid, length: text.length, pressEnter,
    isTrusted: false,
    valueMatches: "value" in element ? element.value.includes(text) : undefined,
    pageMutated: pageHash() !== before,
  };
}

function fillPage(selector, uid, text, submit) {
  installPiChromeInstrumentation();
  const before = pageHash();
  let element = elementBySelectorOrUid(selector, uid) || document.activeElement;
  if (!element) throw new Error(selector || uid ? `No element for ${selector || uid}` : "No active element");
  element.focus();
  if (element.isContentEditable) {
    element.textContent = "";
    document.execCommand("insertText", false, text);
  } else if ("value" in element) {
    setNativeValue(element, text);
    const length = String(text).length;
    try { element.selectionStart = element.selectionEnd = length; } catch {}
    dispatchInputEvents(element, text, "insertReplacementText");
  } else {
    throw new Error("Focused element is not text-editable");
  }
  if (submit) pressKeyInPage("Enter");
  return {
    selector, uid, length: String(text).length, submit,
    isTrusted: false,
    valueMatches: "value" in element ? element.value === String(text) : undefined,
    pageMutated: pageHash() !== before,
  };
}

function pressKeyInPage(key) {
  const normalized = normalizeKey(key);
  const target = document.activeElement || document.body;
  const before = (typeof pageHash === "function") ? pageHash() : 0;
  const down = new KeyboardEvent("keydown", { key: normalized, bubbles: true, cancelable: true });
  target.dispatchEvent(down);
  const up = new KeyboardEvent("keyup", { key: normalized, bubbles: true, cancelable: true });
  target.dispatchEvent(up);
  if (normalized === "Enter") {
    const form = target.closest?.("form");
    if (form) form.requestSubmit?.();
  }
  return {
    key: normalized,
    isTrusted: false,
    defaultPrevented: down.defaultPrevented || up.defaultPrevented,
    pageMutated: (typeof pageHash === "function") ? pageHash() !== before : undefined,
  };
}

function listConsoleMessages(clear) {
  installPiChromeInstrumentation();
  const state = getPiChromeState();
  const messages = state.console.slice();
  if (clear) state.console = [];
  return { messages, count: messages.length };
}

function listNetworkRequests(includePreservedRequests, clear) {
  installPiChromeInstrumentation();
  const state = getPiChromeState();
  const currentUrl = location.href;
  const requests = state.network
    .filter((request) => includePreservedRequests || request.pageUrl === currentUrl)
    .map(({ responseBody, ...summary }) => ({ ...summary, hasResponseBody: responseBody !== undefined }));
  if (clear) state.network = [];
  return { requests, count: requests.length, note: "Captures fetch/XHR after instrumentation is installed. Browser-initiated document/static asset requests are not captured." };
}

function getNetworkRequest(requestId) {
  installPiChromeInstrumentation();
  const request = getPiChromeState().network.find((entry) => entry.id === requestId);
  if (!request) throw new Error(`No network request with id ${requestId}`);
  return request;
}

async function waitForPage(kind, value, timeoutMs, intervalMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    let ok = false;
    if (kind === "selector") ok = Boolean(document.querySelector(value));
    else {
      try { ok = Boolean(new Function("return (" + value + ");").call(globalThis)); } catch { ok = false; }
    }
    if (ok) return { elapsedMs: Date.now() - started };
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${kind}: ${value}`);
}

function normalizeKey(key) {
  const table = {
    enter: "Enter",
    escape: "Escape",
    tab: "Tab",
    backspace: "Backspace",
    delete: "Delete",
    arrowup: "ArrowUp",
    arrowdown: "ArrowDown",
    arrowleft: "ArrowLeft",
    arrowright: "ArrowRight",
  };
  return table[String(key).toLowerCase()] || key;
}
