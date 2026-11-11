// Restore = "open this client", and the Cloud record that is open.
//
// A JSON restore must REPLACE what is on screen (brand included) and let go
// of the Cloud record that was open, so the reload does not fetch that record
// back (the "flicker") and the next Cloud Save cannot write one client into
// another client's record. The header says which Cloud record is open;
// "Save as new…" always creates; Cloud Save keeps the record's name; a
// refresh keeps unsaved work; Reset lets go of the record; backups are named
// <Company>_Oprams_Backup_<date>.json.
//
// A mock of the OpRAMS backend runs in memory (the same routes and shapes as
// backend/src/routes/assessments.js), so no live Cloud record is touched.
// Headless Chrome drives the real frontend files in the user's order, then
// the offline index.html from file://.
//
//   node tests/restore-cloud.test.js
//
// Needs puppeteer-core: set OPRAMS_TEST_MODULES to a node_modules folder that
// has it, and CHROME_PATH if Chrome is not in the usual Windows place.
// By default the test makes up its own client backups. To run it on copies
// of real backups instead (never commit those: this repo is public), set
// OPRAMS_FIXTURES to a folder holding a.json (a client with brand and logo),
// b.json (another client with brand, logo and more fields), bare.json (no
// brand at all, fewer fields than b) and old.json (any backup taken before
// this change).
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

const MODS = process.env.OPRAMS_TEST_MODULES || "";
const puppeteer = require(MODS ? path.join(MODS, "puppeteer-core") : "puppeteer-core");
const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const REPO = process.env.OPRAMS_REPO || path.join(__dirname, "..");
const FRONT = path.join(REPO, "frontend");
const RUN = fs.mkdtempSync(path.join(os.tmpdir(), "oprams-restore-"));
const TODAY = new Date().toISOString().slice(0, 10);
// OPRAMS_CORE_ONLY=1 runs only what code from before this change can be
// driven through (restore over an open record, fewer fields over more,
// storage full), to show the test catches the bug it was written for.
const CORE_ONLY = !!process.env.OPRAMS_CORE_ONLY;

// ---------------- the backups ----------------
const P = "easytravel.ramsv1.";   // the storage prefix: must not change
const SV = { [P + "schema.version"]: "2026-04-28-v6-restore-rewire", [P + "ui.activeTab"]: "ra" };
const PNG_A = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PNG_B = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
function madeUp() {
  const b = {
    ...SV, "brand.name": "Client B Design", "brand.logo": PNG_B, "brand.primary": "#04044b", "brand.accent": "#2a7ab0",
    [P + "ra.meta.reference"]: "CB-RA-001", [P + "ra.meta.task"]: "Client B survey task",
    [P + "ra.meta.location"]: "Client B site", [P + "ra.lh.subtitle"]: "Client B Design",
    [P + "ms.sig.author"]: "B Author", [P + "ms.sig.position"]: "Surveyor",
  };
  for (let r = 1; r <= 20; r++) { b[P + "ra.signoff.r" + r + ".name"] = "B reader " + r; b[P + "ms.signoff.r" + r + ".name"] = "B reader " + r; }
  return {
    a: { ...SV, "brand.name": "Client A (North) Ltd", "brand.logo": PNG_A, "brand.primary": "#2e2e2e", "brand.accent": "#7a8a1a", "brand.text": "#06090e",
         [P + "ra.meta.reference"]: "CA-RA-01", [P + "ra.meta.task"]: "Client A workshop task", [P + "ra.meta.location"]: "Workshop",
         [P + "ra.lh.subtitle"]: "Client A (North) Ltd" },
    b,
    bare: { ...SV, [P + "ra.meta.reference"]: "BARE-01", [P + "ra.meta.task"]: "Unbranded task", [P + "ra.meta.location"]: "Yard" },
    old: { ...SV, "brand.name": "Client C Ltd", "brand.logo": PNG_A, [P + "ra.meta.reference"]: "CC-RA-07", [P + "ra.meta.task"]: "Client C task" },
  };
}
const FIX = process.env.OPRAMS_FIXTURES || "";
const B = {};
const data = FIX ? null : madeUp();
for (const n of ["a", "b", "bare", "old"]) {
  if (FIX) B[n] = path.join(FIX, n + ".json");
  else { B[n] = path.join(RUN, n === "old" ? "rams-backup-2026-10-14.json" : "fixture-" + n + ".json"); fs.writeFileSync(B[n], JSON.stringify(data[n], null, 2)); }
}
const read = f => JSON.parse(fs.readFileSync(f, "utf8"));
const A = read(B.a), Bk = read(B.b), BARE = read(B.bare), OLD = read(B.old);
// The rule from the spec, written out again here: spaces to hyphens, drop
// what Windows will not take. Fixed cases below pin it independently.
const fileFor = name => (String(name || "").replace(/[<>:"\/\\|?*\u0000-\u001f]/g, "").trim()
  .replace(/\s+/g, "-").replace(/-{2,}/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "AHS") + "_Oprams_Backup_" + TODAY + ".json";

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail: detail || "" });
  console.log((ok ? "PASS " : "FAIL ") + name + (detail && !ok ? "  -- " + detail : ""));
};

