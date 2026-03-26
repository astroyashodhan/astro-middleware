const express = require("express");
const axios = require("axios");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

// ── Env vars ─────────────────────────────────────────────────────────
const MAKE_WEBHOOK_URL    = process.env.MAKE_WEBHOOK_URL;
const MAKE_WEBHOOK_URL_S5 = process.env.MAKE_WEBHOOK_URL_S5;
const MAKE_S1_INCOMING_MESSAGE = process.env.MAKE_S1_INCOMING_MESSAGE; // Make scenario that sends WhatsApp via Interakt
const GEMINI_API_KEY      = process.env.GEMINI_API_KEY;
const S5_WORKFLOW_ID      = process.env.S5_WORKFLOW_ID;
const S49_WORKFLOW_ID     = process.env.S49_WORKFLOW_ID;
const DATABASE_URL        = process.env.DATABASE_URL;
const PORT                = process.env.PORT || 8080;

const REASK_TIMEOUT_MS = 30 * 60 * 1000;

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

    CREATE TABLE IF NOT EXISTS reask_sessions (
      id SERIAL PRIMARY KEY,
      started_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      phone_full VARCHAR(30),
      customer_name VARCHAR(100),
      missing_fields TEXT[],
      fields_collected JSONB DEFAULT '{}',
      current_field VARCHAR(50),
      status VARCHAR(30) DEFAULT 'active',
      final_payload JSONB,
      messages JSONB DEFAULT '[]'
    );
  `);
  console.log("✅ Database tables ready");
}

// ── DB helpers ────────────────────────────────────────────────────────
async function logWebhookEvent(eventType, phoneFull, customerName, workflowId, status, rawPayload) {
  try {
    await pool.query(
      `INSERT INTO webhook_events (event_type, phone_full, customer_name, workflow_id, status, raw_payload)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [eventType, phoneFull || null, customerName || null, workflowId || null, status, JSON.stringify(rawPayload)]
    );
  } catch (err) {
    console.error("DB logWebhookEvent error:", err.message);
  }
}

