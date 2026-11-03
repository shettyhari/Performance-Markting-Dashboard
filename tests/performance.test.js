// Performance Marketing Suite Tests
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

// 1. Direct unit verification of performance module
const pmCode = fs.readFileSync(path.join(__dirname, "../performance.js"), "utf8");
const dummyGlobal = {
  state: {
    tab: "overview",
    brand: "All",
    settings: { monthlyBudgets: {} },
    R: {
      currency: "₹",
      ads: [
        {
          ad: "Villa Walkthrough Video 4K",
          campaign: "Apex Living | Luxury Villas",
          adset: "South Delhi HNI 35-55",
          brand: "Apex Living",
          spend: 12000,
          imp: 18500,
          clk: 320,
          ctr: 0.017,
          cpc: 37.5,
          crm: 14,
          ql: 8,
          qlRate: 0.57,
          cpql: 1500,
          won: 3,
          val: 4500000,
          roas: 375
        },
        {
          ad: "Bleeder Ad Test",
          campaign: "Apex Living | Luxury Villas",
          adset: "Broad Audience",
          brand: "Apex Living",
          spend: 5200,
          imp: 6000,
          clk: 45,
          ctr: 0.007,
          cpc: 115.5,
          crm: 2,
          ql: 0,
          qlRate: 0,
          cpql: null,
          won: 0,
          val: 0,
          roas: 0
        }
      ],
      camps: [
        {
          campaign: "Apex Living | Luxury Villas",
          brand: "Apex Living",
          spend: 17200,
          ui: 16,
          crm: 16,
          ql: 8,
          cpql: 2150,
          won: 3,
          val: 4500000
        }
      ],
      leadRows: [
        {
          id: "L-101",
          brand: "Apex Living",
          campaign: "Apex Living | Luxury Villas",
          created: Date.now() - 10 * 86400000,
          isQL: true,
          isWon: true
        },
        {
          id: "L-102",
          brand: "Apex Living",
          campaign: "Apex Living | Luxury Villas",
          created: Date.now() - 5 * 86400000,
          isQL: true,
          isWon: false
        }
      ]
    }
  },
  EXTRA_VIEWS: {},
  PAGE_INFO: {},
  brandOK: function(b) { return true; },
  isNum: function(v) { return typeof v === "number" && !isNaN(v); },
  fInt: function(v) { return String(v); },
  fINR: function(v) { return "₹" + v; },
  fPct: function(v) { return (v * 100).toFixed(1) + "%"; },
  fMin: function(v) { return v + "m"; },
  toast: function(m) {},
  storeSettings: function() {},
  render: function() {}
};

// Fake document el helper
dummyGlobal.el = function(tag, attrs) {
  const elem = {
    tag: tag,
    attrs: attrs || {},
    children: [],
    style: {},
    appendChild: function(c) {
      if (c) elem.children.push(c);
      return c;
    }
  };
  for (let i = 2; i < arguments.length; i++) {
    const c = arguments[i];
    if (c) {
      if (Array.isArray(c)) c.forEach(x => x && elem.children.push(x));
      else elem.children.push(c);
    }
  }
  return elem;
};

// Execute module in dummy scope
Function("window", "global", "state", "EXTRA_VIEWS", "PAGE_INFO", "brandOK", "isNum", "fInt", "fINR", "fPct", "fMin", "toast", "storeSettings", "render", "el", pmCode)(
  dummyGlobal, dummyGlobal, dummyGlobal.state, dummyGlobal.EXTRA_VIEWS, dummyGlobal.PAGE_INFO, dummyGlobal.brandOK, dummyGlobal.isNum, dummyGlobal.fInt, dummyGlobal.fINR, dummyGlobal.fPct, dummyGlobal.fMin, dummyGlobal.toast, dummyGlobal.storeSettings, dummyGlobal.render, dummyGlobal.el
);

assert.strictEqual(typeof dummyGlobal.EXTRA_VIEWS.creatives, "function", "creatives view registered");
assert.strictEqual(typeof dummyGlobal.EXTRA_VIEWS.pacing, "function", "pacing view registered");
assert.strictEqual(typeof dummyGlobal.EXTRA_VIEWS.lag, "function", "lag view registered");
assert.strictEqual(typeof dummyGlobal.EXTRA_VIEWS.guardrails, "function", "guardrails view registered");
assert.strictEqual(typeof dummyGlobal.EXTRA_VIEWS.utm, "function", "utm view registered");

