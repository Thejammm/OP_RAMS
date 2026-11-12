// The COSHH assessment tab (12 Nov 2026): fill from a safety data sheet,
// check, edit, reload, export, start again, restore.
//
// Headless Chrome against the offline app from file://, in the user's order:
// open with no data, go to COSHH, choose an SDS, read what it filled, rate and
// edit, reload, switch tabs, export Word and PDF, New COSHH, restore a backup,
// try a scanned (no text) SDS. The SDS is made up here with jsPDF, so the test
// carries no real product's or client's document.
//
//   node tests/coshh.test.js [path to the app html]
//
// Defaults to the repo-root index.html. Needs puppeteer-core and jszip: set
// OPRAMS_TEST_MODULES to a node_modules folder that has both, and CHROME_PATH
// if Chrome is not in the usual Windows place. Needs the internet (the app's
// libraries and pdf.js load from cdnjs).
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
const run = fs.mkdtempSync(path.join(os.tmpdir(), "oprams-coshh-"));
const DL = path.join(run, "dl"); fs.mkdirSync(DL);
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail: detail || "" }); };

/* A made-up SDS in the modern 16-section layout. Section 3 carries an
   ingredient's own codes (H330, H302), which must NOT be taken as the
   product's. Every page has a running head and foot, which must not leak in. */