// ---------------- mock backend ----------------
const db = new Map(); let seq = 0; const reqLog = []; const patchBodies = []; let failListOnce = false;
function seed(name, keys) {
  const id = "00000000-0000-4000-8000-" + String(++seq).padStart(12, "0");
  const now = new Date().toISOString();
  db.set(id, { id, name, state: { keys: JSON.parse(JSON.stringify(keys)), savedAt: now }, created_at: now, updated_at: now });
  return id;
}
const brief = a => ({ id: a.id, name: a.name, created_at: a.created_at, updated_at: a.updated_at });
const MIME = { ".html": "text/html", ".js": "application/javascript", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".json": "application/json", ".webmanifest": "application/manifest+json" };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const p = u.pathname;
  reqLog.push(req.method + " " + p);
  const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(obj == null ? "" : JSON.stringify(obj)); };
  let body = "";
  req.on("data", c => body += c);
  req.on("end", () => {
    const json = body ? JSON.parse(body) : {};
    if (p === "/auth/me") return send(200, { user: { id: 1, email: "tester@example.test", role: "user" } });
    if (p === "/auth/logout") return send(200, { ok: true });
    if (p === "/assessments" && req.method === "GET") {
      if (failListOnce) { failListOnce = false; return send(500, { error: { message: "Mock list failure" } }); }
      return send(200, { assessments: [...db.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).map(brief) });
    }
    if (p === "/assessments" && req.method === "POST") {
      const id = seed(json.name, json.state.keys); return send(201, { assessment: brief(db.get(id)) });
    }
    const m = p.match(/^\/assessments\/([^/]+)$/);
    if (m) {
      const a = db.get(decodeURIComponent(m[1]));
      if (!a) return send(404, { error: { code: "NOT_FOUND", message: "Not found." } });
      if (req.method === "GET") return send(200, { assessment: a });
      if (req.method === "PATCH") {
        patchBodies.push(Object.keys(json).sort());
        if (json.name !== undefined) a.name = json.name;
        if (json.state !== undefined) a.state = json.state;
        a.updated_at = new Date().toISOString();
        return send(200, { assessment: brief(a) });
      }
      if (req.method === "DELETE") { db.delete(a.id); return send(200, { ok: true }); }
    }
    // static, as express.static(... { extensions: ['html'] })
    const f = p === "/" ? "/index.html" : p;
    let fp = path.join(FRONT, f);
    if (!fs.existsSync(fp) && fs.existsSync(fp + ".html")) fp += ".html";
    if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
      res.writeHead(200, { "Content-Type": MIME[path.extname(fp)] || "application/octet-stream" });
      return res.end(fs.readFileSync(fp));
    }
    res.writeHead(404); res.end();
  });
});

