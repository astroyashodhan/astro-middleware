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
      plan_type VARCHAR(50),
      status VARCHAR(50),
      raw_payload JSONB
    )
  `);

  await pool.query(`
    ALTER TABLE webhook_events
    ADD COLUMN IF NOT EXISTS plan_type VARCHAR(50)
  `);

  await pool.query(`
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
    )
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
  } catch (err) {
    console.error("DB save error:", err.message);
  }
}

// ── Logs ──────────────────────────────────────────────────────────────
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

// ── Extract from data.data array ──────────────────────────────────────
function extractField(dataArray, traitName) {
  if (!dataArray || !Array.isArray(dataArray)) return null;
  const items = dataArray.filter(
    d => d.question && d.question.user_trait_name === traitName
  );
  if (!items.length) return null;
  const val = items[items.length - 1].answer?.message;
  if (!val) return null;
  const s = val.toString().trim();
  return s === "" ? null : s;
}

// ── Phone splitter ────────────────────────────────────────────────────
const COUNTRY_CODES = [
  "+971","+91","+1","+44","+61","+49","+33","+81","+86","+7",
  "+92","+880","+94","+60","+65","+66","+62","+63","+84","+82",
  "+27","+20","+234","+254","+212","+213","+216","+973","+965",
  "+966","+974","+968","+962","+961","+972","+90","+39","+34",
  "+31","+32","+41","+43","+46","+47","+45","+358","+351",
  "+48","+36","+420","+40","+380","+375","+370","+371","+372"
];

function splitPhone(fullPhone) {
  if (!fullPhone) return { countryCode: "", phoneNumber: "" };
  for (const code of COUNTRY_CODES) {
    if (fullPhone.startsWith(code)) {
      return { countryCode: code, phoneNumber: fullPhone.slice(code.length) };
    }
  }
  return { countryCode: "", phoneNumber: fullPhone };
}

// ── Plan router ───────────────────────────────────────────────────────
function getMakeUrl(planType) {
  if (!planType) return null;
  const p = planType.toLowerCase().trim();
  if (p === "prediction") return MAKE_S1_URL;
  if (p === "ask")        return MAKE_S3_URL;
  if (p === "consult")    return MAKE_S4_URL;
  return null;
}

// ── Check if planType is a valid routable plan ────────────────────────
function isValidPlan(planType) {
  if (!planType) return false;
  const p = planType.toLowerCase().trim();
  return p === "prediction" || p === "ask" || p === "consult";
}

