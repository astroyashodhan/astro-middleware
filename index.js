const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// S1 — Free prediction (fallback for new users)
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;

// S5 — ASK Gatekeeper ₹299 (paid/returning users)
const MAKE_S5_WEBHOOK_URL = process.env.MAKE_S5_WEBHOOK_URL;

const PORT = process.env.PORT || 8080;

const logs = [];

function addLog(type, data) {
  logs.unshift({ time: new Date().toISOString(), type, data });
  if (logs.length > 20) logs.pop();
}

function extractField(dataArray, traitName) {
  const item = dataArray.find(
    (d) => d.question && d.question.user_trait_name === traitName
  );
  return item ? item.answer.message : null;
}

// ── Detect if this is a returning/paid user message ───────────────────────────
// When user_trait_name is null on ALL items, Interakt is NOT collecting fields.
// This means the user is an existing user responding to a prompt (e.g. "Call astr").
// In this case, skip field collection and forward straight to S5.
function isReturningUser(dataArray) {
  if (!dataArray || dataArray.length === 0) return false;
  return dataArray.every(
    (d) => !d.question || d.question.user_trait_name === null
  );
}

app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;
    addLog("RECEIVED", body);

    if (body.type !== "workflow_response_update") {
      addLog("IGNORED", { reason: "Not workflow_response_update", type: body.type });
      return res.status(200).json({ status: "ignored" });
    }

    const data = body.data;
    const dataArray = data.data || [];
    const fullPhone = data.customer_number || "";
    const customerName = data.customer_name || "";

    // ── RETURNING USER DETECTED (user_trait_name is null) ─────────────────────
    // Forward straight to S5 with phone + their answer message
    if (isReturningUser(dataArray)) {
      const userAnswer = dataArray[0]?.answer?.message || "";
      const stepMessage = dataArray[0]?.question?.message || "";

      const s5Payload = {
        phone_full: fullPhone,
        customer_name: customerName,
        user_message: userAnswer,
        step_message: stepMessage,
        is_returning: true
      };

      addLog("RETURNING_USER_DETECTED", {
        phone: fullPhone,
        name: customerName,
        answer: userAnswer
      });

      if (MAKE_S5_WEBHOOK_URL) {
        const s5Response = await axios.post(MAKE_S5_WEBHOOK_URL, s5Payload, {
          headers: { "Content-Type": "application/json" }
        });
        addLog("FORWARDED_TO_S5", { status: s5Response.status, payload: s5Payload });
        return res.status(200).json({ status: "success_s5_returning", forwarded: s5Payload });
      }

      addLog("S5_NOT_SET", { warning: "MAKE_S5_WEBHOOK_URL not configured" });
      return res.status(200).json({ status: "s5_not_configured" });
    }

    // ── NEW USER — collect birth detail fields ─────────────────────────────────
    const name       = extractField(dataArray, "name");
    const birthDay   = extractField(dataArray, "user_birth_day");
    const birthMonth = extractField(dataArray, "user_birth_month");
    const birthYear  = extractField(dataArray, "user_birth_year");
    const tob        = extractField(dataArray, "user_birth_time");
    const birthPlace = extractField(dataArray, "user_birth_place");
    const topic      = extractField(dataArray, "prediction_choice");

    if (!name || !birthDay || !birthMonth || !birthYear || !tob || !birthPlace || !topic) {
      addLog("WAITING", {
        reason: "Not all fields collected yet",
        collected: {
          name: !!name, birthDay: !!birthDay, birthMonth: !!birthMonth,
          birthYear: !!birthYear, tob: !!tob, birthPlace: !!birthPlace, topic: !!topic
        }
      });
      return res.status(200).json({ status: "waiting" });
    }

    const monthNames = {
      "1": "January", "2": "February", "3": "March", "4": "April",
      "5": "May", "6": "June", "7": "July", "8": "August",
      "9": "September", "10": "October", "11": "November", "12": "December"
    };
    const dob = `${birthDay} ${monthNames[birthMonth] || birthMonth} ${birthYear}`;

    const COUNTRY_CODES = [
      "+1242","+1246","+1264","+1268","+1284","+1340","+1345","+1441","+1473",
      "+1649","+1664","+1670","+1671","+1684","+1758","+1767","+1784","+1809",
      "+1868","+1869","+1876","+1939","+355","+213","+376","+244","+374","+994",
      "+973","+880","+375","+501","+229","+975","+591","+387","+267","+673",
      "+359","+226","+257","+855","+237","+238","+236","+235","+269","+242",
      "+506","+385","+357","+420","+253","+593","+503","+372","+251","+679",
      "+358","+241","+220","+995","+233","+502","+224","+592","+509","+504",
      "+852","+354","+353","+972","+962","+996","+856","+371","+961","+266",
      "+231","+218","+370","+352","+853","+261","+265","+960","+223","+456",
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

    let countryCode = "";
    let phoneNumber = fullPhone;
    for (const code of COUNTRY_CODES) {
      if (fullPhone.startsWith(code)) {
        countryCode = code;
        phoneNumber = fullPhone.slice(code.length);
        break;
      }
    }

    const makePayload = {
      name, dob, birth_place: birthPlace, tob, topic,
      country_code: countryCode,
      phone: phoneNumber,
      phone_full: fullPhone,
      is_returning: false
    };

    // New users with all fields → S1 (free prediction flow)
    addLog("FORWARDED_TO_MAKE", makePayload);
    const makeResponse = await axios.post(MAKE_WEBHOOK_URL, makePayload, {
      headers: { "Content-Type": "application/json" }
    });
    addLog("MAKE_RESPONSE", { status: makeResponse.status });
    return res.status(200).json({ status: "success", forwarded: makePayload });

  } catch (err) {
    addLog("ERROR", { message: err.message });
    return res.status(500).json({ status: "error", message: err.message });
  }
});

