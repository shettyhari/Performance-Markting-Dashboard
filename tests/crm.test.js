// CRM integration tests: direct CRM sync, lead ingestion, auto-sync schedules, and endpoints.
process.env.API_URL = "https://db.test";
process.env.JWT_SECRET = "test-secret-" + "x".repeat(40);
const test = require("node:test");
const assert = require("node:assert");
const DB = require("../api/_db");
const CRMLib = require("../api/_crmlib");

const ORG = { id: "00000000-0000-4000-8000-0000000000aa", public_id: "abcdef012345abcdef", name: "Test Co", crm_name: "TeleCRM", currency: "INR", tz_offset_min: 330, active: true };

test("CRM library: flat() parses flat, TeleCRM API, and HubSpot formats", () => {
  // Flat lead
  const flatLead = { "Lead id": "L101", "Phone": "9876543210", "Email": "user@example.com", "Status": "Interested", "Created On": "2026-10-15 14:30:00" };
  const res1 = CRMLib.flat(flatLead);
  assert.strictEqual(res1.leadid[1], "L101");
  assert.strictEqual(res1.phone[1], "9876543210");
  assert.strictEqual(res1.status[1], "Interested");

  // TeleCRM format
  const teleLead = { id: "T202", fields: { "Phone": "+919876543210", "Email": "tele@example.com", "Facebook Campaign Name": "Summer Sale" }, status: "Hot Lead" };
  const res2 = CRMLib.flat(teleLead);
  assert.strictEqual(res2.id[1], "T202");
  assert.strictEqual(res2.phone[1], "+919876543210");
  assert.strictEqual(res2.facebookcampaignname[1], "Summer Sale");

  // HubSpot format
  const hsContact = { id: "HS303", properties: { phone: "9876500000", email: "hs@example.com", hs_lead_status: "CONNECTED", utm_campaign: "Search_Brand" } };
  const res3 = CRMLib.flat(hsContact);
  assert.strictEqual(res3.id[1], "HS303");
  assert.strictEqual(res3.phone[1], "9876500000");
  assert.strictEqual(res3.hsleadstatus[1], "CONNECTED");
});

test("CRM library: classify() respects qualified intent rules", () => {
  const S = { qlPos: ["interested", "site visit", "booked"], qlNeg: ["junk", "lost", "not interested"], qlOverride: { "vip client": "QL" } };
  assert.strictEqual(CRMLib.classify("Site visit scheduled", S), true);
  assert.strictEqual(CRMLib.classify("Not interested - too expensive", S), false);
  assert.strictEqual(CRMLib.classify("New lead", S), false);
  assert.strictEqual(CRMLib.classify("VIP Client", S), true);
});

test("CRM library: isDueToSync() evaluates frequency, working hours and daily hour", async () => {
  await DB.withOrg(ORG, async () => {
    // 1. 24/7 every 30 minutes (always due during periodic runs)
    const s1 = { crmSyncFrequency: "30", crmSyncHours: "all" };
    const r1 = await CRMLib.isDueToSync(s1, "crm");
    assert.strictEqual(r1.due, true);

    // 2. Daily schedule at hour 23 (assuming not currently 23:00)
    const s2 = { crmSyncFrequency: "daily", crmSyncHours: "all", crmSyncHour: "23:00" };
    const r2 = await CRMLib.isDueToSync(s2, "crm");
    const curHour = new Date(Date.now() + DB.tzMs()).getUTCHours();
    if (curHour !== 23) {
      assert.strictEqual(r2.due, false);
      assert.ok(/Daily sync/.test(r2.reason));
    }
  });
});

