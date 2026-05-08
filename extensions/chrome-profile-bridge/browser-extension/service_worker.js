const BRIDGE_URL = "http://127.0.0.1:17318";
const CLIENT_NAME = `Pi Chrome Bridge ${chrome.runtime.id}`;
const POLL_ERROR_BACKOFF_MS = 2000;
let polling = false;

function armKeepaliveAlarm() {
  // MV3 service workers can be suspended; alarms are the supported way to
  // wake the extension again. Chrome's minimum period is 0.5 minutes.
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
      // Long-poll /next continuously. The bridge holds the request for up to ~25s when no
      // command is pending and returns {type:"none"}; we immediately re-issue the fetch so
      // commands sent while the SW is otherwise idle still get picked up promptly. The open
      // fetch also keeps the MV3 service worker alive between alarm wake-ups.
      const response = await fetch(`${BRIDGE_URL}/next?name=${encodeURIComponent(CLIENT_NAME)}`, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`bridge /next HTTP ${response.status}`);
      const payload = await response.json();
      if (payload.type === "command") await handleCommand(payload.command);
      // Otherwise (type:"none"), loop and re-issue the long-poll.
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
      return executeInTab(params, snapshotPage, [params.maxElements || 80]);
    case "page.evaluate":
      return executeInTab(params, evaluateExpression, [params.expression, params.awaitPromise !== false]);
    case "page.click":
      return executeActionInTab(params, clickPage, [params.selector ?? null, params.uid ?? null, params.x ?? null, params.y ?? null]);
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
    case "page.navigate": {
      const tab = await getTabByParams(params);
      if (params.foreground) await bringToFront(tab);
      const wait = params.waitUntilLoad !== false ? waitForTabComplete(tab.id, params.timeoutMs || 15000) : Promise.resolve(undefined);
      const updated = await chrome.tabs.update(tab.id, { url: params.url });
      await wait;
      return formatTab(await chrome.tabs.get(updated.id));
    }
    case "page.screenshot": {
      const tab = await getTabByParams(params);
      if (params.foreground) await bringToFront(tab);
      // captureVisibleTab requires the target tab to be the active tab in its window. Activate it
      // without focusing the window so other apps don't get pushed behind Chrome, and restore the
      // previous active tab afterwards to minimize disruption.
      let previousActiveId;
      if (!tab.active) {
        const activeBefore = await chrome.tabs.query({ active: true, windowId: tab.windowId });
        previousActiveId = activeBefore[0]?.id;
        await chrome.tabs.update(tab.id, { active: true });
      }
      try {
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

async function executeInTab(params, func, args) {
  const tab = await getTabByParams(params);
  if (params.foreground) await bringToFront(tab);
  const helperSource = [
    getPiChromeState,
    rememberElement,
    elementBySelectorOrUid,
    installPiChromeInstrumentation,
    resolvePoint,
    dispatchInputEvents,
    setNativeValue,
    normalizeKey,
  ].map((helper) => helper.toString()).join("\n");
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "MAIN",
    func: async (helperSource, source, invocationArgs) => {
      try {
        (0, eval)(helperSource);
        const injected = (0, eval)(`(${source})`);
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

async function executeActionInTab(params, func, args) {
  const result = await executeInTab(params, func, args);
  if (params.includeSnapshot) {
    const snapshot = await executeInTab({ ...params, foreground: false }, snapshotPage, [params.maxElements || 80]);
    return { result, snapshot };
  }
  return result;
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

function snapshotPage(maxElements) {
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
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
  };
  const labelFor = (element) => (
    element.getAttribute("aria-label") ||
    element.getAttribute("title") ||
    element.getAttribute("placeholder") ||
    element.innerText ||
    element.value ||
    element.textContent ||
    ""
  ).trim().replace(/\s+/g, " ").slice(0, 160);
  const candidates = Array.from(document.querySelectorAll('a, button, input, textarea, select, summary, [role="button"], [role="link"], [contenteditable="true"], [tabindex]:not([tabindex="-1"])'));
  const elements = candidates.filter(visible).slice(0, maxElements).map((element, index) => {
    const rect = element.getBoundingClientRect();
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
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
    };
  });
  return {
    title: document.title,
    url: location.href,
    viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY },
    text: document.body ? document.body.innerText.replace(/\s+\n/g, "\n").trim().slice(0, 30000) : "",
    elements,
  };
}

async function evaluateExpression(expression, awaitPromise) {
  installPiChromeInstrumentation();
  const indirectEval = (0, eval);
  const value = indirectEval(expression);
  return awaitPromise && value && typeof value.then === "function" ? await value : value;
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
  const point = resolvePoint(selector, uid, x, y);
  if (!point.element) throw new Error("No element at click point");
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
    point.element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: point.x, clientY: point.y, button: 0 }));
  }
  return { x: point.x, y: point.y, selector, uid, tag: point.element.tagName };
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
  return { selector, uid, length: text.length, pressEnter };
}

function fillPage(selector, uid, text, submit) {
  installPiChromeInstrumentation();
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
  return { selector, uid, length: String(text).length, submit };
}

function pressKeyInPage(key) {
  const normalized = normalizeKey(key);
  const target = document.activeElement || document.body;
  target.dispatchEvent(new KeyboardEvent("keydown", { key: normalized, bubbles: true, cancelable: true }));
  target.dispatchEvent(new KeyboardEvent("keyup", { key: normalized, bubbles: true, cancelable: true }));
  if (normalized === "Enter") {
    const form = target.closest?.("form");
    if (form) form.requestSubmit?.();
  }
  return { key: normalized };
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
  return { requests, count: requests.length, note: "Captures fetch/XHR after instrumentation is installed (snapshot/evaluate/network/console tools install it). Browser-initiated document/static asset requests are not captured." };
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
    else ok = Boolean((0, eval)(value));
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