// ---------------- browser helpers ----------------
async function newBrowser(tag) {
  const dl = path.join(RUN, "dl-" + tag); fs.mkdirSync(dl, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: path.join(RUN, "profile-" + tag), args: ["--no-first-run", "--no-default-browser-check"] });
  const cdp = await browser.target().createCDPSession();
  await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dl, eventsEnabled: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 768 });
  const ctx = { browser, page, dl, errors: [], dialogs: [], promptAnswer: null, confirmAnswer: true, loads: 0 };
  page.on("pageerror", e => ctx.errors.push("pageerror: " + e.message));
  page.on("console", m => { if (m.type() === "error") ctx.errors.push("console: " + m.text() + " @ " + ((m.location() || {}).url || "")); });
  page.on("dialog", async d => {
    ctx.dialogs.push({ type: d.type(), msg: d.message() });
    if (d.type() === "prompt") { if (ctx.promptAnswer == null) await d.dismiss(); else await d.accept(ctx.promptAnswer); }
    else if (d.type() === "confirm") { if (ctx.confirmAnswer) await d.accept(); else await d.dismiss(); }
    else await d.accept();
  });
  page.on("load", () => { ctx.loads++; });
  return ctx;
}
const ours = () => {
  const o = {};
  for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith("easytravel.ramsv1.") || k.startsWith("brand.")) o[k] = localStorage.getItem(k); }
  return o;
};
const lsOf = page => page.evaluate(ours);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const labelOf = page => page.$eval("#op-cloudLabel", el => el.textContent).catch(() => null);
async function waitCloudReady(page) { await page.waitForSelector("#op-btnCloudSave", { timeout: 30000 }); }
// Count real page loads, not history.replaceState (which puppeteer's
// waitForNavigation also resolves on).
async function untilLoaded(ctx, n0, ms = 60000) {
  const t = Date.now();
  while (ctx.loads <= n0) { if (Date.now() - t > ms) throw new Error("page did not reload"); await sleep(100); }
}
async function restoreFile(ctx, file, { expectReload = true } = {}) {
  const input = await ctx.page.$("#restoreFile");
  const n0 = ctx.loads;
  await input.uploadFile(file);
  if (expectReload) await untilLoaded(ctx, n0);
  else await sleep(1500);
}
async function cloudOpenLoad(ctx, id) {
  const { page } = ctx;
  await page.click("#op-btnCloudOpen");
  await page.waitForSelector(`[data-load="${id}"]`, { timeout: 15000 });
  const n0 = ctx.loads;
  await page.click(`[data-load="${id}"]`);
  await untilLoaded(ctx, n0);
  await waitCloudReady(page);
}
// The keys a backup turns into once the app has loaded it into a clean
// browser: the control every "nothing left behind" check compares with.
const controls = {};
async function control(name, file) {
  const c = await newBrowser("control-" + name);
  try {
    await c.page.goto(BASE + "/oprams", { waitUntil: "load" });
    await waitCloudReady(c.page);
    await restoreFile(c, file);
    await sleep(1500);
    controls[name] = await lsOf(c.page);
  } finally { await c.browser.close(); }
  return controls[name];
}
function sameKeys(a, b) {
  const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
  const extra = ka.filter(k => !(k in b)), missing = kb.filter(k => !(k in a));
  const diff = ka.filter(k => k in b && a[k] !== b[k]);
  return { ok: !extra.length && !missing.length && !diff.length, detail: `extra ${extra.length} [${extra.slice(0, 5)}] missing ${missing.length} [${missing.slice(0, 5)}] differ ${diff.length} [${diff.slice(0, 5)}]` };
}
async function waitDownload(dir, re, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const hit = fs.readdirSync(dir).find(f => re.test(f) && !/\.crdownload$/.test(f));
    if (hit) { await sleep(300); return path.join(dir, hit); }
    await sleep(200);
  }
  return null;
}
// Text on the RA and MS sheets, minus the snippet pickers (the library's own
// option labels are there on a clean start and are not anyone's work).
const sheetText = page => page.evaluate(() => {
  const parts = [];
  for (const root of [document.getElementById("raForms"), document.getElementById("msPages")]) {
    const c = root.cloneNode(true); c.querySelectorAll("select, option").forEach(n => n.remove()); parts.push(c.textContent);
  }
  return parts.join("\n");
});
const headerName = page => page.$eval('.header-title [data-brand="name"]', e => e.textContent.trim());