test("CRM library: ingestLeads() stores leads and updates upload record", async () => {
  const fakeStore = { leads: [], uploads: [] };
  const origFetch = global.fetch;
  const jsonResp = (b) => ({
    ok: true,
    status: 200,
    headers: { get: () => "0-0/1" },
    text: async () => JSON.stringify(b),
    json: async () => b
  });

  global.fetch = async (url, opts) => {
    const s = String(url);
    if (s.indexOf("/rest/v1/crm_leads?select=") >= 0) {
      return jsonResp([]);
    }
    if (s.indexOf("/rest/v1/meta_ad_rows") >= 0) {
      return jsonResp([]);
    }
    if (s.indexOf("/rest/v1/uploads?select=") >= 0) {
      return jsonResp([]);
    }
    if (s.indexOf("/rest/v1/uploads") >= 0 && opts && opts.method === "POST") {
      fakeStore.uploads.push(JSON.parse(opts.body));
      return jsonResp([{ id: 99 }]);
    }
    if (s.indexOf("/rest/v1/rpc/lead_keys") >= 0) {
      return jsonResp(["h_phone", "h_email"]);
    }
    if (s.indexOf("/rest/v1/crm_leads") >= 0 && opts && opts.method === "POST") {
      const rows = JSON.parse(opts.body);
      fakeStore.leads.push(...rows);
      return jsonResp(rows);
    }
    if (s.indexOf("/rest/v1/rpc/refresh_lead_dupes") >= 0) {
      return jsonResp(0);
    }
    if (s.indexOf("/rest/v1/crm_leads?select=lead_id") >= 0) {
      return { ok: true, status: 200, headers: { get: () => String(fakeStore.leads.length) }, text: async () => JSON.stringify(fakeStore.leads), json: async () => fakeStore.leads };
    }
    if (s.indexOf("/rest/v1/uploads?id=") >= 0 && opts && opts.method === "PATCH") {
      return jsonResp({});
    }
    return jsonResp([]);
  };

  try {
    await DB.withOrg(ORG, async () => {
      const S = { brands: ["Alpha", "Beta"], keywords: [["summer", "Alpha"]], qlPos: ["interested"] };
      const rawLeads = [
        { "Lead id": "L_TEST_1", "Phone": "9876543210", "Email": "a@example.com", "Status": "Interested", "Facebook Campaign Name": "Summer Promo", "Created On": "2026-10-20 10:00:00" },
        { "Lead id": "L_TEST_2", "Phone": "9876543211", "Email": "b@example.com", "Status": "New", "Facebook Campaign Name": "Winter Promo", "Created On": "2026-10-20 11:00:00" }
      ];
      const result = await CRMLib.ingestLeads(rawLeads, S, { sourceFile: "CRM API · auto-sync" });
      assert.strictEqual(result.received, 2);
      assert.strictEqual(result.saved, 2);
      assert.strictEqual(result.new_leads, 2);
      assert.strictEqual(fakeStore.leads.length, 2);
      assert.strictEqual(fakeStore.leads[0].lead_id, "L_TEST_1");
      assert.strictEqual(fakeStore.leads[0].brand, "Alpha");
      assert.strictEqual(fakeStore.leads[0].is_ql, true);
      assert.strictEqual(fakeStore.leads[1].is_ql, false);
    });
  } finally {
    global.fetch = origFetch;
  }
});

test("API: /api/crm?op=status returns CRM status and schedule settings", async () => {
  const handler = require("../api/crm");
  const origFetch = global.fetch;
  const jsonResp = (b) => ({ ok: true, status: 200, headers: { get: () => "0-0/1" }, text: async () => JSON.stringify(b), json: async () => b });

  global.fetch = async (url) => {
    const s = String(url);
    if (s.indexOf("/rest/v1/rpc/get_org_secret") >= 0) return jsonResp("KEY-XYZ-1234");
    if (s.indexOf("/rest/v1/org_settings") >= 0) return jsonResp([{ settings: { crmProvider: "TeleCRM", crmSyncFrequency: "15", crmSyncHours: "working" } }]);
    return jsonResp([]);
  };

  try {
    const out = {};
    const req = {
      method: "GET",
      query: { op: "status" },
      headers: { authorization: "Bearer token-owner" }
    };
    const res = {
      statusCode: 0,
      setHeader() {},
      end(b) { out.status = this.statusCode; out.body = JSON.parse(b); }
    };

    await DB.withOrg(ORG, async () => {
      // Stub auth
      const origAuth = DB.auth;
      DB.auth = async () => ({ org: ORG, role: "admin", email: "admin@test.com" });
      try {
        await handler(req, res);
      } finally {
        DB.auth = origAuth;
      }
    });

    assert.strictEqual(out.status, 200);
    assert.strictEqual(out.body.configured, true);
    assert.strictEqual(out.body.last4, "1234");
    assert.strictEqual(out.body.provider, "TeleCRM");
    assert.strictEqual(out.body.frequency, "15");
    assert.strictEqual(out.body.syncHours, "working");
  } finally {
    global.fetch = origFetch;
  }
});
