// Pop-ups do not close under the user's hands.
//
// Selecting text in a box and letting go of the mouse outside it makes the
// browser fire a click on the backdrop, which used to close the saved RAMS
// box. A pop-up closes on a click or tap outside only when the press and the
// release were both outside. Real mouse presses: synthetic clicks do not show
// the fault.
//
// A mock of the OpRAMS backend runs in memory, so no live Cloud record is
// touched.
//
//   node tests/popups.test.js
//
// Needs puppeteer-core: set OPRAMS_TEST_MODULES to a node_modules folder that
// has it, CHROME_PATH if Chrome is not in the usual Windows place, and
// OPRAMS_REPO to test another copy of the repo.
const http = require("http");
const fs = require("fs");
const path = require("path");

const MODS = process.env.OPRAMS_TEST_MODULES || "";
const puppeteer = require(MODS ? path.join(MODS, "puppeteer-core") : "puppeteer-core");
const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const REPO = process.env.OPRAMS_REPO || path.join(__dirname, "..");
const FRONT = path.join(REPO, "frontend");
const results = [];
const check = (name, ok, detail) => { results.push(!!ok); console.log((ok ? "PASS " : "FAIL ") + name + (detail && !ok ? "  -- " + detail : "")); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const MIME = { ".html": "text/html; charset=utf-8", ".js": "application/javascript", ".png": "image/png", ".svg": "image/svg+xml", ".css": "text/css" };
const now = new Date().toISOString();
const server = http.createServer((req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
  if (p === "/auth/me") return send(200, { user: { id: 1, email: "tester@example.test", role: "user" } });
  if (p === "/assessments") return send(200, { assessments: [{ id: "00000000-0000-4000-8000-000000000001", name: "Made up RAMS", created_at: now, updated_at: now }] });
  const f = path.join(FRONT, p);
  if (f.startsWith(path.normalize(FRONT)) && fs.existsSync(f) && fs.statSync(f).isFile()) {
    res.writeHead(200, { "Content-Type": MIME[path.extname(f)] || "application/octet-stream" });
    return res.end(fs.readFileSync(f));
  }
  send(404, { error: "not found" });
});

(async () => {
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = "http://localhost:" + server.address().port;
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new" });
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 768 });
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("dialog", d => d.dismiss());
  await page.setRequestInterception(true);
  page.on("request", r => r.url().startsWith(base) || /^(data|blob):/.test(r.url()) || !/archerhs\.co\.uk/.test(r.url()) ? r.continue() : r.abort());
  await page.goto(base + "/oprams.html", { waitUntil: "load", timeout: 60000 });
  await sleep(2500);

  const there = sel => page.evaluate(s => !!document.querySelector(s), sel);
  const points = sel => page.evaluate(s => {
    const ov = document.querySelector(s); let out = null, inn = null;
    for (let x = 6; x < innerWidth && !out; x += 20) for (let y = 6; y < innerHeight && !out; y += 20) if (document.elementFromPoint(x, y) === ov) out = { x, y };
    for (const e of ov.querySelectorAll("input,textarea,strong,b,span,div")) {
      if (inn) break; if (e.children.length) continue;
      const r = e.getBoundingClientRect(); if (r.width < 20 || r.height < 8) continue;
      const q = { x: r.x + Math.min(r.width / 2, 40), y: r.y + r.height / 2 }, t = document.elementFromPoint(q.x, q.y);
      if (t && t !== ov && ov.contains(t)) inn = q;
    }
    return { inn, out };
  }, sel);
  const drag = async (a, b) => {
    await page.evaluate(() => getSelection().removeAllRanges());
    await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 8 }); await page.mouse.up(); await sleep(150);
  };
  const box = async (name, sel, openIt) => {
    const open = async () => { await page.evaluate(s => document.querySelectorAll(s).forEach(e => e.remove()), sel); await page.evaluate(openIt); await sleep(700); };
    await open();
    if (!(await there(sel))) return check(name + " opens", false);
    const q = await points(sel);
    if (!q.inn || !q.out) return check(name + " has a point inside and outside to test", false, JSON.stringify(q));
    await drag(q.inn, q.out); check(name + ": text selected past the edge, it stays open", await there(sel)); if (!(await there(sel))) await open();
    await drag(q.out, q.inn); check(name + ": pressed outside and let go inside, it stays open", await there(sel)); if (!(await there(sel))) await open();
    await page.evaluate(() => getSelection().removeAllRanges());
    await page.mouse.click(q.out.x, q.out.y); await sleep(200); check(name + ": a click outside still closes it", !(await there(sel)));
    await open(); await page.touchscreen.tap(q.out.x, q.out.y); await sleep(400); check(name + ": a tap outside closes it", !(await there(sel)));
    await open();
    check(name + ": the Close button still closes it", await page.evaluate(s => { [...document.querySelector(s).querySelectorAll("button")].find(b => b.textContent.trim() === "Close").click(); return !document.querySelector(s); }, sel));
    await page.evaluate(s => document.querySelectorAll(s).forEach(e => e.remove()), sel);
  };
  await box("Saved RAMS box", "#op-saved-backdrop", () => document.getElementById("op-btnCloudOpen").click());
  await box("Print preview", ".prev-back", () => msPreviewOpen());
  check("no page errors", !errors.length, errors.join(" | "));

  // and nobody writes a bare one again
  const bare = [];
  for (const f of [path.join(FRONT, "oprams.html"), path.join(FRONT, "oprams-adapter.js"), path.join(REPO, "index.html")])
    fs.readFileSync(f, "utf8").split(/\r?\n/).forEach((l, i) => {
      if (/(?:event|ev|e)\.target\s*===?\s*(?:this|ov|back|backdrop|modal|overlay|bg|el|box)\b/.test(l) && !/_downSelf/.test(l)) bare.push(path.basename(f) + ":" + (i + 1));
    });
  check("no pop-up has a bare click-to-close backdrop", !bare.length, bare.join(", "));
  // the plain app and the served app carry the same page
  const plain = fs.readFileSync(path.join(REPO, "index.html"), "utf8").replace(/\r/g, ""), served = fs.readFileSync(path.join(FRONT, "oprams.html"), "utf8").replace(/\r/g, "");
  const tags = '<script src="config.js"></script>\n<script src="api.js"></script>\n<script src="oprams-adapter.js"></script>\n';
  check("the served page is the plain page plus the three script tags", served.split(tags).join("") === plain);

  await browser.close(); server.close();
  const failed = results.filter(r => !r).length;
  console.log("\n" + (results.length - failed) + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