let BASE;
(async () => {
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  BASE = "http://127.0.0.1:" + server.address().port;
  const RA_REF = P + "ra.meta.reference", TASK = P + "ra.meta.task";
  const CA = seed("TEST Client A", A);
  const CB = seed("TEST Client B", Bk);
  const caSeedCopy = JSON.stringify(db.get(CA).state);

  for (const [n, f] of Object.entries(B)) await control(n, f);

  const ctx = await newBrowser("main");
  const { page } = ctx;
  try {
    await page.goto(BASE + "/oprams", { waitUntil: "load" });
    await waitCloudReady(page);
    check("0. blank start: label reads Not saved to Cloud", (await labelOf(page)) === "Not saved to Cloud", await labelOf(page));
    check("0. Save as new button is next to Cloud Save", await page.$eval("#op-btnCloudSave", b => !!b.nextElementSibling && b.nextElementSibling.id === "op-btnSaveAsNew"));

    // ---- 1. Open TEST Client A, restore Client B's backup ----
    await cloudOpenLoad(ctx, CA);
    await sleep(1500);
    check("1a. Cloud Open: label names the record", (await labelOf(page)) === "Cloud: TEST Client A", await labelOf(page));
    check("1a. Cloud Open: URL carries ?id=", new URL(page.url()).searchParams.get("id") === CA, page.url());
    check("1a. Cloud Open: Client A brand on screen", (await lsOf(page))["brand.name"] === A["brand.name"]);

    ctx.dialogs.length = 0; const mark = reqLog.length; const loads0 = ctx.loads;
    await restoreFile(ctx, B.b);
    await waitCloudReady(page);
    await sleep(4000); // long enough for any auto-load back to the Cloud record to fire
    const after = reqLog.slice(mark);
    const conf = ctx.dialogs.find(d => d.type === "confirm");
    check("1b. restore asks first, in the spec's words", conf && conf.msg === "Restoring this backup replaces everything on screen, including the branding. Anything not saved to the Cloud or exported will be lost. Continue?", conf && conf.msg);
    check("1b. no fetch of the old Cloud record after restore", !after.some(r => r === "GET /assessments/" + CA), after.join(", "));
    check("1b. exactly one reload (no flicker back)", ctx.loads - loads0 === 1, "page loads " + (ctx.loads - loads0));
    check("1b. URL has no ?id=", !new URL(page.url()).searchParams.has("id"), page.url());
    check("1b. label reads Not saved to Cloud", (await labelOf(page)) === "Not saved to Cloud", await labelOf(page));
    const s1 = sameKeys(await lsOf(page), controls.b);
    check("1b. storage is exactly Client B's backup (nothing of A left)", s1.ok, s1.detail);
    check("1b. Client B name in the header", (await headerName(page)) === Bk["brand.name"], await headerName(page));
    check("1b. Client B logo in the header", (await page.$eval("#brandLogo", i => i.getAttribute("src") || "")) === Bk["brand.logo"]);

    // ---- 2. Cloud Save after a restore asks for a name and creates new ----
    ctx.dialogs.length = 0; ctx.promptAnswer = "TEST Client B restored"; const mark2 = reqLog.length;
    await page.click("#op-btnCloudSave");
    await page.waitForFunction(() => /^Cloud: /.test((document.getElementById("op-cloudLabel") || {}).textContent || ""), { timeout: 15000 }).catch(() => {});
    const r2 = reqLog.slice(mark2);
    check("2. Cloud Save asked for a name", ctx.dialogs.some(d => d.type === "prompt"));
    check("2. Cloud Save created a new record (POST, no PATCH)", r2.includes("POST /assessments") && !r2.some(r => r.startsWith("PATCH")), r2.join(", "));
    const newRec = [...db.values()].find(a => a.name === "TEST Client B restored");
    check("2. the Cloud copy carries only the work, not the held-record marker", newRec && !Object.keys(newRec.state.keys).some(k => !k.startsWith(P) && !k.startsWith("brand.")));
    check("2. label names the new record", (await labelOf(page)) === "Cloud: TEST Client B restored", await labelOf(page));
    check("2. URL now carries the new record's id", newRec && new URL(page.url()).searchParams.get("id") === newRec.id, page.url());
    check("2. TEST Client A unchanged on the server", JSON.stringify(db.get(CA).state) === caSeedCopy && db.get(CA).name === "TEST Client A");
    await cloudOpenLoad(ctx, CA); await sleep(1500);
    const s2 = sameKeys(await lsOf(page), controls.a);
    check("2. reopened TEST Client A is Client A's work, intact", s2.ok, s2.detail);
    check("2. label back on TEST Client A", (await labelOf(page)) === "Cloud: TEST Client A", await labelOf(page));

    if (!CORE_ONLY) {
    // ---- 2b. Save as new… while a record is open ----
    ctx.dialogs.length = 0; ctx.promptAnswer = "TEST Client A split"; const mark3 = reqLog.length;
    await page.click("#op-btnSaveAsNew");
    await page.waitForFunction(() => document.getElementById("op-cloudLabel").textContent === "Cloud: TEST Client A split", { timeout: 15000 }).catch(() => {});
    const r3 = reqLog.slice(mark3);
    const split = [...db.values()].find(a => a.name === "TEST Client A split");
    check("2b. Save as new asks for a name", ctx.dialogs.some(d => d.type === "prompt" && /new Cloud record/.test(d.msg)), JSON.stringify(ctx.dialogs));
    check("2b. Save as new creates, never updates", r3.includes("POST /assessments") && !r3.some(r => r.startsWith("PATCH")), r3.join(", "));
    check("2b. label moves to the new record", (await labelOf(page)) === "Cloud: TEST Client A split", await labelOf(page));
    check("2b. URL moves to the new record", split && new URL(page.url()).searchParams.get("id") === split.id, page.url());
    check("2b. TEST Client A still unchanged", JSON.stringify(db.get(CA).state) === caSeedCopy && db.get(CA).name === "TEST Client A");
    ctx.dialogs.length = 0; ctx.promptAnswer = null; const mark3c = reqLog.length;
    await page.click("#op-btnSaveAsNew"); await sleep(800);
    check("2b. Cancel on Save as new saves nothing", !reqLog.slice(mark3c).some(r => r.startsWith("POST") || r.startsWith("PATCH")));

    // plain Cloud Save on the open record updates THAT record only, and keeps its name
    const mark4 = reqLog.length;
    await page.click("#op-btnCloudSave");
    await sleep(1500);
    const r4 = reqLog.slice(mark4);
    check("2c. Cloud Save with a record open updates it (PATCH to that id only)", r4.length === 1 && r4[0] === "PATCH /assessments/" + split.id, r4.join(", "));
    const afterSaveLabel = await labelOf(page);
    check("2c. Cloud Save sends the work only, never a new name", JSON.stringify(patchBodies[patchBodies.length - 1]) === '["state"]', JSON.stringify(patchBodies[patchBodies.length - 1]));
    check("2c. the record keeps its name after Cloud Save", db.get(split.id).name === "TEST Client A split", db.get(split.id).name);
    check("2c. label unchanged after Cloud Save", afterSaveLabel === "Cloud: TEST Client A split", afterSaveLabel);

    // rename + delete of the open record, and the colours
    await page.click("#op-btnCloudOpen");
    await page.waitForSelector(`[data-rename="${split.id}"]`);
    const colours = await page.$eval(`[data-del="${split.id}"]`, b => ({ c: getComputedStyle(b).color, bc: getComputedStyle(b).borderColor }));
    check("2e. Delete button is charcoal (--danger), not red", colours.c === "rgb(51, 65, 85)" && colours.bc === "rgb(203, 213, 225)", JSON.stringify(colours));
    ctx.promptAnswer = "TEST Client A split renamed";
    await page.click(`[data-rename="${split.id}"]`); await sleep(800);
    check("2d. rename of the open record updates the label", (await labelOf(page)) === "Cloud: TEST Client A split renamed", await labelOf(page));
    await page.$eval("#op-btnCloudSave", b => b.click()); await sleep(1500);
    check("2d. a Cloud Save after a rename keeps the new name", db.get(split.id).name === "TEST Client A split renamed" && (await labelOf(page)) === "Cloud: TEST Client A split renamed", db.get(split.id).name);
    await page.click(`[data-del="${split.id}"]`); await sleep(800);
    check("2d. delete of the open record: label reads Not saved to Cloud", (await labelOf(page)) === "Not saved to Cloud", await labelOf(page));
    check("2d. delete of the open record: ?id= gone", !new URL(page.url()).searchParams.has("id"), page.url());
    await page.click("#op-modal-close");
    failListOnce = true;
    await page.click("#op-btnCloudOpen");
    await page.waitForFunction(() => /Could not load your saved records/.test(document.getElementById("op-modal-body").textContent), { timeout: 10000 });
    const errColour = await page.$eval("#op-modal-body > div", d => getComputedStyle(d).color);
    check("2e. load-error text is charcoal (--danger), not red", errColour === "rgb(51, 65, 85)", errColour);
    await page.click("#op-modal-close");
    }

    // ---- 3. fewer fields, no logo, over a record with more ----
    await cloudOpenLoad(ctx, CB); await sleep(1000);
    check("3. TEST Client B open, with its logo", (await lsOf(page))["brand.logo"] === Bk["brand.logo"]);
    await restoreFile(ctx, B.bare); await waitCloudReady(page); await sleep(2500);
    const ls3 = await lsOf(page);
    const s3 = sameKeys(ls3, controls.bare);
    check("3. storage is exactly the smaller backup", s3.ok, s3.detail);
    check("3. no brand keys at all remain", !Object.keys(ls3).some(k => k.startsWith("brand.")), Object.keys(ls3).filter(k => k.startsWith("brand.")).join(","));
    const v3 = await page.evaluate(() => ({ logoShown: getComputedStyle(document.getElementById("brandLogo")).display !== "none", mark: getComputedStyle(document.getElementById("brandMark")).display !== "none" }));
    const t3 = await sheetText(page);
    check("3. logo gone, AHS mark back", !v3.logoShown && v3.mark);
    check("3. company name gone (header reads AHS RAMS)", (await headerName(page)) === "AHS RAMS", await headerName(page));
    check("3. Client B's reference gone from the sheets", !t3.includes(Bk[RA_REF]), Bk[RA_REF]);
    check("3. Client B's task gone from the sheets", !t3.includes(Bk[TASK]), Bk[TASK]);
    check("3. Client B's content gone from storage", !JSON.stringify(ls3).includes(Bk[RA_REF]) && !JSON.stringify(ls3).includes(Bk[TASK]));
    check("3. label reads Not saved to Cloud", (await labelOf(page)) === "Not saved to Cloud");

    // ---- 3b. Cancel on the restore question changes nothing ----
    const beforeCancel = await lsOf(page); ctx.confirmAnswer = false; const navC = ctx.loads;
    await restoreFile(ctx, B.b, { expectReload: false });
    ctx.confirmAnswer = true;
    check("3b. Cancel: nothing restored, no reload", sameKeys(await lsOf(page), beforeCancel).ok && ctx.loads === navC);

    // ---- 3c. storage full part way: everything put back ----
    await cloudOpenLoad(ctx, CA); await sleep(1000);
    const beforeFull = await lsOf(page); const navF = ctx.loads;
    await page.evaluate(() => {
      const orig = Storage.prototype.setItem; let n = 0;
      Storage.prototype.setItem = function (k, v) {
        if (window.__failAt && ++n === window.__failAt) { window.__failAt = 0; throw new DOMException("The quota has been exceeded.", "QuotaExceededError"); }
        return orig.call(this, k, v);
      };
      window.__failAt = 6;
    });
    await restoreFile(ctx, B.b, { expectReload: false });
    const toastFull = await page.$eval("#toast", t => t.textContent);
    check("3c. full storage: nothing restored, previous work put back", sameKeys(await lsOf(page), beforeFull).ok, sameKeys(await lsOf(page), beforeFull).detail);
    check("3c. full storage: says so plainly", /Storage is full: only \d+ of \d+ items fit in this browser, so nothing was restored\. Your previous work is back as it was\./.test(toastFull), toastFull);
    check("3c. full storage: no reload, still on TEST Client A", ctx.loads === navF && new URL(page.url()).searchParams.get("id") === CA && (await labelOf(page)) === "Cloud: TEST Client A");

    if (!CORE_ONLY) {
    // ---- 4. refresh, Reset branding, signing in again: unsaved work kept ----
    const settle = async (n0) => { await untilLoaded(ctx, n0); await sleep(2500); await waitCloudReady(page); };
    let n0 = ctx.loads; await page.reload({ waitUntil: "load" }); await settle(n0); // also clears the 3c stub
    await page.evaluate(() => {
      const el = document.querySelector('[data-key="ra.meta.task"]'); el.focus();
      const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    });
    await page.keyboard.type("UNSAVED EDIT 123"); await sleep(1000);
    check("4. an unsaved edit is in the browser", /UNSAVED EDIT 123/.test((await lsOf(page))[TASK] || ""), (await lsOf(page))[TASK]);
    let m4 = reqLog.length; n0 = ctx.loads;
    await page.reload({ waitUntil: "load" }); await settle(n0);
    let r4b = reqLog.slice(m4);
    check("4a. F5 with a record open does not fetch the record again", !r4b.includes("GET /assessments/" + CA), r4b.join(", "));
    check("4a. F5 keeps the unsaved edit", /UNSAVED EDIT 123/.test((await lsOf(page))[TASK] || ""), (await lsOf(page))[TASK]);
    check("4a. F5: one page load, label and address still on TEST Client A", ctx.loads - n0 === 1 && (await labelOf(page)) === "Cloud: TEST Client A" && new URL(page.url()).searchParams.get("id") === CA, (ctx.loads - n0) + " " + (await labelOf(page)) + " " + page.url());

    m4 = reqLog.length; n0 = ctx.loads;
    await page.evaluate(() => resetBranding()); await settle(n0);
    r4b = reqLog.slice(m4);
    const ls4b = await lsOf(page);
    check("4b. Reset branding sticks with a record open (no brand keys, no fetch)", !Object.keys(ls4b).some(k => k.startsWith("brand.")) && !r4b.includes("GET /assessments/" + CA), r4b.join(", "));
    check("4b. Reset branding: still TEST Client A, edit kept", (await labelOf(page)) === "Cloud: TEST Client A" && /UNSAVED EDIT 123/.test(ls4b[TASK] || ""));

    m4 = reqLog.length; n0 = ctx.loads;
    await page.goto(BASE + "/oprams", { waitUntil: "load" }); await settle(n0);
    r4b = reqLog.slice(m4);
    check("4c. signing in again (no ?id=): label names the record the work belongs to", (await labelOf(page)) === "Cloud: TEST Client A", await labelOf(page));
    check("4c. signing in again: ?id= put back, record not fetched, edit kept", new URL(page.url()).searchParams.get("id") === CA && !r4b.includes("GET /assessments/" + CA) && /UNSAVED EDIT 123/.test((await lsOf(page))[TASK] || ""), r4b.join(", ") + " " + page.url());

    // a record deleted elsewhere (another device): let go of it
    const GONE = seed("TEST deleted elsewhere", A);
    await cloudOpenLoad(ctx, GONE); await sleep(1000);
    db.delete(GONE);
    n0 = ctx.loads; await page.reload({ waitUntil: "load" }); await settle(n0);
    check("4d. held record deleted elsewhere: Not saved to Cloud, ?id= gone", (await labelOf(page)) === "Not saved to Cloud" && !new URL(page.url()).searchParams.has("id"), (await labelOf(page)) + " " + page.url());

    // an address naming a DIFFERENT record still opens that record
    m4 = reqLog.length; n0 = ctx.loads;
    await page.goto(BASE + "/oprams?id=" + CB, { waitUntil: "load" }); await untilLoaded(ctx, n0 + 1); await sleep(2500); await waitCloudReady(page);
    check("4e. ?id= of another record opens that record", reqLog.slice(m4).includes("GET /assessments/" + CB) && (await labelOf(page)) === "Cloud: TEST Client B" && (await lsOf(page))["brand.name"] === Bk["brand.name"]);

    // Reset with a record open lets go of it, so a Cloud Save cannot blank the record
    await cloudOpenLoad(ctx, CA); await sleep(1000);
    m4 = reqLog.length; n0 = ctx.loads;
    await page.evaluate(() => resetApp()); await settle(n0);
    r4b = reqLog.slice(m4);
    check("4f. Reset with a record open: Not saved to Cloud, ?id= gone, no fetch", (await labelOf(page)) === "Not saved to Cloud" && !new URL(page.url()).searchParams.has("id") && !r4b.includes("GET /assessments/" + CA), (await labelOf(page)) + " " + page.url() + " " + r4b.join(", "));
    const ls4f = await lsOf(page);
    check("4f. Reset cleared the work", !(ls4f[TASK] || "").includes(A[TASK]) && !(ls4f[RA_REF] || "").includes(A[RA_REF]), (ls4f[TASK] || "") + " | " + (ls4f[RA_REF] || ""));
    const m4f = reqLog.length; ctx.promptAnswer = null;
    await page.click("#op-btnCloudSave"); await sleep(800);
    check("4f. Cloud Save after Reset asks for a name (cancelled: nothing saved)", !reqLog.slice(m4f).some(r => r.startsWith("POST") || r.startsWith("PATCH")) && JSON.stringify(db.get(CA).state) === caSeedCopy);

    // ---- 5. export file name + round trip ----
    await cloudOpenLoad(ctx, CA); await sleep(1500);
    const aOnScreen = await lsOf(page);
    await page.evaluate(() => exportJSON());
    const fA = await waitDownload(ctx.dl, /_Oprams_Backup_/);
    check("5. export named <Company>_Oprams_Backup_<date>.json", fA && path.basename(fA) === fileFor(A["brand.name"]), fA && path.basename(fA));
    const exported = fA ? read(fA) : {};
    check("5. export carries only the work, not the held-record marker", !Object.keys(exported).some(k => !k.startsWith(P) && !k.startsWith("brand.")));
    check("5. export contents unchanged in shape (flat key: value, same keys as on screen)", sameKeys(exported, aOnScreen).ok, sameKeys(exported, aOnScreen).detail);
    const fresh = await newBrowser("fresh");
    try {
      await fresh.page.goto(BASE + "/oprams", { waitUntil: "load" }); await waitCloudReady(fresh.page);
      await restoreFile(fresh, fA); await sleep(1500);
      const s5 = sameKeys(await lsOf(fresh.page), aOnScreen);
      check("5. exported file restores into a fresh browser and matches", s5.ok, s5.detail);
      check("5. fresh browser: no errors", !fresh.errors.length, fresh.errors.join(" | "));
    } finally { await fresh.browser.close(); }
    const at = "2026-11-11T10:00:00Z";
    const names = await page.evaluate(at => [
      backupFileName("Acme Building Services", new Date(at)),
      backupFileName("Client A (North) Ltd", new Date(at)),
      backupFileName("A/B: C*D? \"E\" <F> | G\\H", new Date(at)),
      backupFileName("  ...Ltd. ", new Date(at)),
      backupFileName("", new Date(at)),
      backupFileName(null, new Date(at)),
      backupFileName("   ", new Date(at)),
    ], at);
    check("5. file name rule", JSON.stringify(names) === JSON.stringify([
      "Acme-Building-Services_Oprams_Backup_2026-11-11.json",
      "Client-A-(North)-Ltd_Oprams_Backup_2026-11-11.json",
      "AB-CD-E-F-GH_Oprams_Backup_2026-11-11.json",
      "Ltd_Oprams_Backup_2026-11-11.json",
      "AHS_Oprams_Backup_2026-11-11.json",
      "AHS_Oprams_Backup_2026-11-11.json",
      "AHS_Oprams_Backup_2026-11-11.json",
    ]), JSON.stringify(names));

    // ---- 6. a backup taken before this change still opens ----
    await restoreFile(ctx, B.old); await waitCloudReady(page); await sleep(1500);
    const s6 = sameKeys(await lsOf(page), controls.old);
    check("6. an older backup still restores", s6.ok, s6.detail);
    check("6. its brand shows", (await headerName(page)) === (OLD["brand.name"] || "AHS RAMS"), await headerName(page));
    // and with no brand set, the export falls back to AHS_
    await restoreFile(ctx, B.bare); await waitCloudReady(page); await sleep(1000);
    await page.evaluate(() => exportJSON());
    const fAHS = await waitDownload(ctx.dl, /^AHS_Oprams_Backup_/);
    check("5. no brand name: AHS_Oprams_Backup_<date>.json", fAHS && path.basename(fAHS) === "AHS_Oprams_Backup_" + TODAY + ".json", fAHS);

    // the one 500 the test forces on purpose (to see the load-error text) is excused, nothing else
    const servedErr = ctx.errors.filter(e => !/status of 500/.test(e) || !/\/assessments$/.test(e));
    check("7. served app: exactly one forced 500, otherwise no console errors or page errors", ctx.errors.length - servedErr.length === 1 && !servedErr.length, ctx.errors.join(" | "));
    }
  } finally { await ctx.browser.close(); }

  // ---- 8. the standalone offline index.html (no adapter) ----
  if (!CORE_ONLY) {
  const off = await newBrowser("offline");
  try {
    const url = pathToFileURL(path.join(REPO, "index.html")).href;
    await off.page.goto(url, { waitUntil: "load" });
    await off.page.waitForFunction(() => typeof exportJSON === "function");
    check("8. offline: no Cloud label or buttons (no adapter)", !(await off.page.$("#op-cloudLabel")) && !(await off.page.$("#op-btnCloudSave")));
    await restoreFile(off, B.b); await sleep(1500);
    await restoreFile(off, B.bare); await sleep(1500);
    const lsOff = await lsOf(off.page);
    check("8. offline: restore replaces (no brand or Client B content left)", !Object.keys(lsOff).some(k => k.startsWith("brand.")) && !JSON.stringify(lsOff).includes(Bk[RA_REF]) && sameKeys(lsOff, controls.bare).ok, sameKeys(lsOff, controls.bare).detail);
    await restoreFile(off, B.a); await sleep(1500);
    await off.page.evaluate(() => exportJSON());
    const fOff = await waitDownload(off.dl, /_Oprams_Backup_/);
    check("8. offline: export named for the client", fOff && path.basename(fOff) === fileFor(A["brand.name"]), fOff);
    check("8. offline: URL untouched", off.page.url() === url, off.page.url());
    // the favicons live in frontend/icons, so from file:// only those are expected missing
    const offErr = off.errors.filter(e => !(/ERR_FILE_NOT_FOUND/.test(e) && /\/icons\/[^/ ]+$/.test(e)));
    check("8. offline: no console errors or page errors", !offErr.length, offErr.join(" | "));
  } finally { await off.browser.close(); }
  }

  server.close();
  const failed = results.filter(r => !r.ok);
  console.log("\n" + (failed.length ? failed.length + " FAILED, " : "all ") + (results.length - failed.length) + " of " + results.length + " passed");
  console.log("run folder: " + RUN);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error(e); server.close(); process.exit(2); });