async function createReaskSession(phoneFull, customerName, missingFields) {
  try {
    const result = await pool.query(
      `INSERT INTO reask_sessions (phone_full, customer_name, missing_fields, current_field)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [phoneFull, customerName, missingFields, missingFields[0]]
    );
    return result.rows[0].id;
  } catch (err) {
    console.error("DB createReaskSession error:", err.message);
    return null;
  }
}

async function updateReaskSession(phoneFull, updates) {
  try {
    const setClauses = [];
    const values = [];
    let i = 1;

    if (updates.fieldsCollected !== undefined) {
      setClauses.push(`fields_collected = $${i++}`);
      values.push(JSON.stringify(updates.fieldsCollected));
    }
    if (updates.currentField !== undefined) {
      setClauses.push(`current_field = $${i++}`);
      values.push(updates.currentField);
    }
    if (updates.status !== undefined) {
      setClauses.push(`status = $${i++}`);
      values.push(updates.status);
    }
    if (updates.finalPayload !== undefined) {
      setClauses.push(`final_payload = $${i++}`);
      values.push(JSON.stringify(updates.finalPayload));
    }
    if (updates.messages !== undefined) {
      setClauses.push(`messages = $${i++}`);
      values.push(JSON.stringify(updates.messages));
    }

    setClauses.push(`updated_at = NOW()`);
    values.push(phoneFull);

    await pool.query(
      `UPDATE reask_sessions SET ${setClauses.join(", ")}
       WHERE phone_full = $${i} AND status = 'active'`,
      values
    );
  } catch (err) {
    console.error("DB updateReaskSession error:", err.message);
  }
}

// ── In-memory logs ────────────────────────────────────────────────────
const logs = [];
const reaskedSessions = {};

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

function extractField(dataArray, traitName) {
  const items = dataArray.filter(
    (d) => d.question && d.question.user_trait_name === traitName
  );
  if (!items.length) return null;
  return items[items.length - 1].answer.message;
}

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

const MONTH_NAMES = {
  "1": "January", "2": "February", "3": "March", "4": "April",
  "5": "May", "6": "June", "7": "July", "8": "August",
  "9": "September", "10": "October", "11": "November", "12": "December"
};

const FIELD_LABELS = {
  name:       "full name",
  birthDay:   "birth day (number 1–31)",
  birthMonth: "birth month (number 1–12, e.g. 1 = January)",
  birthYear:  "birth year (e.g. 1990)",
  tob:        "time of birth (e.g. 14:30 or 2:30 PM)",
  birthPlace: "place of birth (city and country)",
  topic:      "prediction topic — one of: Money, Career, Love, Today's Energy"
};

// ── Gemini ────────────────────────────────────────────────────────────
async function gemini(prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_API_KEY}`;
  const response = await axios.post(
    url,
    { contents: [{ parts: [{ text: prompt }] }] },
    { headers: { "Content-Type": "application/json" } }
  );
  return response.data.candidates[0].content.parts[0].text.trim();
}

async function generateReaskMessage(userName, fieldKey, isFirst, collectedCount) {
  return await gemini(isFirst
    ? `You are Jyotish Acharya Yashodhan, a warm Vedic astrology assistant on WhatsApp.
The user ${userName} got stuck while entering their birth details. Kindly take over and ask them for their ${FIELD_LABELS[fieldKey]}.
Short WhatsApp message (max 3 lines). Brief warm apology. 1 emoji max. Never mention errors, AI, or systems.`
    : `You are Jyotish Acharya Yashodhan on WhatsApp. User has provided ${collectedCount} detail(s).
Now ask for their ${FIELD_LABELS[fieldKey]}. Short and conversational (max 2 lines). 1 emoji max.`
  );
}

async function parseReply(fieldKey, replyText) {
  const raw = await gemini(
    `Parse a WhatsApp reply for field: ${FIELD_LABELS[fieldKey]}.
User replied: "${replyText}"
Return ONLY raw JSON (no markdown): {"valid":bool,"value":string|null,"error":string|null}
Rules:
- full name: min 2 chars, return as-is
- birth day: 1–31, return as string e.g. "15"
- birth month: accept month names or numbers 1–12, return number string e.g. "3"
- birth year: 1935–2006, return 4-digit string
- time of birth: normalise to HH:MM 24hr if possible, else as-is
- place of birth: min 2 chars, as-is
- topic: Money/Career/Love/Today's Energy or 1-4, return topic name`
  );
  try {
    return JSON.parse(raw.replace(/```json|```/g, "").trim());
  } catch {
    return { valid: true, value: replyText.trim(), error: null };
  }
}

async function generateCorrectionMessage(fieldKey, errorMsg) {
  return await gemini(
    `You are Jyotish Acharya Yashodhan on WhatsApp.
User gave invalid answer for ${FIELD_LABELS[fieldKey]}. Error: ${errorMsg}
Very short warm correction (max 2 lines), ask to try again. 1 emoji max.`
  );
}

async function generateConfirmationMessage(userName) {
  return await gemini(
    `You are Jyotish Acharya Yashodhan on WhatsApp.
${userName} just finished providing birth details.
Warm short confirmation (max 2 lines) — reading will be ready shortly. 1 emoji.`
  );
}

// ── Interakt ──────────────────────────────────────────────────────────
async function sendInteraktMessage(phoneNumber, countryCode, message) {
  // Send via Make.com which handles Interakt WhatsApp delivery
  await axios.post(
    MAKE_S1_INCOMING_MESSAGE,
    {
      phone_full: `${countryCode}${phoneNumber}`,
      country_code: countryCode,
      phone: phoneNumber,
      message
    },
    { headers: { "Content-Type": "application/json" } }
  );
}

// ── Re-ask session management ─────────────────────────────────────────
async function startReaskSession(phone_full, partialData, missingFields) {
  clearReaskSession(phone_full);

  const { countryCode, phoneNumber } = splitPhone(phone_full);
  const userName = partialData.name || "there";

  const dbId = await createReaskSession(phone_full, userName, missingFields);

  const session = {
    dbId,
    missingFields,
    fieldIndex: 0,
    collected: {},
    partialData,
    phone_full,
    countryCode,
    phoneNumber,
    userName,
    messages: [],
    expiresAt: Date.now() + REASK_TIMEOUT_MS,
    timerRef: setTimeout(async () => {
      addLog("REASK_EXPIRED", { phone_full });
      await updateReaskSession(phone_full, { status: "expired" });
      clearReaskSession(phone_full);
    }, REASK_TIMEOUT_MS)
  };

  reaskedSessions[phone_full] = session;
  addLog("REASK_STARTED", { phone_full, userName, missingFields });

  const firstField = missingFields[0];
  const message = await generateReaskMessage(userName, firstField, true, 0);
  try {
    await sendInteraktMessage(phoneNumber, countryCode, message);
    session.messages.push({ direction: "out", field: firstField, message, time: getDubaiTime() });
    await updateReaskSession(phone_full, { currentField: firstField, messages: session.messages });
    addLog("REASK_SENT_Q", { phone_full, field: firstField, message });
  } catch (err) {
    addLog("REASK_SEND_FAILED", { phone_full, message: err.message });
    await updateReaskSession(phone_full, { status: "failed" });
    clearReaskSession(phone_full);
  }
}

function clearReaskSession(phone_full) {
  if (reaskedSessions[phone_full]) {
    clearTimeout(reaskedSessions[phone_full].timerRef);
    delete reaskedSessions[phone_full];
  }
}

async function processReaskReply(phone_full, replyText) {
  const session = reaskedSessions[phone_full];
  if (!session) return false;

  // Guard: if session has expired in memory, ignore
  if (Date.now() > session.expiresAt) {
    addLog("REASK_REPLY_IGNORED", { phone_full, reason: "Session expired" });
    clearReaskSession(phone_full);
    return false;
  }

  const currentField = session.missingFields[session.fieldIndex];

  session.messages.push({ direction: "in", field: currentField, message: replyText, time: getDubaiTime() });
  addLog("REASK_PARSING", { phone_full, field: currentField, reply: replyText });

  const parsed = await parseReply(currentField, replyText);
  addLog("REASK_PARSED", { phone_full, field: currentField, result: parsed });

  if (!parsed.valid) {
    const msg = await generateCorrectionMessage(currentField, parsed.error);
    try {
      await sendInteraktMessage(session.phoneNumber, session.countryCode, msg);
      session.messages.push({ direction: "out", field: currentField, message: msg, time: getDubaiTime() });
      await updateReaskSession(phone_full, { messages: session.messages });
      addLog("REASK_CORRECTION_SENT", { phone_full, field: currentField });
    } catch (err) {
      addLog("REASK_SEND_FAILED", { phone_full, message: err.message });
      await updateReaskSession(phone_full, { status: "failed" });
      clearReaskSession(phone_full);
    }
    return true;
  }

  session.collected[currentField] = parsed.value;
  session.fieldIndex++;

  await updateReaskSession(phone_full, {
    fieldsCollected: session.collected,
    currentField: session.missingFields[session.fieldIndex] || null,
    messages: session.messages
  });

  addLog("REASK_FIELD_SAVED", { phone_full, field: currentField, value: parsed.value });

  if (session.fieldIndex < session.missingFields.length) {
    const nextField = session.missingFields[session.fieldIndex];
    const msg = await generateReaskMessage(session.userName, nextField, false, session.fieldIndex);
    try {
      await sendInteraktMessage(session.phoneNumber, session.countryCode, msg);
      session.messages.push({ direction: "out", field: nextField, message: msg, time: getDubaiTime() });
      await updateReaskSession(phone_full, { messages: session.messages });
      addLog("REASK_SENT_Q", { phone_full, field: nextField });
    } catch (err) {
      addLog("REASK_SEND_FAILED", { phone_full, message: err.message });
      await updateReaskSession(phone_full, { status: "failed" });
      clearReaskSession(phone_full);
    }
  } else {
    await completeReaskSession(session);
  }

  return true;
}

async function completeReaskSession(session) {
  const { phone_full, collected, partialData, phoneNumber, countryCode, userName } = session;

  const merged = { ...partialData };
  if (collected.name)       merged.name        = collected.name;
  if (collected.tob)        merged.tob         = collected.tob;
  if (collected.birthPlace) merged.birth_place = collected.birthPlace;
  if (collected.topic)      merged.topic       = collected.topic;

  const day   = collected.birthDay   || partialData.birthDay;
  const month = collected.birthMonth || partialData.birthMonth;
  const year  = collected.birthYear  || partialData.birthYear;
  if (day && month && year) {
    merged.dob = `${day} ${MONTH_NAMES[month] || month} ${year}`;
  }
  delete merged.birthDay;
  delete merged.birthMonth;
  delete merged.birthYear;
  merged.fix_source = "gemini_reask";
  merged.fixed_at   = getDubaiTime();

  addLog("REASK_COMPLETE", { phone_full, merged });

  try {
    await axios.post(MAKE_WEBHOOK_URL, merged, { headers: { "Content-Type": "application/json" } });
    addLog("REASK_FORWARDED_TO_MAKE", { phone_full });

    await updateReaskSession(phone_full, {
      status: "completed",
      finalPayload: merged,
      messages: session.messages
    });

    const confirmMsg = await generateConfirmationMessage(userName);
    await sendInteraktMessage(phoneNumber, countryCode, confirmMsg);
    addLog("REASK_CONFIRMED_USER", { phone_full, message: confirmMsg });
  } catch (err) {
    addLog("REASK_FORWARD_ERROR", { phone_full, message: err.message });
    await updateReaskSession(phone_full, { status: "failed" });
  }

  clearReaskSession(phone_full);
}

// ─────────────────────────────────────────────────────────────────────
// POST /webhook
// ─────────────────────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;
    const incomingPhone = body.data?.customer_number || body.data?.phone || null;

    // ── Active re-ask session reply ───────────────────────────────────
    if (incomingPhone && reaskedSessions[incomingPhone]) {
      const replyText =
        body.data?.trigger_message?.message ||
        body.data?.message ||
        body.message || "";
      addLog("REASK_REPLY_RECEIVED", { phone: incomingPhone, reply: replyText });
      await logWebhookEvent("reask_reply", incomingPhone, body.data?.customer_name, null, "reask_reply", body);
      const handled = await processReaskReply(incomingPhone, replyText);
      if (handled) return res.status(200).json({ status: "reask_processed" });
    }

    // Log all incoming events to DB
    await logWebhookEvent(
      body.type || "unknown",
      incomingPhone,
      body.data?.customer_name,
      body.data?.workflow_id,
      "received",
      body
    );

    addLog("RECEIVED", {
      type: body.type,
      workflow_id: body.data?.workflow_id,
      customer: body.data?.customer_name
    });

    if (body.type !== "workflow_response_update") {
      addLog("IGNORED", { reason: "Not workflow_response_update" });
      await logWebhookEvent(body.type, incomingPhone, body.data?.customer_name, null, "ignored", body);
      return res.status(200).json({ status: "ignored" });
    }

    const data = body.data;
    const workflowId = data.workflow_id || "";
    const fullPhone = data.customer_number || "";

    // ── S49: ignore ───────────────────────────────────────────────────
    if (workflowId === S49_WORKFLOW_ID) {
      addLog("S49_IGNORED", { workflow_id: workflowId });
      await logWebhookEvent("s49", fullPhone, data.customer_name, workflowId, "ignored_s49", body);
      return res.status(200).json({ status: "ignored_s49" });
    }

    // ── S5: phone only → Make S5 ──────────────────────────────────────
    if (workflowId === S5_WORKFLOW_ID) {
      if (!fullPhone) return res.status(200).json({ status: "no_phone" });
      const dataArray = data.data || [];
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
      await logWebhookEvent("s5_ask", fullPhone, data.customer_name, workflowId, "forwarded_s5", body);
      const r = await axios.post(MAKE_WEBHOOK_URL_S5, makePayload, { headers: { "Content-Type": "application/json" } });
      addLog("S5_MAKE_RESPONSE", { status: r.status });
      return res.status(200).json({ status: "success_s5" });
    }

    // ── S1: 7 fields ──────────────────────────────────────────────────
    const dataArray = data.data || [];
    const name       = extractField(dataArray, "name");
    const birthDay   = extractField(dataArray, "user_birth_day");
    const birthMonth = extractField(dataArray, "user_birth_month");
    const birthYear  = extractField(dataArray, "user_birth_year");
    const tob        = extractField(dataArray, "user_birth_time");
    const birthPlace = extractField(dataArray, "user_birth_place");
    const topicRaw   = extractField(dataArray, "prediction_choice");
    const TOPIC_MAP  = { "1": "Money", "2": "Career", "3": "Love", "4": "Today\'s Energy" };
    const topic      = TOPIC_MAP[topicRaw] || topicRaw;

    const collected = { name, birthDay, birthMonth, birthYear, tob, birthPlace, topic };
    const missingFields = Object.entries(collected).filter(([, v]) => !v).map(([k]) => k);
    const collectedCount = 7 - missingFields.length;

    // ── All 7 fields → forward to Make ───────────────────────────────
    if (missingFields.length === 0) {
      const yearNum = parseInt(birthYear, 10);
      if (isNaN(yearNum) || yearNum < 1935 || yearNum > 2026) {
        addLog("S1_INVALID_YEAR", { birthYear });
        return res.status(200).json({ status: "invalid_year" });
      }
      const dob = `${birthDay} ${MONTH_NAMES[birthMonth] || birthMonth} ${birthYear}`;
      const { countryCode, phoneNumber } = splitPhone(fullPhone);
      const makePayload = {
        name, dob, birth_place: birthPlace, tob, topic,
        country_code: countryCode, phone: phoneNumber, phone_full: fullPhone
      };
      addLog("S1_FORWARDED_TO_MAKE", makePayload);
      await logWebhookEvent("s1_complete", fullPhone, name, workflowId, "forwarded_s1", body);
      const r = await axios.post(MAKE_WEBHOOK_URL, makePayload, { headers: { "Content-Type": "application/json" } });
      addLog("S1_MAKE_RESPONSE", { status: r.status });
      return res.status(200).json({ status: "success_s1" });
    }

    // ── Partial fields → user stuck → Gemini takes over (only if 3+ fields collected) ──
    if (collectedCount >= 3 && fullPhone) {
      if (reaskedSessions[fullPhone]) {
        addLog("S1_WAITING", { reason: "Gemini session already active" });
        return res.status(200).json({ status: "reask_active" });
      }
      addLog("S1_USER_STUCK", { phone: fullPhone, collected: collectedCount, missing: missingFields });
      await logWebhookEvent("s1_stuck", fullPhone, name, workflowId, "gemini_reask_started", body);

      const { countryCode, phoneNumber } = splitPhone(fullPhone);
      const partialData = {
        name: name || null,
        birthDay: birthDay || null,
        birthMonth: birthMonth || null,
        birthYear: birthYear || null,
        tob: tob || null,
        birth_place: birthPlace || null,
        topic: topic || null,
        phone: phoneNumber,
        country_code: countryCode,
        phone_full: fullPhone
      };
      await startReaskSession(fullPhone, partialData, missingFields);
      return res.status(200).json({ status: "gemini_reask_started", missing: missingFields });
    }

    // ── Nothing collected yet → normal wait ──────────────────────────
    addLog("S1_WAITING", { reason: "No fields yet", collected: collectedCount });
    return res.status(200).json({ status: "waiting" });

  } catch (err) {
    addLog("ERROR", { message: err.message });
    return res.status(500).json({ status: "error", message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// GET /dashboard — User overview
// ─────────────────────────────────────────────────────────────────────
app.get("/dashboard", async (req, res) => {
  try {
    const events = await pool.query(`
      SELECT * FROM webhook_events
      ORDER BY received_at DESC LIMIT 200
    `);

    const sessions = await pool.query(`
      SELECT * FROM reask_sessions
      ORDER BY started_at DESC LIMIT 100
    `);

    const stats = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE event_type = 's1_complete') AS s1_complete,
        COUNT(*) FILTER (WHERE event_type = 's1_stuck')    AS s1_stuck,
        COUNT(*) FILTER (WHERE event_type = 's5_ask')      AS s5_ask,
        COUNT(*) FILTER (WHERE status = 'ignored_s49')     AS s49_ignored,
        COUNT(*)                                            AS total
      FROM webhook_events
    `);

    const s = stats.rows[0];

    const sessionRows = sessions.rows.map(r => `
      <tr>
        <td>${new Date(r.started_at).toLocaleString("en-GB", { timeZone: "Asia/Dubai" })}</td>
        <td>${r.phone_full || "—"}</td>
        <td>${r.customer_name || "—"}</td>
        <td>${(r.missing_fields || []).join(", ")}</td>
        <td>${JSON.stringify(r.fields_collected || {})}</td>
        <td><span class="badge ${
          r.status === "completed" ? "success" :
          r.status === "failed" || r.status === "expired" ? "error" : "info"
        }">${r.status}</span></td>
        <td>${new Date(r.updated_at).toLocaleString("en-GB", { timeZone: "Asia/Dubai" })}</td>
      </tr>`).join("");

    const eventRows = events.rows.map(r => `
      <tr>
        <td>${new Date(r.received_at).toLocaleString("en-GB", { timeZone: "Asia/Dubai" })}</td>
        <td>${r.phone_full || "—"}</td>
        <td>${r.customer_name || "—"}</td>
        <td><span class="badge ${
          r.status === "forwarded_s1" || r.status === "forwarded_s5" ? "success" :
          r.status === "ignored_s49" || r.status === "ignored" ? "waiting" :
          r.status === "gemini_reask_started" ? "info" : "info"
        }">${r.event_type}</span></td>
        <td>${r.status}</td>
      </tr>`).join("");

    res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Astro Dashboard</title>
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
    table { width: 100%; border-collapse: collapse; margin-bottom: 32px; font-size: 13px; }
    th { text-align: left; padding: 10px 12px; background: #1a1a2e; color: #a78bfa; font-weight: 600; }
    td { padding: 10px 12px; border-bottom: 1px solid #1e1e2e; vertical-align: top; }
    tr:hover td { background: #1a1a2e; }
    .badge { padding: 3px 9px; border-radius: 20px; font-size: 11px; font-weight: 600; display: inline-block; }
    .success { background: #14532d; color: #86efac; }
    .error   { background: #7f1d1d; color: #fca5a5; }
    .waiting { background: #78350f; color: #fcd34d; }
    .info    { background: #1e3a5f; color: #93c5fd; }
    .nav { margin-bottom: 20px; }
    .nav a { color: #a78bfa; text-decoration: none; margin-right: 20px; font-size: 13px; }
    .nav a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <h1>🔮 Astro Yashodhan — Dashboard</h1>
  <p class="subtitle">Auto-refreshes every 15s · Dubai Time (UTC+4)</p>
  <div class="nav">
    <a href="/dashboard">📊 Dashboard</a>
    <a href="/">📋 Live Logs</a>
  </div>

  <div class="stats">
    <div class="stat"><div class="num">${s.total}</div><div class="label">Total Events</div></div>
    <div class="stat green"><div class="num">${s.s1_complete}</div><div class="label">S1 Completed</div></div>
    <div class="stat red"><div class="num">${s.s1_stuck}</div><div class="label">Users Stuck</div></div>
    <div class="stat blue"><div class="num">${s.s5_ask}</div><div class="label">S5 ASK Triggers</div></div>
    <div class="stat yellow"><div class="num">${s.s49_ignored}</div><div class="label">S49 Ignored</div></div>
  </div>

  <h2>🔄 Re-ask Sessions</h2>
  <table>
    <thead><tr><th>Started</th><th>Phone</th><th>Name</th><th>Missing Fields</th><th>Collected</th><th>Status</th><th>Updated</th></tr></thead>
    <tbody>${sessionRows || '<tr><td colspan="7" style="color:#555;text-align:center">No sessions yet</td></tr>'}</tbody>
  </table>

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
    MAKE_S1_INCOMING_MESSAGE: !!MAKE_S1_INCOMING_MESSAGE,
    GEMINI_API_KEY:      !!GEMINI_API_KEY,
    DATABASE_URL:        !!DATABASE_URL,
    S5_WORKFLOW_ID:      !!S5_WORKFLOW_ID,
    S49_WORKFLOW_ID:     !!S49_WORKFLOW_ID
  };

  const envBar = Object.entries(envVars)
    .map(([k, v]) => `<span style="color:${v ? "#86efac" : "#fca5a5"}">${v ? "✅" : "⚠️"} ${k}</span>`)
    .join(" &nbsp; ");

  const activeSessions = Object.keys(reaskedSessions).length;

  const logRows = logs.map(log => `
    <tr>
      <td>${log.time}</td>
      <td><span class="badge ${
        log.type.includes("ERROR") || log.type.includes("EXPIRED") ? "error" :
        log.type.includes("FORWARDED") || log.type.includes("COMPLETE") || log.type.includes("CONFIRMED") || log.type.includes("SAVED") ? "success" :
        log.type.includes("WAITING") || log.type.includes("IGNORED") || log.type.includes("STUCK") ? "waiting" : "info"
      }">${log.type}</span></td>
      <td><pre>${JSON.stringify(log.data, null, 2)}</pre></td>
    </tr>`).join("");

  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Astro Middleware v10</title>
  <meta http-equiv="refresh" content="5">
  <style>
    body { font-family: monospace; background: #0f0f0f; color: #e0e0e0; padding: 20px; }
    h1 { color: #a78bfa; margin-bottom: 4px; }
    h3 { color: #a78bfa; margin: 20px 0 8px; }
    .env-bar { background: #1a1a2e; padding: 12px 16px; border-radius: 6px; margin-bottom: 12px; font-size: 11px; line-height: 2.4; }
    .flow-box { background: #111827; border-left: 3px solid #a78bfa; padding: 10px 14px; border-radius: 4px; margin-bottom: 16px; font-size: 11px; color: #94a3b8; line-height: 2; }
    .flow-box b { color: #e2e8f0; }
    .nav { margin-bottom: 16px; }
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
  <h1>🔮 Astro Middleware v10</h1>
  <p class="status">✅ Running — auto-refresh 5s | 🕐 Dubai Time | ${logs.length} events | ${activeSessions} active Gemini session(s)</p>
  <div class="nav"><a href="/dashboard">📊 User Dashboard</a><a href="/">📋 Live Logs</a></div>
  <div class="env-bar">${envBar}</div>
  <div class="flow-box">
    <b>S1 happy path</b> → all 7 fields → Make S1 ✅<br>
    <b>S1 stuck user</b> → partial fields → Gemini WhatsApp re-ask → collect missing → Make S1 ✅<br>
    <b>S5</b> → ASK button → phone → Make S5 | <b>S49</b> → ignored | <b>DB</b> → PostgreSQL ✅
  </div>
  <h3>📋 Live Event Log</h3>
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
    console.log(`🚀 Astro middleware v10 running on port ${PORT}`);
  });
}).catch(err => {
  console.error("❌ DB init failed:", err.message);
  process.exit(1);
});
