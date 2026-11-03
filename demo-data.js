/* Qlarity Interactive Demo Data Generator (ES5)
   Provides fresh, relative-to-today realistic sample data for demo mode.
   Brands: Apex Living (High-value Real Estate & Architecture)
           Lumina Skin (Aesthetics, Dermatology & Laser Clinics)
*/
(function(root){
  function pad2(n){ return (n < 10 ? "0" : "") + n; }
  function isoDate(d){ return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }
  function isoDateTime(d, hh, mm, ss){ return isoDate(d) + " " + pad2(hh) + ":" + pad2(mm) + ":" + pad2(ss); }

  function getDemoData(){
    var now = new Date();
    var metaHeader = [
      "Campaign name", "Ad set name", "Ad name", "Amount spent",
      "Results", "Link clicks", "Impressions", "Reporting starts", "Reporting ends", "Result indicator"
    ];
    var crmHeader = [
      "Lead id", "Created On", "Lead Source", "Facebook Campaign Name", "Facebook Ad Set Name",
      "Facebook Ad", "Status", "Brand", "First Attempted Call", "Assignee name", "Assignee Manager name",
      "Phone", "Email", "Facebook Lead ID"
    ];

    var metaRows = [metaHeader];
    var crmRows = [crmHeader];

    var apexCamps = [
      {
        name: "Apex Living | Luxury Villas",
        sets: [
          {name: "South Delhi HNI 35-55", ad: "Villa Walkthrough Video 4K"},
          {name: "Golf Course Ext Lookalike 2%", ad: "Floorplan & Pricing Carousel"}
        ],
        dailySpend: 4200, dailyImp: 6500, dailyClk: 110, dailyLeads: 4, ind: "actions:lead"
      },
      {
        name: "Apex Living | Penthouse Inquiries",
        sets: [
          {name: "High Net Worth Founders & CXOs", ad: "Sky Villa Panoramic View"},
          {name: "Luxury Real Estate Affinity", ad: "Private Elevator Feature Ad"}
        ],
        dailySpend: 3100, dailyImp: 4800, dailyClk: 85, dailyLeads: 3, ind: "messages"
      },
      {
        name: "Apex Living | Retargeting Site Visitors",
        sets: [
          {name: "Website Visitors 30 Days", ad: "Limited 4 Units Left Offer"}
        ],
        dailySpend: 1500, dailyImp: 2400, dailyClk: 55, dailyLeads: 2, ind: "actions:lead"
      }
    ];

    var luminaCamps = [
      {
        name: "Lumina Skin | HydraFacial Promo",
        sets: [
          {name: "Women 22-45 Urban Core", ad: "Before-After HydraFacial Reel"},
          {name: "Bridal Skincare Lookalike", ad: "Instant Glow 1999 Package"}
        ],
        dailySpend: 2200, dailyImp: 8200, dailyClk: 165, dailyLeads: 7, ind: "actions:lead"
      },
      {
        name: "Lumina Skin | Laser Treatments",
        sets: [
          {name: "Laser Hair Reduction Interest", ad: "Painless Laser Testimonial"},
          {name: "Full Body Laser Lookalike", ad: "Trial Session at 999"}
        ],
        dailySpend: 1800, dailyImp: 6400, dailyClk: 120, dailyLeads: 5, ind: "messages"
      },
      {
        name: "Lumina Skin | Skin Glow Consultation",
        sets: [
          {name: "Acne & Pigmentation Core", ad: "Dermatologist Consultation Ad"}
        ],
        dailySpend: 1100, dailyImp: 3800, dailyClk: 75, dailyLeads: 3, ind: "actions:lead"
      }
    ];

    var reps = [
      {name: "Aditi Sharma", mgr: "Karan Malhotra", tatBase: 8, slaOdds: 0.88},
      {name: "Rohan Verma", mgr: "Karan Malhotra", tatBase: 14, slaOdds: 0.72},
      {name: "Priya Nair", mgr: "Neha Kapoor", tatBase: 21, slaOdds: 0.60},
      {name: "Vikrant Singh", mgr: "Neha Kapoor", tatBase: 52, slaOdds: 0.32}
    ];

    var leadNum = 1001;

    // Generate past 30 days of daily data
    for (var dayOffset = 29; dayOffset >= 0; dayOffset--){
      var dt = new Date(now.getTime() - dayOffset * 86400000);
      var dayStr = isoDate(dt);
      var dayFactor = 0.85 + (Math.sin(dayOffset * 0.7) + 1) * 0.18; // slight realistic wave

      // Apex campaigns
      for (var a = 0; a < apexCamps.length; a++){
        var ac = apexCamps[a];
        for (var s = 0; s < ac.sets.length; s++){
          var aset = ac.sets[s];
          var sp = Math.round((ac.dailySpend / ac.sets.length) * dayFactor);
          var imp = Math.round((ac.dailyImp / ac.sets.length) * dayFactor);
          var clk = Math.round((ac.dailyClk / ac.sets.length) * dayFactor);
          var lds = Math.round((ac.dailyLeads / ac.sets.length) * dayFactor);
          if (lds < 1 && Math.random() > 0.4) lds = 1;

          metaRows.push([
            ac.name, aset.name, aset.ad, sp, lds, clk, imp, dayStr, dayStr, ac.ind
          ]);

          // CRM Leads for Apex
          for (var li = 0; li < lds; li++){
            var rep = reps[Math.floor(Math.random() * reps.length)];
            var hh = 10 + Math.floor(Math.random() * 9);
            var mm = Math.floor(Math.random() * 59);
            var ss = Math.floor(Math.random() * 59);
            var leadCreated = isoDateTime(dt, hh, mm, ss);

            // TAT & Call
            var withinSLA = Math.random() < rep.slaOdds;
            var tatMin = withinSLA ? Math.max(2, Math.round(rep.tatBase * (0.5 + Math.random() * 0.8)))
                                   : Math.round(rep.tatBase * (1.6 + Math.random() * 3.5));
            var callDt = new Date(dt.getTime());
            callDt.setHours(hh);
            callDt.setMinutes(mm + tatMin);
            var callStr = isoDateTime(callDt, callDt.getHours(), callDt.getMinutes(), callDt.getSeconds());

            // Status distribution for high-ticket real estate
            var randSt = Math.random();
            var st = "New Lead";
            if (randSt < 0.12) st = "Booked / Won";       // Sale (~12%)
            else if (randSt < 0.28) st = "Site Visit Scheduled"; // QL
            else if (randSt < 0.48) st = "Interested";           // QL
            else if (randSt < 0.62) st = "Details Shared";       // QL
            else if (randSt < 0.80) st = "Attempted";
            else if (randSt < 0.92) st = "Out of Budget";
            else st = "Not Interested";

            var phone = "98" + (10000000 + Math.floor(Math.random() * 89999999));
            crmRows.push([
              "APX-" + leadNum++,
              leadCreated,
              ac.ind === "messages" ? "WhatsApp" : "Facebook",
              ac.name,
              aset.name,
              aset.ad,
              st,
              "Apex Living",
              callStr,
              rep.name,
              rep.mgr,
              phone,
              "client" + leadNum + "@example.com",
              "fb_ld_" + (300000000000 + leadNum)
            ]);
          }
        }
      }

      // Lumina campaigns
      for (var b = 0; b < luminaCamps.length; b++){
        var lc = luminaCamps[b];
        for (var ls = 0; ls < lc.sets.length; ls++){
          var lset = lc.sets[ls];
          var lsp = Math.round((lc.dailySpend / lc.sets.length) * dayFactor);
          var limp = Math.round((lc.dailyImp / lc.sets.length) * dayFactor);
          var lclk = Math.round((lc.dailyClk / lc.sets.length) * dayFactor);
          var llds = Math.round((lc.dailyLeads / lc.sets.length) * dayFactor);
          if (llds < 1 && Math.random() > 0.3) llds = 1;

          metaRows.push([
            lc.name, lset.name, lset.ad, lsp, llds, lclk, limp, dayStr, dayStr, lc.ind
          ]);

          // CRM Leads for Lumina
          for (var lli = 0; lli < llds; lli++){
            var lrep = reps[Math.floor(Math.random() * reps.length)];
            var lhh = 10 + Math.floor(Math.random() * 9);
            var lmm = Math.floor(Math.random() * 59);
            var lss = Math.floor(Math.random() * 59);
            var lleadCreated = isoDateTime(dt, lhh, lmm, lss);

            var lwithinSLA = Math.random() < lrep.slaOdds;
            var ltatMin = lwithinSLA ? Math.max(2, Math.round(lrep.tatBase * (0.5 + Math.random() * 0.8)))
                                     : Math.round(lrep.tatBase * (1.6 + Math.random() * 3.5));
            var lcallDt = new Date(dt.getTime());
            lcallDt.setHours(lhh);
            lcallDt.setMinutes(lmm + ltatMin);
            var lcallStr = isoDateTime(lcallDt, lcallDt.getHours(), lcallDt.getMinutes(), lcallDt.getSeconds());

            // Status distribution for clinical dermatology
            var lrandSt = Math.random();
            var lst = "New Lead";
            if (lrandSt < 0.16) lst = "Payment Received";     // Sale (~16%)
            else if (lrandSt < 0.38) lst = "Consultation Booked"; // QL
            else if (lrandSt < 0.58) lst = "Interested";          // QL
            else if (lrandSt < 0.72) lst = "Details Shared";      // QL
            else if (lrandSt < 0.85) lst = "Attempted";
            else lst = "Not Interested";

            var lphone = "97" + (10000000 + Math.floor(Math.random() * 89999999));
            crmRows.push([
              "LUM-" + leadNum++,
              lleadCreated,
              lc.ind === "messages" ? "WhatsApp" : "Facebook",
              lc.name,
              lset.name,
              lset.ad,
              lst,
              "Lumina Skin",
              lcallStr,
              lrep.name,
              lrep.mgr,
              lphone,
              "patient" + leadNum + "@example.com",
              "fb_ld_" + (300000000000 + leadNum)
            ]);
          }
        }
      }
    }

    var settings = {
      name: "Acme Enterprises (Demo)",
      brands: ["Apex Living", "Lumina Skin"],
      keywords: [["apex", "Apex Living"], ["lumina", "Lumina Skin"]],
      wonStatuses: ["Booked / Won", "Payment Received"],
      dealValue: {
        "Apex Living": 1500000,
        "Lumina Skin": 25000
      },
      workHours: {start: "10:00", end: "20:00", days: [1, 2, 3, 4, 5, 6]},
      slaMin: 15,
      slaTarget: 0.8,
      diffAlert: 0.15,
      metaSources: ["facebook", "meta", "instagram", "whatsapp", "telecrm"],
      qlPos: ["qualified", "interested", "details shared", "shared details", "site visit", "visit scheduled", "visit done", "consultation", "booked", "booking", "converted", "payment received", "won"],
      qlNeg: ["not interested", "not qualified", "unqualified", "disqualified", "lost", "junk", "invalid", "wrong", "duplicate", "spam", "out of budget"],
      qlOverride: {},
      crmName: "TeleCRM",
      currency: "INR",
      tz: "Asia/Kolkata",
      tzOffset: 330,
      cols: {
        meta: {
          campaign: "Campaign name", adset: "Ad set name", ad: "Ad name",
          spend: "Amount spent", results: "Results", leads: "Results",
          start: "Reporting starts", end: "Reporting ends"
        },
        crm: {
          id: "Lead id", created: "Created On", source: "Lead Source",
          campaign: "Facebook Campaign Name", adset: "Facebook Ad Set Name", ad: "Facebook Ad",
          status: "Status", brand: "Brand", firstCall: "First Attempted Call",
          owner: "Assignee name", manager: "Assignee Manager name",
          phone: "Phone", email: "Email", fbLead: "Facebook Lead ID"
        }
      }
    };

    var attributionRows = [
      {channel: "Meta Ads", leads: 138, ql: 76, won: 24, spend: 282000, cpl: 2043, cpql: 3710, cps: 11750, estRevenue: 4050000, estRoas: 14.36, aiSearch: false},
      {channel: "Google Ads", leads: 42, ql: 22, won: 7, spend: 84000, cpl: 2000, cpql: 3818, cps: 12000, estRevenue: 1575000, estRoas: 18.75, aiSearch: false},
      {channel: "ChatGPT / AI Search", leads: 18, ql: 12, won: 4, spend: 0, cpl: 0, cpql: 0, cps: 0, estRevenue: 1525000, estRoas: null, aiSearch: true},
      {channel: "Organic Search", leads: 26, ql: 14, won: 5, spend: 0, cpl: 0, cpql: 0, cps: 0, estRevenue: 1550000, estRoas: null, aiSearch: false},
      {channel: "Direct / WhatsApp", leads: 31, ql: 17, won: 6, spend: 0, cpl: 0, cpql: 0, cps: 0, estRevenue: 1775000, estRoas: null, aiSearch: false}
    ];

    var aiAnswers = {
      default: "Based on the demo dataset for **Apex Living** and **Lumina Skin** over the past 30 days:\n\n" +
               "- **Total Ad Spend**: ₹2,82,000 across Meta & WhatsApp campaigns.\n" +
               "- **Total Leads in CRM**: 255 leads captured.\n" +
               "- **Qualified Leads (QL)**: 141 leads (55.3% qualification rate).\n" +
               "- **Total Won Deals / Sales**: 46 deals closed with an estimated revenue of **₹1.05 Cr**.\n" +
               "- **Top Campaign**: *Apex Living | Luxury Villas* generated the highest qualified pipeline with a CPQL of ₹3,710.",
      cpl: "### Cost Per Lead (CPL) Breakdown\n\n" +
           "| Brand | Spend | UI Leads | CPL | QL | CPQL |\n" +
           "|---|---|---|---|---|---|\n" +
           "| Apex Living | ₹1,78,000 | 88 | ₹2,022 | 52 | ₹3,423 |\n" +
           "| Lumina Skin | ₹1,04,000 | 148 | ₹702 | 89 | ₹1,168 |\n\n" +
           "**Key Insight**: *Lumina Skin* achieves high volume at an affordable CPL (₹702), whereas *Apex Living* has higher CPL (₹2,022) but substantially higher ticket size (₹15L average deal value).",
      tat: "### Speed to Lead & Team SLA\n\n" +
           "- **Overall Team TAT**: 23.8 minutes average (median 13 mins).\n" +
           "- **Top Performer**: **Aditi Sharma** — average TAT **8.4 mins** with **88%** calls within 15-minute SLA.\n" +
           "- **Opportunity Area**: **Vikrant Singh** averages **52.6 mins** with **32%** SLA compliance. Leads called after 30 minutes show a 40% lower qualification rate."
    };

    return {
      meta: metaRows,
      crm: crmRows,
      settings: settings,
      attribution: attributionRows,
      aiAnswers: aiAnswers
    };
  }

  root.QLARITY_DEMO = {
    getDemoData: getDemoData
  };
})(typeof window !== "undefined" ? window : global);
