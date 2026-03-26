const express = require("express");
const axios = require("axios");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

// ── Env vars ─────────────────────────────────────────────────────────
const MAKE_WEBHOOK_URL    = process.env.MAKE_WEBHOOK_URL;
const MAKE_WEBHOOK_URL_S5 = process.env.MAKE_WEBHOOK_URL_S5;
const S5_WORKFLOW_ID      = process.env.S5_WORKFLOW_ID;
const S49_WORKFLOW_ID     = process.env.S49_WORKFLOW_ID;
const DATABASE_URL        = process.env.DATABASE_URL;
const PORT                = process.env.PORT || 8080;

// ── PostgreSQL ────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS webhook_events (
      id SERIAL PRIMARY KEY,
      received_at TIMESTAMPTZ DEFAULT NOW(),
      event_type VARCHAR(50),
      phone_full VARCHAR(30),
      customer_name VARCHAR(100),
      workflow_id VARCHAR(100),
      status VARCHAR(50),
      raw_payload JSONB
    );
  `);
  console.log("✅ Database ready");
}

async function logEvent(eventType, phoneFull, customerName, workflowId, status, rawPayload) {
  try {
    await pool.query(
      `INSERT INTO webhook_events (event_type, phone_full, customer_name, workflow_id, status, raw_payload)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [eventType, phoneFull || null, customerName || null, workflowId || null, status, JSON.stringify(rawPayload)]
    );
  } catch (err) {
    console.error("DB log error:", err.message);
  }
}

// ── In-memory logs ────────────────────────────────────────────────────
const logs = [];

function addLog(type, data) {
  logs.unshift({ time: getDubaiTime(), type, data });
  if (logs.length > 100) logs.pop();
}

function getDubaiTime() {
  return new Date().toLocaleString("en-GB", {
    timeZone: "Asia/Dubai",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false
  });
}

// ── Field extractor ───────────────────────────────────────────────────
function extractField(dataArray, traitName) {
  const items = dataArray.filter(
    (d) => d.question && d.question.user_trait_name === traitName
  );
  if (!items.length) return null;
  return items[items.length - 1].answer.message;
}

// ── Phone splitter ────────────────────────────────────────────────────
const COUNTRY_CODES = [
  "+1242","+1246","+1264","+1268","+1284","+1340","+1345","+1441","+1473",
  "+1649","+1664","+1670","+1671","+1684","+1758","+1767","+1784","+1809",
  "+1868","+1869","+1876","+1939","+355","+213","+376","+244","+374","+994",
  "+973","+880","+375","+501","+229","+975","+591","+387","+267","+673",
  "+359","+226","+257","+855","+237","+238","+236","+235","+269","+242",
  "+506","+385","+357","+420","+253","+593","+503","+372","+251","+679",
  "+358","+241","+220","+995","+233","+502","+224","+592","+509","+504",
  "+852","+354","+353","+972","+962","+996","+856","+371","+961","+266",
  "+231","+218","+370","+352","+853","+261","+265","+960","+223","+356",
  "+222","+230","+373","+377","+976","+382","+212","+258","+264","+977",
  "+505","+227","+234","+850","+968","+507","+595","+351","+974","+250",
  "+966","+221","+381","+248","+232","+421","+386","+252","+597","+963",
  "+886","+992","+255","+216","+993","+256","+380","+598","+998","+967",
  "+260","+263","+971","+965","+964","+961","+960","+93","+54","+61",
  "+43","+32","+55","+86","+57","+53","+45","+20","+33","+49","+30",
  "+36","+62","+98","+39","+81","+254","+60","+52","+31","+64","+47",
  "+92","+63","+48","+40","+7","+27","+82","+34","+94","+46","+41",
  "+66","+90","+44","+58","+84","+91","+1"
];

function splitPhone(fullPhone) {
  let countryCode = "";
  let phoneNumber = fullPhone;
  for (const code of COUNTRY_CODES) {
    if (fullPhone.startsWith(code)) {
      countryCode = code;
      phoneNumber = fullPhone.slice(code.length);
      break;
    }
  }
  return { countryCode, phoneNumber };
}

