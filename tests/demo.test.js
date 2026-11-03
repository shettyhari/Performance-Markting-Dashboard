// Tests for the interactive demo mode (demo-data.js & engine integration)
const assert = require("assert");
const fs = require("fs");
const path = require("path");

require("../demo-data.js");
const dataModule = global.QLARITY_DEMO;

assert.ok(dataModule, "QLARITY_DEMO is exported");
assert.strictEqual(typeof dataModule.getDemoData, "function", "getDemoData is a function");

const data = dataModule.getDemoData();
assert.ok(Array.isArray(data.meta), "meta is an array");
assert.ok(data.meta.length > 50, "meta has 50+ rows");
assert.ok(Array.isArray(data.crm), "crm is an array");
assert.ok(data.crm.length > 100, "crm has 100+ leads");
assert.ok(data.settings, "settings object exists");
assert.deepStrictEqual(data.settings.brands, ["Apex Living", "Lumina Skin"], "brands match Apex and Lumina");
assert.deepStrictEqual(data.settings.wonStatuses, ["Booked / Won", "Payment Received"], "won statuses set");
assert.strictEqual(data.settings.dealValue["Apex Living"], 1500000, "Apex deal value 15L");
assert.strictEqual(data.settings.dealValue["Lumina Skin"], 25000, "Lumina deal value 25K");

// Verify attribution mock
assert.ok(Array.isArray(data.attribution), "attribution rows array exists");
assert.ok(data.attribution.some((r) => r.aiSearch), "contains AI search attribution row");

// Verify AI answers
assert.ok(data.aiAnswers.default, "default AI answer present");
assert.ok(data.aiAnswers.cpl, "CPL AI answer present");
assert.ok(data.aiAnswers.tat, "TAT AI answer present");

console.log("✓ demo mode dataset: valid Meta rows, CRM leads, settings, attribution and AI answers");

// UI integration test for Demo Mode via JSDOM
(async () => {
  const { JSDOM } = require("jsdom");
  let html = fs.readFileSync(path.join(__dirname, "../app.html"), "utf8");
  const demoCode = fs.readFileSync(path.join(__dirname, "../demo-data.js"), "utf8");
  const attrCode = fs.readFileSync(path.join(__dirname, "../attribution.js"), "utf8");
  const pmCode = fs.readFileSync(path.join(__dirname, "../performance.js"), "utf8");

  // Inline scripts for jsdom
  html = html.replace(/<script src="https:\/\/cdnjs[^"]*"><\/script>/, "")
             .replace('<script src="demo-data.js"></script>', "<script>" + demoCode.split("</script>").join("<\\/script>") + "</script>")
             .replace('<script src="attribution.js"></script>', "<script>" + attrCode.split("</script>").join("<\\/script>") + "</script>")
             .replace('<script src="performance.js"></script>', "<script>" + pmCode.split("</script>").join("<\\/script>") + "</script>");

  const errors = [];
  const dom = new JSDOM(html, {
    url: "https://app.example.test/?demo=1",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(w) {
      w.XLSX = {};
      w.scrollTo = () => {};
      w.matchMedia = () => ({ matches: false, addListener() {}, addEventListener() {} });
      w.addEventListener("error", (e) => errors.push(e.message));
      w.console.error = (...a) => errors.push(a.map(String).join(" "));
    }
  });

  // Wait for boot() and render()
  await new Promise((r) => setTimeout(r, 200));

  const doc = dom.window.document;
  const banner = doc.getElementById("demo-banner");
  assert.ok(banner && !banner.hidden, "demo banner is visible");
  assert.ok(/Interactive Demo Mode/i.test(banner.textContent), "banner text mentions Interactive Demo Mode");

  const viewText = doc.getElementById("view").textContent;
  assert.ok(/Apex Living|Lumina Skin/.test(viewText), "overview displays demo brands");
  assert.ok(/Conversion Funnel/.test(viewText), "overview renders Conversion Funnel");
  assert.ok(/Sales & Revenue/.test(viewText), "overview renders Sales & Revenue KPI group");

  // Verify funnel elements
  const funnel = doc.querySelector(".funnel-card");
  assert.ok(funnel, "funnel card exists in DOM");
  assert.ok(funnel.querySelectorAll(".funnel-step").length === 6, "funnel has 6 pipeline steps");

  assert.strictEqual(errors.length, 0, "no errors during demo mode boot: " + errors.join("; "));
  console.log("✓ demo mode UI: loads automatically with ?demo=1, displays banner, sales KPIs & conversion funnel");
})().catch((e) => {
  console.error("Demo UI test failed:", e);
  process.exit(1);
});
