// The "Actions arising from RA-xx" pointer line on the risk assessment.
// It must name the assessment's reference as it stands: straight after a
// snippet is inserted, after the reference is typed or changed, and in the
// Word, PDF and Actions sheet exports, with no reload in between.
//
// Headless Chrome against the offline app from file://, in the user's order:
// open with no data, insert a snippet, insert another, type a reference,
// reload, then export.
//
//   node tests/pointer-line.test.js [path to the app html]
//
// Defaults to the repo-root index.html (the offline app, the served file
// minus its three cloud-save script tags). Needs puppeteer-core and jszip:
// set OPRAMS_TEST_MODULES to a node_modules folder that has both, and
// CHROME_PATH if Chrome is not in the usual Windows place.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

const MODS = process.env.OPRAMS_TEST_MODULES || "";
const need = m => require(MODS ? path.join(MODS, m) : m);
const puppeteer = need("puppeteer-core");
const JSZip = need("jszip");

const FILE = process.argv[2] || path.join(__dirname, "..", "index.html");
const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const run = fs.mkdtempSync(path.join(os.tmpdir(), "oprams-pointer-"));
const DL = path.join(run, "dl"); fs.mkdirSync(DL);
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail: detail || "" }); };

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true, userDataDir: path.join(run, "profile"),
    args: ["--no-first-run", "--no-default-browser-check"]
  });
  const errors = [];
  try {
    const bcdp = await browser.target().createCDPSession();
    await bcdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: DL });
    const page = await browser.newPage();
    page.on("pageerror", e => errors.push("pageerror: " + e.message));
    // The favicons live in frontend/icons, not beside the offline app, so
    // from file:// those (and only those) are expected to be missing.
    page.on("console", m => {
      if(m.type() !== "error") return;
      const at = (m.location() && m.location().url) || "";
      if(/\/icons\/[^/]+$/.test(at) && /ERR_FILE_NOT_FOUND/.test(m.text())) return;
      errors.push("console: " + m.text() + (at ? " @ " + at : ""));
    });
    page.on("dialog", d => d.dismiss());
    await page.setViewport({ width: 1366, height: 768 });

    const url = pathToFileURL(FILE).href;
    const load = async () => {
      await page.goto(url, { waitUntil: "load", timeout: 90000 });
      await page.waitForFunction(() => window.docx && (window.jspdf || window.jsPDF) && window.html2canvas, { timeout: 60000 });
    };
    await load();

    const state = () => page.evaluate(() => {
      const ptr = document.querySelector("#raForms .form-page [data-arr] .arr-pointer");
      const ref = document.querySelector('#raForms [data-key="ra.meta.reference"]');
      const badge = document.querySelector("#actionsCount");
      const meta = document.querySelector("#actionsBody .act-meta");
      return {
        pointer: ptr ? ptr.textContent.replace(/\s+/g, " ").trim() : "(no pointer)",
        ref: ref ? ref.textContent.trim() : "(no field)",
        badge: badge ? badge.textContent.trim() : "(no badge)",
        actionsMeta: meta ? meta.textContent.replace(/\s+/g, " ").trim() : "(no meta)",
        todo: _raAllTodo().length
      };
    });

    // Two "RA — XX — Name" snippets that carry still-to-arrange notes, so a pointer is drawn.
    const picks = await page.evaluate(() => SNIPPETS_RA.map((s, i) => ({
      i, m: (s.name || "").match(/^RA\s*[\-\u2013\u2014]\s*([\w]+)\s*[\-\u2013\u2014]\s*(.*)$/i),
      todo: (s.rows || []).reduce((n, r) => n + (r.notes || []).filter(x => x.status === "todo").length, 0)
    })).filter(x => x.m && x.todo > 0).map(x => ({ i: x.i, ref: "RA-" + x.m[1] })));
    if(picks.length < 2) throw new Error("need two RA snippets with still-to-arrange notes");
    const A = picks[0], B = picks[1];

    const insert = idx => page.evaluate(i => {
      const page1 = document.querySelector("#raForms .form-page");
      const sel = page1.querySelector(".ra-snip-select");
      sel.value = String(i);
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      page1.querySelector(".snip-insert-ra").click();
    }, idx);

    // ── insert on an empty reference, no reload ──
    const s0 = await state();
    check("start: reference empty", /^(Add Text)?$/.test(s0.ref), s0.ref);
    await insert(A.i);
    let s = await state();
    check("insert: reference set to " + A.ref, s.ref === A.ref, s.ref);
    check("insert: pointer names " + A.ref, s.pointer.includes("Actions arising from " + A.ref), s.pointer);
    check("insert: pointer never says no reference set", !s.pointer.includes("no reference set"), s.pointer);
    check("insert: Actions count = " + s.todo, s.badge === String(s.todo), "badge " + s.badge + ", todo " + s.todo);
    check("insert: Actions tab names " + A.ref, s.actionsMeta.includes(A.ref), s.actionsMeta);

    // ── a second snippet straight after ──
    await insert(B.i);
    s = await state();
    check("second insert: pointer names " + B.ref, s.pointer.includes("Actions arising from " + B.ref), s.pointer);
    check("second insert: Actions tab names " + B.ref, s.actionsMeta.includes(B.ref), s.actionsMeta);

    // ── type a new reference by hand ──
    await page.evaluate(() => {
      const el = document.querySelector('#raForms [data-key="ra.meta.reference"]');
      el.focus();
      const r = document.createRange(); r.selectNodeContents(el);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    });
    await page.keyboard.type("RA-77");
    s = await state();
    check("typed: reference reads RA-77", s.ref === "RA-77", s.ref);
    check("typed: pointer follows to RA-77", s.pointer.includes("Actions arising from RA-77"), s.pointer);
    check("typed: Actions tab follows to RA-77", s.actionsMeta.includes("RA-77"), s.actionsMeta);
    await page.keyboard.press("Backspace"); await page.keyboard.type("8");
    s = await state();
    check("one character changed: pointer follows to RA-78", s.pointer.includes("Actions arising from RA-78"), s.pointer);

    // ── reload: what was typed is kept and drawn the same ──
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await new Promise(r => setTimeout(r, 300));
    await load();
    s = await state();
    check("reload: pointer still names RA-78", s.pointer.includes("Actions arising from RA-78"), s.pointer);

    // The exports must redraw for themselves: change the reference without
    // any event, so only the export's own redraw can put it right.
    const silent = ref => page.evaluate(v => {
      document.querySelector('#raForms [data-key="ra.meta.reference"]').textContent = v;
    }, ref);

    // ── Word ──
    await silent("RA-88");
    const b64 = await page.evaluate(async () => {
      let got = null;
      const real = window._wSave;
      window._wSave = (blob, name) => { got = { blob, name }; };
      try { await window.exportWord(); } finally { window._wSave = real; }
      if(!got) return null;
      const buf = new Uint8Array(await got.blob.arrayBuffer());
      let bin = ""; for(let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      return { name: got.name, data: btoa(bin) };
    });
    check("Word: export produced a .docx", b64 && /\.docx$/.test(b64.name), b64 ? b64.name : "nothing saved");
    if(b64){
      const zip = await JSZip.loadAsync(Buffer.from(b64.data, "base64"));
      const xml = await zip.file("word/document.xml").async("string");
      const text = xml.replace(/<w:tab\/>/g, "\t").replace(/<\/w:p>/g, "\n").replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
      const line = (text.split("\n").find(l => /arising from this assessment/i.test(l)) || "(no pointer line)").trim();
      check("Word: text contains Actions arising from RA-88", text.includes("Actions arising from RA-88"), line);
      check("Word: no stale RA-78 and no 'no reference set'", !/Actions arising from RA-78|no reference set/.test(text), line);
    }

    // ── PDF: the pointer as html2canvas captures it ──
    await silent("RA-89");
    await page.evaluate(() => {
      window.__ptrAtCapture = [];
      const real = window.html2canvas;
      window.html2canvas = function(node){
        const p = node && node.querySelector && node.querySelector(".arr-pointer");
        if(p) window.__ptrAtCapture.push(p.textContent.replace(/\s+/g, " ").trim());
        return real.apply(this, arguments);
      };
    });
    await page.evaluate(() => window.exportPDF());
    const caps = await page.evaluate(() => window.__ptrAtCapture);
    check("PDF: pointer captured into the PDF names RA-89", caps.length && caps.every(t => t.includes("Actions arising from RA-89")), caps.join(" | ").slice(0, 160) || "(no pointer captured)");

    // ── Actions sheet ──
    await silent("RA-90");
    await page.evaluate(() => { activateTab("actions"); raActionsSheet(); activateTab("ra"); });
    s = await state();
    check("Actions sheet: page pointer redrawn to RA-90", s.pointer.includes("Actions arising from RA-90"), s.pointer);

    await new Promise(r => setTimeout(r, 2500));
    const files = fs.readdirSync(DL);
    check("PDF and Actions sheet both saved", files.filter(f => /\.pdf$/i.test(f)).length >= 2, files.join(", "));
    check("no page errors", errors.length === 0, errors.join(" || ").slice(0, 300));
  } catch(e){
    check("test ran to the end", false, e.stack || String(e));
  } finally {
    await browser.close();
  }
  results.forEach(r => console.log((r.ok ? "PASS " : "FAIL ") + r.name + (r.ok ? "" : "\n       -> " + r.detail)));
  const bad = results.filter(r => !r.ok).length;
  console.log(bad ? bad + " of " + results.length + " failed" : "all " + results.length + " passed");
  console.log("run folder:", run);
  process.exitCode = bad ? 1 : 0;
})();