const SDS = [
  [["SECTION 1: Identification of the substance/mixture and of the company/undertaking"], ["1.1. Product identifier"],
   ["Product name", "Example Primer TP-100"], ["1.3. Details of the supplier of the safety data sheet"],
   ["Company name", "Example Coatings Ltd"], ["Address", "1 Test Street, Testtown"],
   ["SECTION 2: Hazards identification"], ["2.1. Classification of the substance or mixture"],
   ["Skin Irrit. 2, H315; Eye Irrit. 2, H319; Skin Sens. 1, H317"], ["2.2. Label elements"],
   ["Signal word", "Warning"], ["Hazard statements"],
   ["H315", "Causes skin irritation."], ["H319", "Causes serious eye irritation."], ["H317", "May cause an allergic skin reaction."],
   ["Precautionary statements"], ["P280", "Wear protective gloves/eye protection."], ["P302+P352", "IF ON SKIN: Wash with plenty of water."]],
  [["SECTION 3: Composition/information on ingredients"], ["Ingredient A  123-45-6  Acute Tox. 2; H330  Acute Tox. 4; H302"],
   ["SECTION 4: First aid measures"], ["4.1. Description of first aid measures"],
   ["Inhalation", "Move to fresh air."], ["Skin contact", "Wash with soap and water."], ["Eye contact", "Rinse with water for 15 minutes."],
   ["Ingestion", "Rinse mouth. Do not induce vomiting."], ["4.2. Most important symptoms and effects"], ["Symptoms", "Redness."],
   ["SECTION 5: Firefighting measures"], ["5.3. Advice for firefighters"], ["Wear self-contained breathing apparatus."],
   ["SECTION 6: Accidental release measures"], ["6.1. Personal precautions, protective equipment and emergency procedures"],
   ["Personal precautions", "Avoid contact with skin and eyes."], ["6.3. Methods and material for containment and cleaning up"],
   ["Methods for cleaning up", "Absorb with sand and place in a container."],
   ["SECTION 7: Handling and storage"], ["7.1. Precautions for safe handling"], ["Advice on safe handling", "Use in a well ventilated area."],
   ["7.2. Conditions for safe storage, including any incompatibilities"], ["Storage conditions", "Store between 5 and 25 \u00b0C. Keep container closed."]],
  [["SECTION 8: Exposure controls/personal protection"], ["8.1. Control parameters"], ["Exposure limits", "No occupational exposure limits are assigned."],
   ["8.2. Exposure controls"], ["Engineering controls", "Provide good general ventilation."],
   ["Eye/face protection", "Safety glasses with side shields (EN 166)."], ["Hand protection", "Nitrile gloves to EN ISO 374."],
   ["Respiratory protection", "Not required under normal conditions of use."],
   ["SECTION 9: Physical and chemical properties"], ["Physical state", "Liquid"], ["Flash point", "23 \u00b0C"],
   ["SECTION 13: Disposal considerations"], ["13.1. Waste treatment methods"], ["Product disposal", "Dispose of via a licensed waste contractor."],
   ["SECTION 16: Other information"], ["H330", "Fatal if inhaled."]]
];

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true, userDataDir: path.join(run, "profile"),
    args: ["--no-first-run", "--no-default-browser-check"]
  });
  const errors = [];
  let dialogs = [], answer = true;
  try {
    const bcdp = await browser.target().createCDPSession();
    await bcdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: DL });
    const page = await browser.newPage();
    page.on("pageerror", e => errors.push("pageerror: " + e.message));
    page.on("console", m => {
      if(m.type() !== "error") return;
      const at = (m.location() && m.location().url) || "";
      if(/\/icons\/[^/]+$/.test(at) && /ERR_FILE_NOT_FOUND/.test(m.text())) return;
      errors.push("console: " + m.text() + (at ? " @ " + at : ""));
    });
    page.on("dialog", d => { dialogs.push(d.message()); answer ? d.accept() : d.dismiss(); });
    await page.setViewport({ width: 1366, height: 768 });
    const url = pathToFileURL(FILE).href;
    const load = async () => {
      await page.goto(url, { waitUntil: "load", timeout: 90000 });
      await page.waitForFunction(() => window.docx && (window.jspdf || window.jsPDF) && window.html2canvas && typeof coshhInit === "function", { timeout: 60000 });
    };
    await load();
    await page.evaluate(() => localStorage.clear());
    await load();

    // ── open the tab with no data ──
    await page.click('.tab-btn[data-tab="coshh"]');
    const empty = await page.evaluate(() => ({
      shown: document.getElementById("tab-coshh").classList.contains("active"),
      rows: document.querySelectorAll("#coshhBody [data-codes] tr").length,
      substance: document.querySelector('#coshhBody [data-f="substance"]').textContent,
      workers: document.querySelector('#coshhBody [data-t="persons.workers"]').getAttribute("aria-pressed"),
      emergency: document.querySelector('#coshhBody [data-f="emergency"]').textContent
    }));
    check("first use: COSHH tab opens on an empty form", empty.shown && empty.rows === 0 && empty.substance === "", JSON.stringify(empty));
    check("first use: Workers ticked and the emergency line in place", empty.workers === "true" && /Fire Fighting Measures \(S5\)/.test(empty.emergency), JSON.stringify(empty));

    // ── choose an SDS (built here, handed to the file input as the picker would) ──
    const upload = (pages, name, textless) => page.evaluate(async (pages, name, textless) => {
      const J = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
      const doc = new J({ unit: "mm", format: "a4" });
      doc.setFontSize(9);
      pages.forEach((lines, pi) => {
        if(pi) doc.addPage();
        if(textless){ doc.setFillColor(200, 200, 200); doc.rect(20, 20, 170, 250, "F"); return; }
        doc.text("SAFETY DATA SHEET", 15, 10); doc.text("Example Primer TP-100", 15, 14); doc.text("Revision date: 01/03/2026", 140, 10);
        let y = 24;
        lines.forEach(l => { doc.text(l[0], 15, y); if(l[1]) doc.text(l[1], 85, y); y += 6; });
        doc.text("Page " + (pi + 1) + " of " + pages.length, 95, 290);
      });
      const file = new File([doc.output("arraybuffer")], name, { type: "application/pdf" });
      const dt = new DataTransfer(); dt.items.add(file);
      const inp = document.getElementById("coshhSdsFile");
      inp.files = dt.files;
      inp.dispatchEvent(new Event("change", { bubbles: true }));
    }, pages, name, !!textless);
    await upload(SDS, "example-primer-sds.pdf");
    await page.waitForFunction(() => /Filled from|no readable|could not/.test(document.getElementById("coshhStatus").textContent), { timeout: 60000 });
    const model = () => page.evaluate(() => JSON.parse(localStorage.getItem("easytravel.ramsv1.coshh.data") || "{}"));
    let m = await model();
    const status = await page.$eval("#coshhStatus", e => e.textContent);
    check("fill: status says what was read and that the ratings are the assessor's", /Filled from example-primer-sds\.pdf \(3 pages\)/.test(status) && /risk ratings are yours/.test(status), status);
    check("fill: substance, manufacturer and SDS revision", m.substance === "Example Primer TP-100" && m.manufacturer === "Example Coatings Ltd" && /revision 01\/03\/2026/.test(m.sdsRef), [m.substance, m.manufacturer, m.sdsRef].join(" | "));
    check("fill: classified hazardous, signal word Warning", m.classification === "hazardous" && m.signal === "Warning", m.classification + " / " + m.signal);
    const hc = (m.h || []).map(r => r.code).join(",");
    check("fill: the product's H statements only, not the ingredient's (S3)", hc === "H315,H319,H317", hc);
    check("fill: each H statement carries its wording", (m.h || []).every(r => /^(Causes|May cause)/.test(r.text)), JSON.stringify(m.h));
    check("fill: P statements, including a combined one", (m.p || []).map(r => r.code).join(",") === "P280,P302+P352", JSON.stringify(m.p));
    check("fill: HSE hazard group C, from H317", m.group === "C" && /H317/.test(m.groupNote), m.group + " / " + m.groupNote);
    check("fill: both risk ratings left blank", m.riskBefore === "" && m.riskAfter === "", m.riskBefore + "/" + m.riskAfter);
    check("fill: routes skin and eye, not inhalation or ingestion", m.routes.skin && m.routes.eye && !m.routes.inhalation && !m.routes.ingestion, JSON.stringify(m.routes));
    check("fill: hazard type liquid", m.types.liquid && Object.keys(m.types).length === 1, JSON.stringify(m.types));
    const ppe = m.ppe || {};
    check("fill: PPE glasses EN 166 and gloves EN ISO 374, no respirator", ppe.glasses && ppe.glasses.on && ppe.glasses.std === "EN 166" && ppe.gloves && ppe.gloves.on && ppe.gloves.std === "EN ISO 374" && !(ppe.respirator && ppe.respirator.on) && !(ppe.dustmask && ppe.dustmask.on), JSON.stringify(ppe));
    check("fill: no exposure limits -> Not specified", m.welLong === "Not specified" && m.welShort === "Not specified", m.welLong + " / " + m.welShort);
    check("fill: flash point 23 \u00b0C", m.flashPoint === "23 \u00b0C", m.flashPoint);
    check("fill: first aid from 4.1 only, by route", /Inhalation - Move to fresh air\./.test(m.firstAid) && /Ingestion - Rinse mouth/.test(m.firstAid) && !/Redness/.test(m.firstAid), m.firstAid);
    check("fill: fire fighting from 5.3", m.fireFighting === "Wear self-contained breathing apparatus.", m.fireFighting);
    check("fill: accidental release", /^Use PPE as above\.\n/.test(m.release) && /Methods for cleaning up - Absorb with sand/.test(m.release), m.release);
    check("fill: storage from 7.2", /^Storage conditions - Store between 5 and 25 \u00b0C/.test(m.storage), m.storage);
    check("fill: additional controls from 8.2 and 7.1", /Engineering controls - Provide good general ventilation\./.test(m.controls) && /Advice on safe handling - Use in a well ventilated area\./.test(m.controls), m.controls);
    check("fill: disposal", /Product disposal - Dispose of via a licensed waste contractor\./.test(m.disposal), m.disposal);
    check("fill: running heads and feet kept out of the form", !/SAFETY DATA SHEET|Page \d of/.test(JSON.stringify(m)), "");
    check("fill: nothing left to check, no boxes outlined", (m.check || []).length === 0 && (await page.$$("#coshhBody .check")).length === 0, JSON.stringify(m.check));
    const screen = await page.evaluate(() => ({
      sub: document.querySelector('#coshhBody [data-f="substance"]').textContent,
      g: (document.querySelector("#coshhBody .coshh-g.on") || { getAttribute: () => "" }).getAttribute("data-g"),
      rows: document.querySelectorAll('#coshhBody [data-codes="h"] tr').length,
      gloves: document.querySelector('#coshhBody [data-t="ppe.gloves.on"]').getAttribute("aria-pressed")
    }));
    check("fill: shown on screen as saved", screen.sub === "Example Primer TP-100" && screen.g === "C" && screen.rows === 3 && screen.gloves === "true", JSON.stringify(screen));

    // ── flash point: only the value after the label (13 Nov 2026: an R-134a
    //    SDS saying "Not applicable" came out as 5 °C, the 5 taken from
    //    "...found in Section 5.") ──
    const fp = await page.evaluate(() => {
      const one = lines => window._coshh.parse([["SECTION 9: Physical and chemical properties"].concat(lines)], "t.pdf").model.flashPoint;
      return {
        gas: one(["FLASH POINT:  Not applicable", "(Flash point method and additional flammability data are found in Section 5.)"]),
        dot: one(["FLASH POINT:  Gas, not applicable per DOT regulations", "FLASH POINT METHOD:  Not applicable"]),
        cup: one(["Flash point (closed cup)  -40 °C"]),
        bare: one(["Flash point  >100"]),
        methodOnly: one(["Flash point method  ASTM D93", "See Section 5 for details."]),
        f: one(["Flash point:  73.4 °F"])
      };
    });
    check("flash point: 'Not applicable' kept, no number taken from 'Section 5'", fp.gas === "Not applicable", JSON.stringify(fp.gas));
    check("flash point: 'Gas, not applicable' is Not applicable", fp.dot === "Not applicable", JSON.stringify(fp.dot));
    check("flash point: closed cup -40 °C", fp.cup === "-40 °C", JSON.stringify(fp.cup));
    check("flash point: a bare >100 kept as given", fp.bare === ">100", JSON.stringify(fp.bare));
    check("flash point: a method line alone gives nothing (left to check)", fp.methodOnly === "", JSON.stringify(fp.methodOnly));
    check("flash point: °F kept as °F", fp.f === "73.4 °F", JSON.stringify(fp.f));

    // ── the assessor rates and edits ──
    await page.click('#coshhBody [data-f="ref"]'); await page.keyboard.type("CO-001");
    await page.select('#coshhBody select[data-f="riskBefore"]', "medium");
    await page.select('#coshhBody select[data-f="riskAfter"]', "low");
    // straight after a fill, with no reload: the badge is what the PDF prints
    const badgesNow = await page.evaluate(() => ["riskBefore", "riskAfter"].map(f =>
      (document.querySelector('#coshhBody select[data-f="' + f + '"]').parentElement.querySelector(".badge").textContent || "").trim()).join("/"));
    check("rate: badges show the ratings at once, before any reload", /^MEDIUM\/LOW$/i.test(badgesNow), badgesNow);
    await page.click('#coshhBody [data-t="persons.contractors"]');
    await page.click('#coshhBody .coshh-add[data-add="p"]');
    await page.keyboard.type("P501");
    await page.click('#coshhBody [data-codes="p"] tr:last-child td:nth-child(2) .cz');
    await page.keyboard.type("Dispose of contents to a licensed contractor.");
    await page.click('#coshhBody [data-f="signDate"]'); await page.keyboard.type("12/11/2026");
    await page.click('#coshhBody [data-f="signBy"]'); await page.keyboard.type("Simon Archer");
    m = await model();
    check("edit: review date set a year on from the date completed", m.reviewDate === "12/11/2027", m.reviewDate);

    // ── reload: everything comes back ──
    await load();
    await page.waitForFunction(() => document.getElementById("tab-coshh").classList.contains("active"), { timeout: 10000 }).catch(() => {});
    const back = await page.evaluate(() => {
      const q = s => document.querySelector("#coshhBody " + s);
      const badge = f => (q('select[data-f="' + f + '"]').parentElement.querySelector(".badge").textContent || "").trim();
      return { tab: document.getElementById("tab-coshh").classList.contains("active"), ref: q('[data-f="ref"]').textContent,
        before: q('select[data-f="riskBefore"]').value, after: q('select[data-f="riskAfter"]').value, bBadge: badge("riskBefore"), aBadge: badge("riskAfter"),
        contractors: q('[data-t="persons.contractors"]').getAttribute("aria-pressed"),
        p: Array.from(document.querySelectorAll('#coshhBody [data-codes="p"] tr')).map(tr => tr.cells[0].textContent).join(","),
        review: q('[data-f="reviewDate"]').textContent, by: q('[data-f="signBy"]').textContent };
    });
    check("reload: still on the COSHH tab", back.tab, "");
    check("reload: ref, ratings (with their badges), tick and added P statement kept",
      back.ref === "CO-001" && back.before === "medium" && back.after === "low" && /MEDIUM/i.test(back.bBadge) && /LOW/i.test(back.aBadge) && back.contractors === "true" && back.p === "P280,P302+P352,P501" && back.review === "12/11/2027" && back.by === "Simon Archer", JSON.stringify(back));

    // ── other tabs untouched ──
    await page.evaluate(() => { activateTab("ra"); activateTab("coshh"); });
    check("switching tabs keeps the form", (await page.$eval('#coshhBody [data-f="substance"]', e => e.textContent)) === "Example Primer TP-100", "");

    // ── Word ──
    const word = await page.evaluate(async () => {
      let got = null;
      const real = window._wSave;
      window._wSave = (blob, name) => { got = { blob, name }; };
      try { await window.exportWord(); } finally { window._wSave = real; }
      if(!got) return null;
      const buf = new Uint8Array(await got.blob.arrayBuffer());
      let bin = ""; buf.forEach(b => bin += String.fromCharCode(b));
      return { name: got.name, data: btoa(bin) };
    });
    check("Word: a COSHH .docx is made", word && /-COSHH-\d{4}-\d{2}-\d{2}\.docx$/.test(word.name), word ? word.name : "nothing saved");
    if(word){
      const zip = await JSZip.loadAsync(Buffer.from(word.data, "base64"));
      const xml = await zip.file("word/document.xml").async("string");
      const text = xml.replace(/<w:tab\/>/g, " ").replace(/<\/w:p>/g, "\n").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&apos;/g, "'");
      const want = ["COSHH Risk Assessment", "Example Primer TP-100", "Example Coatings Ltd", "H317", "May cause an allergic skin reaction.", "P501", "Group C", "MEDIUM", "LOW", "EN 166", "EN ISO 374", "23 \u00b0C", "12/11/2027", "Simon Archer", "Absorb with sand"];
      const missing = want.filter(w => !text.includes(w));
      check("Word: carries the assessment", missing.length === 0, "missing: " + missing.join(", "));
      check("Word: landscape", /w:orient="landscape"/.test(xml), "");
    }

    // ── PDF (read back from the download: page count and page size) ──
    await page.evaluate(() => window.exportPDF());
    let pdfFile = null;
    for(let i = 0; i < 60 && !pdfFile; i++){
      pdfFile = fs.readdirSync(DL).find(f => /-COSHH-\d{4}-\d{2}-\d{2}\.pdf$/.test(f));
      if(!pdfFile) await new Promise(r => setTimeout(r, 500));
    }
    if(pdfFile){
      await new Promise(r => setTimeout(r, 500));
      const raw = fs.readFileSync(path.join(DL, pdfFile)).toString("latin1");
      const pages = (raw.match(/\/Type\s*\/Page\b(?!s)/g) || []).length;
      const box = raw.match(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/);
      check("PDF: a landscape COSHH PDF is saved", pages >= 1 && box && Number(box[1]) > Number(box[2]), pdfFile + " pages " + pages + " box " + (box ? box[1] + "x" + box[2] : "?"));
    } else check("PDF: a landscape COSHH PDF is saved", false, "no COSHH pdf in " + fs.readdirSync(DL).join(", "));

    // ── backup, New COSHH, restore ──
    const backup = await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith("easytravel.ramsv1.") || k.startsWith("brand.")).map(k => [k, localStorage.getItem(k)]));
    check("backup: the COSHH record is among the saved keys", backup.some(([k]) => k === "easytravel.ramsv1.coshh.data"), "");
    dialogs = []; answer = true;
    await page.click("#coshhNewBtn");
    const cleared = await page.evaluate(() => ({ s: document.querySelector('#coshhBody [data-f="substance"]').textContent, rows: document.querySelectorAll("#coshhBody [data-codes] tr").length, ref: document.querySelector('#coshhBody [data-f="ref"]').textContent }));
    check("New COSHH: asks first, then clears the form", dialogs.length === 1 && cleared.s === "" && cleared.rows === 0 && cleared.ref === "", JSON.stringify({ dialogs, cleared }));
    await page.evaluate(entries => replaceSavedWork(entries), backup);
    await load();
    const restored = await page.evaluate(() => ({ s: document.querySelector('#coshhBody [data-f="substance"]').textContent, ref: document.querySelector('#coshhBody [data-f="ref"]').textContent }));
    check("restore: the backup brings the COSHH assessment back", restored.s === "Example Primer TP-100" && restored.ref === "CO-001", JSON.stringify(restored));

    // ── a second SDS over a filled form asks first; saying no keeps the form ──
    dialogs = []; answer = false;
    await upload(SDS, "another-sds.pdf");
    await page.waitForFunction(() => /Filled from|no readable|^$/.test(document.getElementById("coshhStatus").textContent), { timeout: 60000 });
    await new Promise(r => setTimeout(r, 300));
    const kept = await page.$eval('#coshhBody [data-f="ref"]', e => e.textContent);
    check("second SDS: asks before replacing, and No keeps the form", dialogs.length === 1 && /Replace the COSHH assessment/.test(dialogs[0]) && kept === "CO-001", JSON.stringify(dialogs) + " ref " + kept);
    answer = true;

    // ── a scanned SDS (no text) changes nothing and says why ──
    await upload([[], []], "scanned.pdf", true);
    await page.waitForFunction(() => /no readable text/.test(document.getElementById("coshhStatus").textContent), { timeout: 60000 });
    check("scanned SDS: says there is no readable text, form unchanged", (await page.$eval('#coshhBody [data-f="ref"]', e => e.textContent)) === "CO-001", "");

    // ── the RA still exports (shared Word code was touched) ──
    const ra = await page.evaluate(async () => {
      activateTab("ra");
      let got = null; const real = window._wSave;
      window._wSave = (blob, name) => { got = name; };
      try { await window.exportWord(); } finally { window._wSave = real; }
      return got;
    });
    check("RA Word export unaffected", ra && /-RA-\d{4}-\d{2}-\d{2}\.docx$/.test(ra), String(ra));

    check("no page errors", errors.length === 0, errors.join(" || ").slice(0, 400));
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