// ─────────────────────────────────────────────────────────────────────
// POST /webhook  (new users — standard Interakt workflow_response_update)
// ─────────────────────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;

    addLog("RECEIVED_RAW", {
      type: body.type,
      customer: body.data?.customer_name,
      phone: body.data?.customer_number
    });

    await logEvent("received", body.data?.customer_number, body.data?.customer_name, null, "received", body);

    if (body.type !== "workflow_response_update") {
      addLog("IGNORED", { type: body.type });
      return res.json({ status: "ignored" });
    }

    const data      = body.data || {};
    const fullPhone = data.customer_number || "";
    const dataArray = data.data || [];

    // ── Extract all fields from webhook payload ───────────────────────
    const name       = extractField(dataArray, "name");
    const birthDay   = extractField(dataArray, "user_birth_day");
    const birthMonth = extractField(dataArray, "user_birth_month");
    const birthYear  = extractField(dataArray, "user_birth_year");
    const birthTime  = extractField(dataArray, "user_birth_time");
    const birthPlace = extractField(dataArray, "user_birth_place");
    const planType   = extractField(dataArray, "getpredection");

    const dob = (birthDay && birthMonth && birthYear)
      ? `${birthDay} ${birthMonth} ${birthYear}`
      : null;

    const { countryCode, phoneNumber } = splitPhone(fullPhone);

    addLog("EXTRACTED", {
      name, birthDay, birthMonth, birthYear,
      dob, birthTime, birthPlace, planType,
      phone_full: fullPhone,
      phone_number: phoneNumber,
      country_code: countryCode
    });

    // ── Entry button guard ────────────────────────────────────────────
    if (planType && !isValidPlan(planType)) {
      addLog("ENTRY_BUTTON", { reason: "not a routable plan", planType, phone: fullPhone });
      await logEvent("entry_button", fullPhone, name, planType, "entry_button", body);
      return res.json({ status: "entry_button", planType });
    }

    // ── Returning user: fill missing fields from DB ───────────────────
    let finalName       = name;
    let finalDob        = dob;
    let finalBirthTime  = birthTime;
    let finalBirthPlace = birthPlace;
    let finalPlanType   = planType;

    if (fullPhone && (!name || !dob || !birthPlace || !birthTime)) {
      try {
        const existing = await pool.query(`SELECT * FROM users WHERE phone = $1`, [fullPhone]);
        if (existing.rows.length > 0) {
          const u = existing.rows[0];
          finalName       = name       || u.name;
          finalDob        = dob        || u.dob;
          finalBirthTime  = birthTime  || u.birth_time;
          finalBirthPlace = birthPlace || u.birth_place;
          addLog("DB_FILL", {
            phone: fullPhone,
            filled: {
              name:       !name       && !!u.name,
              dob:        !dob        && !!u.dob,
              birthTime:  !birthTime  && !!u.birth_time,
              birthPlace: !birthPlace && !!u.birth_place
            },
            source: "existing user lookup"
          });
        } else {
          addLog("DB_FILL", { phone: fullPhone, filled: false, source: "no existing user found" });
        }
      } catch (err) {
        addLog("DB_FILL_ERROR", { message: err.message });
      }
    }

    addLog("FINAL_FIELDS", {
      name: finalName, dob: finalDob,
      birthTime: finalBirthTime, birthPlace: finalBirthPlace,
      planType: finalPlanType, phone_full: fullPhone
    });

    // ── Validate ──────────────────────────────────────────────────────
    const allFieldsPresent = finalName && finalDob && finalBirthPlace && finalBirthTime && finalPlanType;

    if (!allFieldsPresent) {
      addLog("WAITING", {
        reason: "Not all fields collected yet",
        collected: {
          name: !!finalName, dob: !!finalDob,
          birthPlace: !!finalBirthPlace, birthTime: !!finalBirthTime, planType: !!finalPlanType
        }
      });
      await logEvent("waiting", fullPhone, finalName, finalPlanType, "waiting", body);
      return res.json({ status: "waiting" });
    }

    // ── Route ─────────────────────────────────────────────────────────
    const makeUrl = getMakeUrl(finalPlanType);
    if (!makeUrl) {
      addLog("UNKNOWN_PLAN", { planType: finalPlanType });
      await logEvent("unknown_plan", fullPhone, finalName, finalPlanType, "unknown_plan", body);
      return res.json({ status: "unknown_plan", planType: finalPlanType });
    }

    // ── Save + Send ───────────────────────────────────────────────────
    await saveToDB({
      phone: fullPhone, name: finalName, dob: finalDob,
      birth_time: finalBirthTime, birth_place: finalBirthPlace,
      plan_type: finalPlanType, country_code: countryCode, phone_nocode: phoneNumber
    });

    const r = await axios.post(makeUrl, {
      phone_full: fullPhone, phone_number: phoneNumber, country_code: countryCode,
      name: finalName, dob: finalDob, birth_time: finalBirthTime,
      birth_place: finalBirthPlace, plan_type: finalPlanType
    }, { headers: { "Content-Type": "application/json" } });

    addLog("SENT_TO_MAKE", { plan: finalPlanType, phone_full: fullPhone, status: r.status });
    await logEvent("forwarded", fullPhone, finalName, finalPlanType, `forwarded_${finalPlanType.toLowerCase()}`, body);

    return res.json({ status: "ok", plan: finalPlanType });

  } catch (err) {
    addLog("ERROR", { message: err.message });
    return res.status(500).json({ status: "error", message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// POST /webhook-returning  (returning users — Interakt sends all traits)
//
// Set this URL in Interakt returning user workflow webhook step:
// https://astro-middleware-production.up.railway.app/webhook-returning
//
// Interakt webhook body should be:
// {
//   "phone": "{{contact.phone_number}}",
//   "name": "{{contact.traits.name}}",
//   "dob_day": "{{contact.traits.user_birth_day}}",
//   "dob_month": "{{contact.traits.user_birth_month}}",
//   "dob_year": "{{contact.traits.user_birth_year}}",
//   "birth_time": "{{contact.traits.user_birth_time}}",
//   "birth_place": "{{contact.traits.user_birth_place}}",
//   "plan": "{{contact.traits.getpredection}}"
// }
// ─────────────────────────────────────────────────────────────────────
app.post("/webhook-returning", async (req, res) => {
  try {
    const b = req.body;

    addLog("RETURNING_RECEIVED", { phone: b.phone, name: b.name, plan: b.plan });
    await logEvent("returning_received", b.phone, b.name, b.plan, "returning_received", b);

    const fullPhone  = (b.phone || "").toString().trim();
    const name       = b.name        || null;
    const birthDay   = b.dob_day     || null;
    const birthMonth = b.dob_month   || null;
    const birthYear  = b.dob_year    || null;
    const birthTime  = b.birth_time  || null;
    const birthPlace = b.birth_place || null;
    const planType   = b.plan        || null;

    const dob = (birthDay && birthMonth && birthYear)
      ? `${birthDay} ${birthMonth} ${birthYear}`
      : null;

    const { countryCode, phoneNumber } = splitPhone(fullPhone);

    if (!fullPhone) {
      addLog("RETURNING_ERROR", { reason: "missing phone" });
      return res.status(400).json({ status: "error", reason: "missing phone" });
    }

    if (!isValidPlan(planType)) {
      addLog("RETURNING_INVALID_PLAN", { planType });
      await logEvent("returning_invalid_plan", fullPhone, name, planType, "invalid_plan", b);
      return res.json({ status: "invalid_plan", planType });
    }

    // ── Fall back to DB if any trait missing ──────────────────────────
    let finalName       = name;
    let finalDob        = dob;
    let finalBirthTime  = birthTime;
    let finalBirthPlace = birthPlace;

    if (!finalName || !finalDob || !finalBirthTime || !finalBirthPlace) {
      try {
        const existing = await pool.query(`SELECT * FROM users WHERE phone = $1`, [fullPhone]);
        if (existing.rows.length > 0) {
          const u = existing.rows[0];
          finalName       = finalName       || u.name;
          finalDob        = finalDob        || u.dob;
          finalBirthTime  = finalBirthTime  || u.birth_time;
          finalBirthPlace = finalBirthPlace || u.birth_place;
          addLog("RETURNING_DB_FILL", {
            phone: fullPhone,
            filled: {
              name:       !name       && !!u.name,
              dob:        !dob        && !!u.dob,
              birthTime:  !birthTime  && !!u.birth_time,
              birthPlace: !birthPlace && !!u.birth_place
            }
          });
        }
      } catch (err) {
        addLog("RETURNING_DB_FILL_ERROR", { message: err.message });
      }
    }

    // ── Final validation ──────────────────────────────────────────────
    if (!finalName || !finalDob || !finalBirthTime || !finalBirthPlace) {
      addLog("RETURNING_MISSING_FIELDS", {
        name: !!finalName, dob: !!finalDob,
        birthTime: !!finalBirthTime, birthPlace: !!finalBirthPlace
      });
      await logEvent("returning_waiting", fullPhone, finalName, planType, "waiting", b);
      return res.json({ status: "waiting", reason: "incomplete user data" });
    }

    // ── Route ─────────────────────────────────────────────────────────
    const makeUrl = getMakeUrl(planType);
    if (!makeUrl) {
      addLog("RETURNING_NO_MAKE_URL", { planType });
      return res.json({ status: "no_make_url", planType });
    }

    // ── Save + Send ───────────────────────────────────────────────────
    await saveToDB({
      phone: fullPhone, name: finalName, dob: finalDob,
      birth_time: finalBirthTime, birth_place: finalBirthPlace,
      plan_type: planType, country_code: countryCode, phone_nocode: phoneNumber
    });

    const r = await axios.post(makeUrl, {
      phone_full: fullPhone, phone_number: phoneNumber, country_code: countryCode,
      name: finalName, dob: finalDob, birth_time: finalBirthTime,
      birth_place: finalBirthPlace, plan_type: planType
    }, { headers: { "Content-Type": "application/json" } });

    addLog("RETURNING_SENT_TO_MAKE", { plan: planType, phone_full: fullPhone, status: r.status });
    await logEvent("forwarded", fullPhone, finalName, planType, `forwarded_${planType.toLowerCase()}`, b);

    return res.json({ status: "ok", plan: planType });

  } catch (err) {
    addLog("RETURNING_ERROR", { message: err.message });
    return res.status(500).json({ status: "error", message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// GET /dashboard
// ─────────────────────────────────────────────────────────────────────
app.get("/dashboard", async (req, res) => {
  try {
    const events = await pool.query(`SELECT * FROM webhook_events ORDER BY received_at DESC LIMIT 200`);
    const stats = await pool.query(`
      SELECT
        COUNT(*)                                               AS total,
        COUNT(*) FILTER (WHERE status LIKE 'forwarded%')      AS forwarded,
        COUNT(*) FILTER (WHERE plan_type = 'Prediction')      AS prediction,
        COUNT(*) FILTER (WHERE plan_type = 'Ask')             AS ask,
        COUNT(*) FILTER (WHERE plan_type = 'Consult')         AS consult,
        COUNT(*) FILTER (WHERE status = 'waiting')            AS waiting,
        COUNT(*) FILTER (WHERE status = 'unknown_plan')       AS unknown,
        COUNT(*) FILTER (WHERE status = 'entry_button')       AS entry_button,
        COUNT(*) FILTER (WHERE status = 'returning_received') AS returning
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
          r.status?.includes("forwarded")   ? "success"   :
          r.status === "waiting"            ? "waiting"   :
          r.status === "entry_button"       ? "info"      :
          r.status === "returning_received" ? "returning" :
          r.status === "unknown_plan"       ? "error"     : "info"
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
    .stat.teal .num { color: #5eead4; }
    .stat.pink .num { color: #f9a8d4; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; padding: 10px 12px; background: #1a1a2e; color: #a78bfa; font-weight: 600; }
    td { padding: 10px 12px; border-bottom: 1px solid #1e1e2e; vertical-align: top; }
    tr:hover td { background: #1a1a2e; }
    .badge { padding: 3px 9px; border-radius: 20px; font-size: 11px; font-weight: 600; display: inline-block; }
    .success   { background: #14532d; color: #86efac; }
    .error     { background: #7f1d1d; color: #fca5a5; }
    .waiting   { background: #78350f; color: #fcd34d; }
    .info      { background: #1e3a5f; color: #93c5fd; }
    .returning { background: #3b1f6e; color: #d8b4fe; }
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
    <div class="stat pink"><div class="num">${s.returning}</div><div class="label">Returning Users</div></div>
    <div class="stat teal"><div class="num">${s.entry_button}</div><div class="label">Entry Taps</div></div>
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
        log.type.includes("ERROR")        ? "error"     :
        log.type.includes("SENT_TO_MAKE") ? "success"   :
        log.type.includes("DB_FILL")      ? "dbfill"    :
        log.type.includes("RETURNING")    ? "returning" :
        log.type.includes("ENTRY_BUTTON") ? "info"      :
        log.type.includes("WAITING") || log.type.includes("UNKNOWN") ? "waiting" : "info"
      }">${log.type}</span></td>
      <td><pre>${JSON.stringify(log.data, null, 2)}</pre></td>
    </tr>`).join("");

  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Astro Middleware v17</title>
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
    .error     { background: #7f1d1d; color: #fca5a5; }
    .success   { background: #14532d; color: #86efac; }
    .waiting   { background: #78350f; color: #fcd34d; }
    .info      { background: #1e3a5f; color: #93c5fd; }
    .dbfill    { background: #1a3a2e; color: #6ee7b7; }
    .returning { background: #3b1f6e; color: #d8b4fe; }
    .status    { color: #86efac; font-size: 13px; margin-bottom: 12px; }
  </style>
</head>
<body>
  <h1>🔮 Astro Middleware v17</h1>
  <p class="status">✅ Running — auto-refresh 5s | 🕐 Dubai Time (UTC+4) | ${logs.length} events</p>
  <div class="nav" style="margin-bottom:12px">
    <a href="/dashboard">📊 Dashboard</a>
    <a href="/">📋 Live Logs</a>
  </div>
  <div class="env-bar">${envBar}</div>
  <div class="flow-box">
    <b>New users</b>       → POST /webhook (Interakt workflow_response_update) ✅<br>
    <b>Returning users</b> → POST /webhook-returning (Interakt sends all traits) ✅<br>
    <b>DOB</b>             → built from day + month + year ✅<br>
    <b>Entry button</b>    → "Lets Start" ignored gracefully ✅<br>
    <b>DB fallback</b>     → both endpoints fall back to PostgreSQL if traits missing ✅<br>
    <b>Routing</b>         → Prediction→S1 | Ask→S3 | Consult→S4 ✅<br>
    <b>Make keys</b>       → phone_full + phone_number + country_code ✅<br>
    <b>DB</b>              → PostgreSQL upsert on phone ✅
  </div>
  <table>
    <thead><tr><th>Time (Dubai)</th><th>Type</th><th>Data</th></tr></thead>
    <tbody>${logRows || '<tr><td colspan="3" style="color:#888">No events yet.</td></tr>'}</tbody>
  </table>
</body>
</html>`);
});

// ── Boot ──────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Astro middleware v17 running on port ${PORT}`);
  });
}).catch(err => {
  console.error("❌ DB init failed:", err.message);
  process.exit(1);
});
