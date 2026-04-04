const express = require("express");
const axios = require("axios");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

const MAKE_S1_URL  = process.env.MAKE_S1_URL;
const MAKE_S3_URL  = process.env.MAKE_S3_URL;
const MAKE_S4_URL  = process.env.MAKE_S4_URL;
const DATABASE_URL = process.env.DATABASE_URL;
const PORT         = process.env.PORT || 8080;

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
      plan_type VARCHAR(50),
      status VARCHAR(50),
      raw_payload JSONB
    );
    CREATE TABLE IF NOT EXISTS users (
      phone VARCHAR(30) PRIMARY KEY,
      name VARCHAR(100),
      dob VARCHAR(50),
      birth_time VARCHAR(50),
      birth_place VARCHAR(100),
      plan_type VARCHAR(50),
      country_code VARCHAR(10),
      phone_nocode VARCHAR(20),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log("✅ Database ready");
}

async function logEvent(eventType, phoneFull, customerName, planType, status, rawPayload) {
  try {
    await pool.query(
      `INSERT INTO webhook_events (event_type, phone_full, customer_name, plan_type, status, raw_payload)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [eventType, phoneFull || null, customerName || null, planType || null, status, JSON.stringify(rawPayload)]
    );
  } catch (err) {
    console.error("DB log error:", err.message);
  }
}

async function saveToDB(data) {
  try {
    await pool.query(`
      INSERT INTO users (phone, name, dob, birth_time, birth_place, plan_type, country_code, phone_nocode, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
      ON CONFLICT (phone) DO UPDATE SET
        name = EXCLUDED.name,
        dob = EXCLUDED.dob,
        birth_time = EXCLUDED.birth_time,
        birth_place = EXCLUDED.birth_place,
        plan_type = EXCLUDED.plan_type,
        country_code = EXCLUDED.country_code,
        phone_nocode = EXCLUDED.phone_nocode,
        updated_at = NOW()
    `, [
      data.phone, data.name, data.dob, data.birth_time,
      data.birth_place, data.plan_type, data.country_code, data.phone_nocode
    ]);
    console.log("✅ Saved to DB:", data.phone);
  } catch (err) {
    console.error("DB save error:", err.message);
  }
}

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

// ── Extract from Interakt data.data array ─────────────────────────────
function extractField(dataArray, traitName) {
  if (!dataArray || !Array.isArray(dataArray)) return null;
  const items = dataArray.filter(
    d => d.question && d.question.user_trait_name === traitName
  );
  if (!items.length) return null;
  const val = items[items.length - 1].answer?.message;
  return val && val.trim() !== "" ? val.trim() : null;
}

// ── Extract from contact_traits object ───────────────────────────────
function extractTrait(traits, traitName) {
  if (!traits) return null;
  const val = traits[traitName];
  if (!val) return null;
  const s = val.toString().trim();
  return s === "" ? null : s;
}

// ── Clean string ──────────────────────────────────────────────────────
function clean(val) {
  if (!val) return null;
  const s = val.toString().trim();
  return s === "" ? null : s;
}

// ── Plan type router ──────────────────────────────────────────────────
function getMakeUrl(planType) {
  if (!planType) return null;
  const p = planType.toLowerCase().trim();
  if (p === "prediction") return MAKE_S1_URL;
  if (p === "ask")        return MAKE_S3_URL;
  if (p === "consult")    return MAKE_S4_URL;
  return null;
}

// ── COUNTRY CODES ─────────────────────────────────────────────────────
const COUNTRY_CODES = [
  "+971","+91","+1","+44","+61","+49","+33","+81","+86","+7",
  "+92","+880","+94","+60","+65","+66","+62","+63","+84","+82",
  "+27","+20","+234","+254","+212","+213","+216","+973","+965",
  "+966","+974","+968","+962","+961","+972","+90","+39","+34",
  "+31","+32","+41","+43","+46","+47","+45","+358","+351",
  "+48","+36","+420","+40","+380","+375","+370","+371","+372"
];

function splitPhone(fullPhone) {
  if (!fullPhone) return { countryCode: "", phoneNumber: fullPhone };
  for (const code of COUNTRY_CODES) {
    if (fullPhone.startsWith(code)) {
      return {
        countryCode: code,
        phoneNumber: fullPhone.slice(code.length)
      };
    }
  }
  return { countryCode: "", phoneNumber: fullPhone };
}

// ─────────────────────────────────────────────────────────────────────
// POST /webhook
// ─────────────────────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;

    addLog("RECEIVED_RAW", {
      type: body.type,
      customer: body.data?.customer_name,
      phone: body.data?.customer_number,
      keys: Object.keys(body.data || {})
    });

    await logEvent("received", body.data?.customer_number, body.data?.customer_name, null, "received", body);

    // ── Only process workflow_response_update ─────────────────────────
    if (body.type !== "workflow_response_update") {
      addLog("IGNORED", { type: body.type });
      return res.json({ status: "ignored" });
    }

    const data        = body.data || {};
    const fullPhone   = data.customer_number || "";
    const dataArray   = data.data || [];
    const traits      = data.contact_traits || data.customer_traits || {};

    addLog("PARSING", {
      fullPhone,
      dataArrayLength: dataArray.length,
      traitKeys: Object.keys(traits),
      rawTraits: traits
    });

    // ── Try extracting from data.data array first ─────────────────────
    let name       = extractField(dataArray, "name");
    let dob        = extractField(dataArray, "dob");
    let birthPlace = extractField(dataArray, "user_birth_place");
    let birthTime  = extractField(dataArray, "user_birth_time");
    let planType   = extractField(dataArray, "getpredection");

    // ── Fallback: try contact_traits object ───────────────────────────
    if (!name)       name       = extractTrait(traits, "name");
    if (!dob)        dob        = extractTrait(traits, "dob");
    if (!birthPlace) birthPlace = extractTrait(traits, "user_birth_place");
    if (!birthTime)  birthTime  = extractTrait(traits, "user_birth_time");
    if (!planType)   planType   = extractTrait(traits, "getpredection");

    // ── Fallback: try direct body fields (custom webhook body) ────────
    if (!name)       name       = clean(body.n || data.n);
    if (!dob)        dob        = clean(body.d || data.d);
    if (!birthPlace) birthPlace = clean(body.bp || data.bp);
    if (!birthTime)  birthTime  = clean(body.t || data.t);
    if (!planType)   planType   = clean(body.tp || data.tp);

    const { countryCode, phoneNumber } = splitPhone(fullPhone);

    addLog("EXTRACTED", {
      name, dob, birthPlace, birthTime, planType,
      phone: fullPhone
    });

    // ── Validate ──────────────────────────────────────────────────────
    const allFieldsPresent = name && dob && birthPlace && birthTime && planType;

    if (!allFieldsPresent) {
      addLog("WAITING", {
        reason: "Not all fields collected yet",
        collected: {
          name:       !!name,
          dob:        !!dob,
          birthPlace: !!birthPlace,
          tob:        !!birthTime,
          topic:      !!planType
        }
      });
      await logEvent("waiting", fullPhone, name, planType, "waiting", body);
      return res.json({ status: "waiting" });
    }

    // ── Route to Make.com ─────────────────────────────────────────────
    const makeUrl = getMakeUrl(planType);

    if (!makeUrl) {
      addLog("UNKNOWN_PLAN", { planType });
      await logEvent("unknown_plan", fullPhone, name, planType, "unknown_plan", body);
      return res.json({ status: "unknown_plan", planType });
    }

    // ── Save to DB ────────────────────────────────────────────────────
    await saveToDB({
      phone:        fullPhone,
      name,
      dob,
      birth_time:   birthTime,
      birth_place:  birthPlace,
      plan_type:    planType,
      country_code: countryCode,
      phone_nocode: phoneNumber
    });

    // ── Send to Make.com ──────────────────────────────────────────────
    const makePayload = {
      phone:        fullPhone,
      name,
      dob,
      birth_time:   birthTime,
      birth_place:  birthPlace,
      plan_type:    planType,
      country_code: countryCode
    };

    const r = await axios.post(makeUrl, makePayload, {
      headers: { "Content-Type": "application/json" }
    });

    addLog("SENT_TO_MAKE", { plan: planType, phone: fullPhone, status: r.status });
    await logEvent("forwarded", fullPhone, name, planType, `forwarded_${planType.toLowerCase()}`, body);

    return res.json({ status: "ok", plan: planType });

  } catch (err) {
    addLog("ERROR", { message: err.message, stack: err.stack });
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
        COUNT(*)                                          AS total,
        COUNT(*) FILTER (WHERE status LIKE 'forwarded%') AS forwarded,
        COUNT(*) FILTER (WHERE plan_type = 'Prediction') AS prediction,
        COUNT(*) FILTER (WHERE plan_type = 'Ask')        AS ask,
        COUNT(*) FILTER (WHERE plan_type = 'Consult')    AS consult,
        COUNT(*) FILTER (WHERE status = 'waiting')       AS waiting,
        COUNT(*) FILTER (WHERE status = 'unknown_plan')  AS unknown
      FROM webhook_events
    `);

    const s = stats.rows[0];

    const eventRows = events.rows.map(r => `
      <tr>
        <td>${new Date(r.received_at).toLocaleString("en-GB", { timeZone: "Asia/Dubai" })}</td>
        <td>${r.phone_full || "—"}</td>
        <td>${r.customer_name || "—"}</td>
        <td>${r.plan_type || "—"}</td>
        <td><span class="badge ${
          r.status?.includes("forwarded") ? "success" :
          r.status === "waiting"          ? "waiting" :
          r.status === "unknown_plan"     ? "error"   : "info"
        }">${r.status}</span></td>
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
    .stat.orange .num { color: #fdba74; }
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
    <div class="stat green"><div class="num">${s.forwarded}</div><div class="label">Forwarded to Make</div></div>
    <div class="stat blue"><div class="num">${s.prediction}</div><div class="label">Predictions</div></div>
    <div class="stat orange"><div class="num">${s.ask}</div><div class="label">Ask Astrologer</div></div>
    <div class="stat yellow"><div class="num">${s.consult}</div><div class="label">Consultations</div></div>
    <div class="stat red"><div class="num">${s.unknown}</div><div class="label">Unknown Plan</div></div>
  </div>
  <h2>📥 All Webhook Events</h2>
  <table>
    <thead><tr><th>Time</th><th>Phone</th><th>Name</th><th>Plan</th><th>Status</th></tr></thead>
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
    MAKE_S1_URL:  !!MAKE_S1_URL,
    MAKE_S3_URL:  !!MAKE_S3_URL,
    MAKE_S4_URL:  !!MAKE_S4_URL,
    DATABASE_URL: !!DATABASE_URL
  };

  const envBar = Object.entries(envVars)
    .map(([k, v]) => `<span style="color:${v ? "#86efac" : "#fca5a5"}">${v ? "✅" : "⚠️"} ${k}</span>`)
    .join(" &nbsp; ");

  const logRows = logs.map(log => `
    <tr>
      <td>${log.time}</td>
      <td><span class="badge ${
        log.type.includes("ERROR")   ? "error"   :
        log.type.includes("SENT")    ? "success" :
        log.type.includes("WAITING") || log.type.includes("UNKNOWN") ? "waiting" : "info"
      }">${log.type}</span></td>
      <td><pre>${JSON.stringify(log.data, null, 2)}</pre></td>
    </tr>`).join("");

  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Astro Middleware v12</title>
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
  <h1>🔮 Astro Middleware v12</h1>
  <p class="status">✅ Running — auto-refresh 5s | 🕐 Dubai Time (UTC+4) | ${logs.length} events</p>
  <div class="nav" style="margin-bottom:12px">
    <a href="/dashboard">📊 Dashboard</a>
    <a href="/">📋 Live Logs</a>
  </div>
  <div class="env-bar">${envBar}</div>
  <div class="flow-box">
    <b>Source 1</b> → data.data array (extractField) ✅<br>
    <b>Source 2</b> → contact_traits object (extractTrait) ✅<br>
    <b>Source 3</b> → direct body fields fallback ✅<br>
    <b>Routing</b>  → Prediction→S1 | Ask→S3 | Consult→S4 ✅<br>
    <b>DB</b>       → PostgreSQL upsert on phone ✅
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
    console.log(`🚀 Astro middleware v12 running on port ${PORT}`);
  });
}).catch(err => {
  console.error("❌ DB init failed:", err.message);
  process.exit(1);
});