// Verify view renderers run and construct trees
const v1 = dummyGlobal.EXTRA_VIEWS.creatives();
assert.ok(v1 && v1.tag === "section", "viewCreatives returns section element");

const v2 = dummyGlobal.EXTRA_VIEWS.pacing();
assert.ok(v2 && v2.tag === "section", "viewPacing returns section element");

const v3 = dummyGlobal.EXTRA_VIEWS.lag();
assert.ok(v3 && v3.tag === "section", "viewLag returns section element");

const v4 = dummyGlobal.EXTRA_VIEWS.guardrails();
assert.ok(v4 && v4.tag === "section", "viewGuardrails returns section element");

const v5 = dummyGlobal.EXTRA_VIEWS.utm();
assert.ok(v5 && v5.tag === "section", "viewUTM returns section element");

console.log("✓ performance.js direct unit verification passed (5 views rendered)");

// 2. Full JSDOM integration test with demo mode
(async () => {
  let html = fs.readFileSync(path.join(__dirname, "../app.html"), "utf8");
  const demoCode = fs.readFileSync(path.join(__dirname, "../demo-data.js"), "utf8");
  const attrCode = fs.readFileSync(path.join(__dirname, "../attribution.js"), "utf8");
  const pmCode = fs.readFileSync(path.join(__dirname, "../performance.js"), "utf8");

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

  await new Promise((r) => setTimeout(r, 400));
  const w = dom.window;

  assert.strictEqual(errors.length, 0, "No script errors during boot: " + errors.join(", "));

  // Check that all 5 Performance Marketing tabs exist in side-nav
  const tabs = ["creatives", "pacing", "lag", "guardrails", "utm"];
  tabs.forEach((tab) => {
    const btn = w.document.querySelector(`.tab[data-tab="${tab}"]`);
    assert.ok(btn, `Tab button for ${tab} exists in side-nav`);
  });

  // Switch to Creative Fatigue
  w.eval("state.tab = 'creatives'; render();");
  assert.ok(/Creative Intelligence/.test(w.document.body.innerHTML), "Creatives view rendered in JSDOM");

  // Switch to Budget Pacing
  w.eval("state.tab = 'pacing'; render();");
  assert.ok(/Budget Pacing/.test(w.document.body.innerHTML), "Pacing view rendered in JSDOM");
  assert.ok(/What-If/.test(w.document.body.innerHTML), "Scale simulator rendered in JSDOM");

  // Switch to Conversion Lag
  w.eval("state.tab = 'lag'; render();");
  assert.ok(/Conversion Lag/.test(w.document.body.innerHTML), "Conversion Lag view rendered in JSDOM");
  assert.ok(/Premature Kill/.test(w.document.body.innerHTML), "Premature Kill alert rendered");

  // Switch to Guardrails Radar
  w.eval("state.tab = 'guardrails'; render();");
  assert.ok(/Guardrails/.test(w.document.body.innerHTML), "Guardrails view rendered in JSDOM");
  assert.ok(/Action Plan/.test(w.document.body.innerHTML), "Action checklist rendered in JSDOM");

  // Switch to Dynamic UTMs
  w.eval("state.tab = 'utm'; render();");
  assert.ok(/Dynamic UTM/.test(w.document.body.innerHTML), "UTM Builder view rendered in JSDOM");
  assert.ok(/utm_source=/.test(w.document.body.innerHTML), "Tracking URL generated in JSDOM");

  // Switch back to Overview and verify Performance Marketing Hub quick strip
  w.eval("state.tab = 'overview'; render();");
  assert.ok(/Performance Marketing Hub/.test(w.document.body.innerHTML), "Performance Hub strip rendered on Overview");

  assert.strictEqual(errors.length, 0, "No errors encountered during tab navigation: " + errors.join(", "));
  console.log("✓ JSDOM integration: all 5 Performance Marketing views switch & render flawlessly");
})();

