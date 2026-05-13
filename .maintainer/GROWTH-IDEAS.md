# Growth ideas — for your review

This file is **draft copy and ideas for the maintainer to review and choose from**, not anything that's been sent or published anywhere. Nothing here goes out without you doing it yourself.

It also collects outside-the-package ideas (things I can't do without your accounts/approval) so we have one place to triage.

---

## Inside-the-package — already shipped in this growth pass

- README rewrite (hero, comparison table, complete tool list grouped, killer recipes, architecture diagram, honest-results section, benchmark plug)
- `package.json` keywords expanded for npm search SEO (`browser-automation`, `playwright-alternative`, `puppeteer-alternative`, `agent`, `llm-tools`, `browser-use`, `stagehand-alternative`, etc.)
- `package.json` description rewritten as a one-line elevator pitch
- `homepage`, `repository`, `bugs` fields added (npm shows them on the package page)
- `CHANGELOG.md` (signals active maintenance)
- `LICENSE` (MIT)
- `CONTRIBUTING.md` (signals openness; sets bar)
- `SECURITY.md` (signals maturity)
- `docs/COMPARISON.md` (deep comparison vs Playwright / Puppeteer / Stagehand / browser-use / Selenium)
- `docs/EXAMPLES.md` (ready-to-paste agent prompts)
- `docs/FAQ.md` (kills common adoption friction)
- Cross-links from `pi-bar` and `pi-qq` READMEs back to pi-chrome

---

## Inside-the-package — candidates you should consider

These are package-only changes you could approve quickly. Listed roughly by ROI.

1. **Demo GIF or animated SVG in the README.** A 10–15s clip of `/chrome onboard` → `chrome_tab list` → `chrome_snapshot` → summary lands the value prop in one glance. (I can't record it from inside Pi; you'd need to record once, drop it under `assets/` and link from the README.)
2. **`assets/screenshot-*.png`** with one or two static screenshots of the agent operating Chrome. Even one frame is huge for the npm page; npm renders images inline from README.
3. **Open-source-friendly badges** in README: `pi-package` badge, "tested with test-suite", coverage-of-categories badge generated from `manifest.json`.
4. **`prompt-primer.md`** — short prompt block the agent reads on first `chrome_*` use, teaching it `snapshot → uid → act → verify envelope`. Currently in-tool descriptions, but a primer lets users `include` it in their own agent prompts.
5. **`recipes/` directory** with `.md` files per workflow (PR triage, Linear standup, etc.) so each one has a stable URL on npm.
6. **Auto-generated tool reference** (`docs/TOOLS.md`) derived from `index.ts` Type.Object schemas. Shows agents and humans the exact param shapes.
7. **Reload-on-update prompt.** After `pi install npm:pi-chrome` upgrades the package, `/chrome doctor` could auto-suggest the exact `chrome://extensions` reload step. Already half there — could be more aggressive.
8. **A "scorecard" badge** the README can render after running `test-suite/` — e.g. `pi-chrome • 27/30 challenges passing`. Auto-generated from the manifest + a local run.
9. **Quickstart video** — same as #1 but longer, hosted on YouTube / Vimeo. README can embed a thumbnail link.
10. **`pi-chrome --version` CLI helper** (if pi-package convention supports it) so users can sanity-check from a shell.

---

## Outside-the-package — for you to do, when you want

Nothing here is sent or published. These are drafts.

### Short copy (one-liner)

> **pi-chrome** — give your Pi coding agent your real, logged-in Chrome. No re-login, no throwaway profile, no CDP wrangling. `pi install npm:pi-chrome`.

### Long copy (X/Twitter single tweet)

> Built pi-chrome: 20 browser tools for Pi agents that drive your **real Chrome** — every tab you're already signed into.
>
> No re-login. No throwaway profile. Watch the agent work live, or run silent.
>
> `pi install npm:pi-chrome`
>
> https://www.npmjs.com/package/pi-chrome

### X/Twitter thread (8 posts) — draft

1/ Most browser agents make you log in again. They spawn a throwaway Chrome, replay cookies, and pray your SSO/MFA doesn't catch on.

2/ pi-chrome flips it. A tiny MIT-licensed Chrome extension lives in your **normal profile**. Your agent drives the tabs you already have open — GitHub, Linear, Stripe, your admin panel, all of it.

3/ 20 tools: click, type, navigate, screenshot, drag, scroll, touch (real CDP), file upload (no picker), network capture with response bodies, console capture, snapshot with stable element uids.

4/ Honest result envelopes. When a click doesn't take effect, you get back: "occluded by div#overlay" or "pageMutated=false" — not a silent retry loop.

5/ Multi-session safe. Planner / worker / audit Pi sessions share one bridge automatically. They all see the same Chrome state because it's your real one.

6/ Quiet by default (synthetic DOM events, no Chrome banner). One toggle for trusted CDP input when sites need it. Or per-call.

7/ Comes with a benchmark suite. 30+ static pages graded on trusted clicks, pointer humanization, keyboard fidelity, drag/drop, Shadow DOM, file inputs, network observability, fingerprint leaks.

8/ `pi install npm:pi-chrome` → `/chrome onboard` → done in 60s. https://www.npmjs.com/package/pi-chrome

### Hacker News — Show HN draft

**Title:** Show HN: pi-chrome – give an LLM agent your real, logged-in Chrome (no re-login)

**Body:**

I've been frustrated that browser agents always make you log in again — they spin up Playwright/Puppeteer with an isolated profile and try to replay cookies, which falls over on real-world SSO/MFA/admin tools.

pi-chrome is the opposite approach: a small MIT-licensed unpacked Chrome extension lives in the Chrome profile you already use. Your Pi agent drives the tabs you already have open. No re-login. Ever.

20 tools: snapshot/click/type/fill/navigate/scroll/drag/upload/screenshot, plus network and console capture with response bodies, plus real CDP touch events for mobile PWAs.

What makes it different from everything else:

- **Synthetic input first**, trusted CDP only when needed. Quiet by default — no "Chrome is being debugged" banner unless a site forces it.
- **Honest result envelopes.** Every action returns pageMutated, defaultPrevented, elementVisible, occludedBy, valueMatches. Agents stop looping blindly on broken clicks.
- **Multi-session.** Multiple Pi sessions on the same machine share one bridge automatically.
- **A built-in benchmark suite** with 30+ pages grading any browser-control tool. PRs welcome with your competitor's scores.

It is Chrome-only by design (it's a Chrome extension) and not a fit for headless scraping at scale — it's for **your editor session** acting on **your real apps**.

Install: `pi install npm:pi-chrome` then `/chrome onboard`.

Source: https://github.com/tianrendong/pi-chrome

### Reddit — r/ChatGPTCoding / r/LocalLLaMA draft

**Title:** pi-chrome: lets your LLM coding agent use the Chrome you're already logged into

**Body:**

If you've tried browser agents you've hit the wall where they want you to log in again. pi-chrome (MIT) is a Pi extension that does the obvious thing instead: a tiny Chrome extension in your normal profile, agent drives your real tabs.

20 tools for the agent — click, type, navigate, screenshot, drag, scroll, real touch, file upload through React inputs (no native picker), network capture with response bodies, console capture, snapshot with stable element uids.

Why pi-chrome over Playwright/Puppeteer/Selenium when the use case is "agent in your editor":

- You stay signed in. SSO/MFA/admin pinning works because the agent IS you in those tabs.
- Watch it work live, or toggle silent mode for the whole session.
- Honest result envelopes (pageMutated/occludedBy/valueMatches) — the agent knows when a click failed.
- Multi-session safe — planner + worker Pi sessions share one bridge.
- Benchmark suite included; we test in public.

`pi install npm:pi-chrome` → `/chrome onboard` → 60 seconds to first useful run.

https://www.npmjs.com/package/pi-chrome

---

## Outside-the-package — bigger growth bets

Not draft copy — strategic moves you might run later.

1. **Public benchmark leaderboard.** Run `test-suite/` against every major browser-control tool monthly, publish results in `docs/SCORES.md` with a link from README. We've got the moat; this surfaces it. Initial bar: pi-chrome (synthetic), pi-chrome (trusted), Playwright, Puppeteer, Stagehand, browser-use, Selenium.
2. **Awesome-pi list PR.** Submit pi-chrome to any "awesome agentic tools" / "awesome browser automation" list on GitHub. Each one is a backlink that costs nothing.
3. **"Built on pi-chrome" gallery.** A `docs/GALLERY.md` showcasing real workflows people built — invites users to submit their own and self-promotes the package.
4. **YouTube demo, 90 seconds.** "Watch a coding agent triage my GitHub notifications using my logged-in Chrome." Highest-leverage single asset for adoption.
5. **A `pi-chrome-recipes` companion package.** Curated recipe library installable via `pi install npm:pi-chrome-recipes` so users get inspirational `/recipe` slash commands. Doubles install count.
6. **Pi-coding-agent feature highlight.** Coordinate with the Pi team to feature pi-chrome in a "Tool of the month" or in onboarding docs.
7. **Comparison blog post on dev.to / hashnode.** Same content as `docs/COMPARISON.md` but as an indexable blog post with a discoverable title like "Playwright vs Puppeteer vs pi-chrome: when to use which for AI agents."
8. **Hook into agentic-AI Discords / Slacks.** browser-use, Stagehand, and AutoGPT communities are full of people whose first instinct is to ship a throwaway-profile bot. pi-chrome solves a real complaint they have weekly.
9. **VS Code / Cursor extension that surfaces `/chrome` commands from the editor command palette.** Low-effort, high-discoverability.
10. **Auto-generated case-study page** per recipe in `docs/EXAMPLES.md` with a screenshot, hosted at `https://pi-chrome.dev` (or a GitHub Pages site). Each one is an indexable landing page.
11. **Sponsorship / featured listing on awesome-llm-agents lists** if any take paid placement.
12. **`pi install npm:pi-chrome` mentioned in pi-coding-agent's own README** if there's a "popular extensions" section.

---

## Demo / show-off prompt (paste in Pi after install)

```text
Use chrome_tab list to find my GitHub notifications tab.
chrome_snapshot it. Write me a 5-bullet ranked PR triage:
which PRs need my review today, sorted by staleness.
Do not click anything.
```

If this lands cleanly in 30 seconds with their real GitHub session, you've sold them.