// ── Month maps ────────────────────────────────────────────────────────
const MONTH_NAMES = {
  "1": "January", "2": "February", "3": "March", "4": "April",
  "5": "May", "6": "June", "7": "July", "8": "August",
  "9": "September", "10": "October", "11": "November", "12": "December"
};

const MONTH_NAME_MAP = {
  january:"1", february:"2", march:"3", april:"4", may:"5", june:"6",
  july:"7", august:"8", september:"9", october:"10", november:"11", december:"12",
  jan:"1", feb:"2", mar:"3", apr:"4", jun:"6", jul:"7",
  aug:"8", sep:"9", oct:"10", nov:"11", dec:"12"
};

// ── Topic map ─────────────────────────────────────────────────────────
const TOPIC_MAP = {
  "1": "Money", "2": "Career", "3": "Love", "4": "Today's Energy"
};

// ── Smart flexible date parser ────────────────────────────────────────
// Handles: "20 feb 1993", "feb 20 1993", "20/02/1993", "January", "1" etc.
function parseFlexibleDate(dayRaw, monthRaw, yearRaw) {
  let day = dayRaw, month = monthRaw, year = yearRaw;

  // Normalize standalone month name first
  if (month) {
    const m = month.toString().toLowerCase().trim();
    month = MONTH_NAME_MAP[m] || MONTH_NAME_MAP[m.substring(0, 3)] || month;
  }

  // Try to detect full date in any single field
  const sources = [dayRaw, monthRaw, yearRaw].filter(Boolean);
  for (const src of sources) {
    const str = src.toString().trim().toLowerCase();

    // "20/02/1993" or "20-02-1993" or "20.02.1993"
    const slashMatch = str.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/);
    if (slashMatch) {
      day = slashMatch[1]; month = slashMatch[2]; year = slashMatch[3];
      break;
    }

    // "20 feb 1993" or "feb 20 1993" or "20 february 1993"
    const parts = str.split(/[\s,]+/);
    if (parts.length >= 3) {
      let d = null, m = null, y = null;
      for (const p of parts) {
        if (/^\d{4}$/.test(p))                    { y = p; }
        else if (MONTH_NAME_MAP[p])                { m = MONTH_NAME_MAP[p]; }
        else if (MONTH_NAME_MAP[p.substring(0,3)]) { m = MONTH_NAME_MAP[p.substring(0,3)]; }
        else if (/^\d{1,2}$/.test(p) && !d)       { d = p; }
      }
      if (d && m && y) { day = d; month = m; year = y; break; }
    }

    // "20feb1993" no spaces
    const noSpaceMatch = str.match(/^(\d{1,2})(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*(\d{4})$/i);
    if (noSpaceMatch) {
      day   = noSpaceMatch[1];
      month = MONTH_NAME_MAP[noSpaceMatch[2].toLowerCase()];
      year  = noSpaceMatch[3];
      break;
    }
  }

  return {
    day:   day?.toString()   || null,
    month: month?.toString() || null,
    year:  year?.toString()  || null
  };
}