app.get("/", (req, res) => {
  const rows = logs.map(log => `
    <tr>
      <td>${log.time}</td>
      <td><span class="badge ${
        log.type === "ERROR"                  ? "error"    :
        log.type === "FORWARDED_TO_S5"        ? "s5"       :
        log.type === "RETURNING_USER_DETECTED"? "s5"       :
        log.type === "FORWARDED_TO_MAKE"      ? "success"  :
        log.type === "WAITING"                ? "waiting"  :
        log.type === "S5_NOT_SET"             ? "error"    :
        "info"
      }">${log.type}</span></td>
      <td><pre>${JSON.stringify(log.data, null, 2)}</pre></td>
    </tr>
  `).join("");

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Astro Middleware — Live Logs</title>
      <meta http-equiv="refresh" content="5">
      <style>
        body { font-family: monospace; background: #0f0f0f; color: #e0e0e0; padding: 20px; }
        h1 { color: #a78bfa; }
        p { color: #888; font-size: 13px; }
        table { width: 100%; border-collapse: collapse; }
        th { text-align: left; padding: 10px; background: #1a1a2e; color: #a78bfa; }
        td { padding: 10px; border-bottom: 1px solid #222; vertical-align: top; font-size: 12px; }
        pre { margin: 0; white-space: pre-wrap; word-break: break-all; max-width: 700px; }
        .badge { padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: bold; }
        .error   { background: #7f1d1d; color: #fca5a5; }
        .success { background: #14532d; color: #86efac; }
        .s5      { background: #4c1d95; color: #c4b5fd; }
        .waiting { background: #78350f; color: #fcd34d; }
        .info    { background: #1e3a5f; color: #93c5fd; }
        .status  { color: #86efac; font-size: 13px; margin-bottom: 20px; }
        .config  { background: #1a1a2e; padding: 10px 16px; border-radius: 8px; margin-bottom: 20px; font-size: 12px; }
        .config span { color: #a78bfa; font-weight: bold; }
      </style>
    </head>
    <body>
      <h1>🔮 Astro Middleware — Live Logs</h1>
      <p class="status">✅ Server running — auto-refreshes every 5 seconds</p>
      <div class="config">
        <span>S1 Webhook:</span> ${MAKE_WEBHOOK_URL ? '✅ Set (new users)' : '❌ Not set'} &nbsp;&nbsp;
        <span>S5 Webhook:</span> ${MAKE_S5_WEBHOOK_URL ? '✅ Set (returning/paid users)' : '⚠️ Not set'}
      </div>
      <p>Showing last ${logs.length} events</p>
      <table>
        <thead><tr><th>Time</th><th>Type</th><th>Data</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="3" style="color:#888">No events yet. Waiting for Interakt webhook...</td></tr>'}</tbody>
      </table>
    </body>
    </html>
  `);
});

app.listen(PORT, () => {
  console.log(`🚀 Astro middleware running on port ${PORT}`);
});
