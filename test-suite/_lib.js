// Tiny shared harness for challenge pages.
// Each page calls Challenge.init({id, instructions}) then Challenge.pass()/fail()
// based on its own listeners.
(function () {
  const events = [];
  const state = {
    id: null,
    verdict: "PENDING",
    reason: [],
    events,
  };

  function render() {
    const el = document.getElementById("__verdict");
    if (!el) return;
    el.textContent = state.verdict;
    el.dataset.verdict = state.verdict;
    el.style.background =
      state.verdict === "PASS" ? "#1f7a1f" :
      state.verdict === "FAIL" ? "#a11" :
      state.verdict === "SKIP" ? "#76520b" :
      state.verdict === "WARN" ? "#6b5d00" : "#444";
    el.style.color = "#fff";
    const r = document.getElementById("__reason");
    if (r) r.textContent = state.reason.join("\n");
  }

  function log(name, detail) {
    events.push({ t: performance.now(), name, ...detail });
    if (events.length > 500) events.shift();
  }

  const Challenge = {
    init({ id, instructions }) {
      state.id = id;
      document.title = `[${state.verdict}] ${id}`;
      const root = document.body;
      const bar = document.createElement("div");
      bar.style.cssText =
        "position:sticky;top:0;background:#111;color:#eee;padding:8px 12px;font:13px monospace;border-bottom:1px solid #333;z-index:9999";
      bar.innerHTML = `
        <b>${id}</b>
        <span id="__verdict" style="margin-left:8px;padding:2px 8px;border-radius:4px;background:#444">PENDING</span>
        <span style="margin-left:12px;opacity:.7">${instructions}</span>
        <pre id="__reason" style="white-space:pre-wrap;margin:6px 0 0;color:#bbb;font:12px monospace"></pre>
      `;
      root.insertBefore(bar, root.firstChild);
      window.__challenge = id;
      window.__verdict = state.verdict;
      window.__reason = state.reason;
      window.__events = state.events;
      render();
    },
    pass(...reasons) {
      if (state.verdict === "FAIL") return; // sticky
      state.verdict = "PASS";
      state.reason.push(...reasons.map((r) => "✓ " + r));
      window.__verdict = state.verdict;
      document.title = `[PASS] ${state.id}`;
      persist(); render();
    },
    fail(...reasons) {
      state.verdict = "FAIL";
      state.reason.push(...reasons.map((r) => "✗ " + r));
      window.__verdict = state.verdict;
      document.title = `[FAIL] ${state.id}`;
      persist(); render();
    },
    skip(...reasons) {
      if (state.verdict === "FAIL" || state.verdict === "PASS") return;
      state.verdict = "SKIP";
      state.reason.push(...reasons.map((r) => "↷ " + r));
      window.__verdict = state.verdict;
      document.title = `[SKIP] ${state.id}`;
      persist(); render();
    },
    warn(...reasons) {
      if (state.verdict === "FAIL" || state.verdict === "PASS") return;
      state.verdict = "WARN";
      state.reason.push(...reasons.map((r) => "! " + r));
      window.__verdict = state.verdict;
      document.title = `[WARN] ${state.id}`;
      persist(); render();
    },
    log,
    state,
  };

  function persist() {
    try {
      localStorage.setItem(
        "pi-chrome-suite:" + state.id,
        JSON.stringify({ id: state.id, verdict: state.verdict, reason: state.reason, events: state.events.slice(-50), ts: Date.now() })
      );
    } catch {}
  }

  window.Challenge = Challenge;
})();