// ─────────────────────────────────────────────────────────────────────
// POST /webhook
// ─────────────────────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;
    const incomingPhone = body.data?.customer_number || null;

    addLog("RECEIVED", {
      type: body.type,
      workflow_id: body.data?.workflow_id,
      customer: body.data?.customer_name
    });

    // Log all events to DB
    await logEvent(
      body.type || "unknown",
      incomingPhone,
      body.data?.customer_name,
      body.data?.workflow_id,
      "received",
      body
    );

    if (body.type !== "workflow_response_update") {
      addLog("IGNORED", { reason: "Not workflow_response_update", type: body.type });
      return res.status(200).json({ status: "ignored" });
    }

    const data       = body.data;
    const workflowId = data.workflow_id || "";
    const fullPhone  = data.customer_number || "";

    // ── S49: ignore ───────────────────────────────────────────────────
    if (workflowId === S49_WORKFLOW_ID) {
      addLog("S49_IGNORED", { workflow_id: workflowId });
      await logEvent("s49", fullPhone, data.customer_name, workflowId, "ignored_s49", body);
      return res.status(200).json({ status: "ignored_s49" });
    }

    // ── S5: ASK button → phone only → Make S5 ────────────────────────
    if (workflowId === S5_WORKFLOW_ID) {
      if (!fullPhone) return res.status(200).json({ status: "no_phone" });
      const dataArray  = data.data || [];
      const lastAnswer = dataArray[dataArray.length - 1]?.answer?.message || "";
      if (lastAnswer.toUpperCase() !== "ASK") {
        addLog("S5_WAITING", { lastAnswer });
        return res.status(200).json({ status: "waiting" });
      }
      const { countryCode, phoneNumber } = splitPhone(fullPhone);
      const makePayload = {
        country_code: countryCode, phone: phoneNumber,
        phone_full: fullPhone, customer_name: data.customer_name || ""
      };
      addLog("S5_FORWARDED_TO_MAKE", makePayload);
      await logEvent("s5_ask", fullPhone, data.customer_name, workflowId, "forwarded_s5", body);
      const r = await axios.post(MAKE_WEBHOOK_URL_S5, makePayload, {
        headers: { "Content-Type": "application/json" }
      });
      addLog("S5_MAKE_RESPONSE", { status: r.status });
      return res.status(200).json({ status: "success_s5" });
    }

    // ── S1: collect all 7 fields ──────────────────────────────────────
    const dataArray = data.data || [];

    const name          = extractField(dataArray, "name");
    const birthDayRaw   = extractField(dataArray, "user_birth_day");
    const birthMonthRaw = extractField(dataArray, "user_birth_month");
    const birthYearRaw  = extractField(dataArray, "user_birth_year");
    const tob           = extractField(dataArray, "user_birth_time");
    const birthPlace    = extractField(dataArray, "user_birth_place");
    const topicRaw      = extractField(dataArray, "prediction_choice");
    const topic         = TOPIC_MAP[topicRaw] || topicRaw;

    // Smart parse — handles any date format the user types
    const { day: birthDay, month: birthMonth, year: birthYear } =
      parseFlexibleDate(birthDayRaw, birthMonthRaw, birthYearRaw);

    if (!name || !birthDay || !birthMonth || !birthYear || !tob || !birthPlace || !topic) {
      addLog("S1_WAITING", {
        reason: "Not all fields collected yet",
        collected: {
          name: !!name, birthDay: !!birthDay, birthMonth: !!birthMonth,
          birthYear: !!birthYear, tob: !!tob, birthPlace: !!birthPlace, topic: !!topic
        }
      });
      return res.status(200).json({ status: "waiting" });
    }

    const yearNum = parseInt(birthYear, 10);
    if (isNaN(yearNum) || yearNum < 1935 || yearNum > 2026) {
      addLog("S1_INVALID_YEAR", { birthYear });
      await logEvent("s1_invalid_year", fullPhone, name, workflowId, "invalid_year", body);
      return res.status(200).json({ status: "invalid_year" });
    }

    const dob = `${birthDay} ${MONTH_NAMES[birthMonth] || birthMonth} ${birthYear}`;
    const { countryCode, phoneNumber } = splitPhone(fullPhone);

    const makePayload = {
      name, dob, birth_place: birthPlace, tob, topic,
      country_code: countryCode, phone: phoneNumber, phone_full: fullPhone
    };

    addLog("S1_FORWARDED_TO_MAKE", makePayload);
    await logEvent("s1_complete", fullPhone, name, workflowId, "forwarded_s1", body);

    const r = await axios.post(MAKE_WEBHOOK_URL, makePayload, {
      headers: { "Content-Type": "application/json" }
    });
    addLog("S1_MAKE_RESPONSE", { status: r.status });
    return res.status(200).json({ status: "success_s1" });

  } catch (err) {
    addLog("ERROR", { message: err.message });
    return res.status(500).json({ status: "error", message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// GET /dashboard
// ─────────────────────────────────────────────────────────────────────
app.get("/dashboard", async (req, res) => {
  try {
    const events = await pool.query(
      `SELECT * FROM webhook_events ORDER BY received_at DESC LIMIT 200`
    );
    const stats = await pool.query(`
      SELECT
        COUNT(*)                                            AS total,
        COUNT(*) FILTER (WHERE event_type = 's1_complete') AS s1_complete,
        COUNT(*) FILTER (WHERE event_type = 's1_invalid_year') AS invalid_year,
        COUNT(*) FILTER (WHERE event_type = 's5_ask')      AS s5_ask,
        COUNT(*) FILTER (WHERE status = 'ignored_s49')     AS s49_ignored
      FROM webhook_events
    `);

    const s = stats.rows[0];

    const eventRows = events.rows.map(r => `
      <tr>
        <td>${new Date(r.received_at).toLocaleString("en-GB", { timeZone: "Asia/Dubai" })}</td>
        <td>${r.phone_full || "—"}</td>
        <td>${r.customer_name || "—"}</td>
        <td><span class="badge ${
          r.status === "forwarded_s1" || r.status === "forwarded_s5" ? "success" :
          r.status === "ignored_s49" || r.status === "ignored"       ? "waiting" :
          r.status === "invalid_year"                                 ? "error"   : "info"
        }">${r.event_type}</span></td>
        <td>${r.status}</td>
      </tr>`).join("");

    res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Astro Yashodhan — Dashboard</title>
  <meta http-equiv="refresh" content="15">
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f0f0f; color: #e0e0e0; padding: 24px; margin: 0; }
    h1 { color: #a78bfa; margin-bottom: 4px; font-size: 22px; }
    h2 { color: #a78bfa; font-size: 16px; margin: 28px 0 10px; }
    .subtitle { color: #64748b; font-size: 13px; margin-bottom: 24px; }
    .stats { display: flex; gap: 16px; margin-bottom: 28px; flex-wrap: wrap; }
    .stat { background: #1a1a2e; border-radius: 10px; padding: 16px 24px; min-width: 140px; border: 1px solid #2a2a4a; }
    .stat .num { font-size: 32px; font-weight: 700; color: #a78bfa; }
    .stat .label { font-size: 12px; color: #64748b; margin-top: 4px; }
    .stat.green .num { color: #86efac; }
    .stat.yellow .num { color: #fcd34d; }
    .stat.red .num { color: #fca5a5; }
    .stat.blue .num { color: #93c5fd; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; padding: 10px 12px; background: #1a1a2e; color: #a78bfa; font-weight: 600; }
    td { padding: 10px 12px; border-bottom: 1px solid #1e1e2e; vertical-align: top; }
    tr:hover td { background: #1a1a2e; }
    .badge { padding: 3px 9px; border-radius: 20px; font-size: 11px; font-weight: 600; display: inline-block; }
    .success { background: #14532d; color: #86efac; }
    .error   { background: #7f1d1d; color: #fca5a5; }
    .waiting { background: #78350f; color: #fcd34d; }
    .info    { background: #1e3a5f; color: #93c5fd; }
    .nav a { color: #a78bfa; text-decoration: none; margin-right: 20px; font-size: 13px; }
  </style>
</head>
<body>
  <h1>🔮 Astro Yashodhan — Dashboard</h1>
  <p class="subtitle">Auto-refreshes every 15s · Dubai Time (UTC+4)</p>
  <div class="nav" style="margin-bottom:20px">
    <a href="/dashboard">📊 Dashboard</a>
    <a href="/">📋 Live Logs</a>
  </div>

  <div class="stats">
    <div class="stat"><div class="num">${s.total}</div><div class="label">Total Events</div></div>
    <div class="stat green"><div class="num">${s.s1_complete}</div><div class="label">S1 Completed</div></div>
    <div class="stat blue"><div class="num">${s.s5_ask}</div><div class="label">S5 ASK Triggers</div></div>
    <div class="stat red"><div class="num">${s.invalid_year}</div><div class="label">Invalid Year</div></div>
    <div class="stat yellow"><div class="num">${s.s49_ignored}</div><div class="label">S49 Ignored</div></div>
  </div>

  <h2>📥 All Webhook Events</h2>
  <table>
    <thead><tr><th>Time</th><th>Phone</th><th>Name</th><th>Type</th><th>Status</th></tr></thead>
    <tbody>${eventRows || '<tr><td colspan="5" style="color:#555;text-align:center">No events yet</td></tr>'}</tbody>
  </table>
</body>
</html>`);
  } catch (err) {
    res.status(500).send(`<pre>Dashboard error: ${err.message}</pre>`);
  }
});

// ─────────────────────────────────────────────────────────────────────
// GET / — Live logs
// ─────────────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  const envVars = {
    MAKE_WEBHOOK_URL:    !!MAKE_WEBHOOK_URL,
    MAKE_WEBHOOK_URL_S5: !!MAKE_WEBHOOK_URL_S5,
    DATABASE_URL:        !!DATABASE_URL,
    S5_WORKFLOW_ID:      !!S5_WORKFLOW_ID,
    S49_WORKFLOW_ID:     !!S49_WORKFLOW_ID
  };

  const envBar = Object.entries(envVars)
    .map(([k, v]) => `<span style="color:${v ? "#86efac" : "#fca5a5"}">${v ? "✅" : "⚠️"} ${k}</span>`)
    .join(" &nbsp; ");

  const logRows = logs.map(log => `
    <tr>
      <td>${log.time}</td>
      <td><span class="badge ${
        log.type.includes("ERROR")     ? "error"   :
        log.type.includes("FORWARDED") ? "success" :
        log.type.includes("WAITING") || log.type.includes("IGNORED") || log.type.includes("INVALID") ? "waiting" : "info"
      }">${log.type}</span></td>
      <td><pre>${JSON.stringify(log.data, null, 2)}</pre></td>
    </tr>`).join("");

  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Astro Middleware v11</title>
  <meta http-equiv="refresh" content="5">
  <style>
    body { font-family: monospace; background: #0f0f0f; color: #e0e0e0; padding: 20px; }
    h1 { color: #a78bfa; margin-bottom: 4px; }
    .env-bar { background: #1a1a2e; padding: 12px 16px; border-radius: 6px; margin-bottom: 12px; font-size: 11px; line-height: 2.4; }
    .flow-box { background: #111827; border-left: 3px solid #a78bfa; padding: 10px 14px; border-radius: 4px; margin-bottom: 16px; font-size: 11px; color: #94a3b8; line-height: 2; }
    .flow-box b { color: #e2e8f0; }
    .nav a { color: #a78bfa; text-decoration: none; margin-right: 20px; font-size: 13px; }
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; padding: 10px; background: #1a1a2e; color: #a78bfa; }
    td { padding: 10px; border-bottom: 1px solid #222; vertical-align: top; font-size: 12px; }
    pre { margin: 0; white-space: pre-wrap; word-break: break-all; max-width: 700px; }
    .badge { padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: bold; }
    .error   { background: #7f1d1d; color: #fca5a5; }
    .success { background: #14532d; color: #86efac; }
    .waiting { background: #78350f; color: #fcd34d; }
    .info    { background: #1e3a5f; color: #93c5fd; }
    .status  { color: #86efac; font-size: 13px; margin-bottom: 12px; }
  </style>
</head>
<body>
  <h1>🔮 Astro Middleware v11</h1>
  <p class="status">✅ Running — auto-refresh 5s | 🕐 Dubai Time (UTC+4) | ${logs.length} events</p>
  <div class="nav" style="margin-bottom:12px"><a href="/dashboard">📊 Dashboard</a><a href="/">📋 Live Logs</a></div>
  <div class="env-bar">${envBar}</div>
  <div class="flow-box">
    <b>S1</b> → 7 fields → smart date parser (any format) → Make S1 ✅<br>
    <b>S5</b> → ASK button → phone only → Make S5 ✅<br>
    <b>S49</b> → Ignored silently | <b>DB</b> → PostgreSQL ✅
  </div>
  <table>
    <thead><tr><th>Time (Dubai)</th><th>Type</th><th>Data</th></tr></thead>
    <tbody>${logRows || '<tr><td colspan="3" style="color:#888">No events yet.</td></tr>'}</tbody>
  </table>
</body>
</html>`);
});

// ─────────────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Astro middleware v11 running on port ${PORT}`);
  });
}).catch(err => {
  console.error("❌ DB init failed:", err.message);
  process.exit(1);
});
