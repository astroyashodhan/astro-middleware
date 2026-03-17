const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const MAKE_WEBHOOK_URL     = process.env.MAKE_WEBHOOK_URL;      // S1 — new users
const MAKE_WEBHOOK_URL_S5  = process.env.MAKE_WEBHOOK_URL_S5;   // S5 — existing paid users
const PORT = process.env.PORT || 8080;

const logs = [];

function addLog(type, data) {
  logs.unshift({ time: getDubaiTime(), type, data });
  if (logs.length > 50) logs.pop();
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

// ─────────────────────────────────────────────
// S1 — New users (collects all 7 birth fields)
// Interakt webhook URL: https://your-railway-app.up.railway.app/webhook
// ─────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;
    addLog("S1_RECEIVED", body);

    if (body.type !== "workflow_response_update") {
      addLog("S1_IGNORED", { reason: "Not workflow_response_update", type: body.type });
      return res.status(200).json({ status: "ignored" });
    }

    const data = body.data;
    const dataArray = data.data || [];

    const name       = extractField(dataArray, "name");
    const birthDay   = extractField(dataArray, "user_birth_day");
    const birthMonth = extractField(dataArray, "user_birth_month");
    const birthYear  = extractField(dataArray, "user_birth_year");
    const tob        = extractField(dataArray, "user_birth_time");
    const birthPlace = extractField(dataArray, "user_birth_place");
    const topic      = extractField(dataArray, "prediction_choice");

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
      addLog("S1_INVALID_YEAR", { birthYear, reason: "Must be between 1935 and 2026" });
      return res.status(200).json({ status: "invalid_year", birthYear });
    }

    const monthNames = {
      "1": "January", "2": "February", "3": "March", "4": "April",
      "5": "May", "6": "June", "7": "July", "8": "August",
      "9": "September", "10": "October", "11": "November", "12": "December"
    };
    const dob = `${birthDay} ${monthNames[birthMonth] || birthMonth} ${birthYear}`;

    const fullPhone = data.customer_number || "";
    const { countryCode, phoneNumber } = splitPhone(fullPhone);

    const makePayload = {
      name, dob, birth_place: birthPlace, tob, topic,
      country_code: countryCode,
      phone: phoneNumber,
      phone_full: fullPhone
    };

    addLog("S1_FORWARDED_TO_MAKE", makePayload);
    const makeResponse = await axios.post(MAKE_WEBHOOK_URL, makePayload, {
      headers: { "Content-Type": "application/json" }
    });

    addLog("S1_MAKE_RESPONSE", { status: makeResponse.status });
    return res.status(200).json({ status: "success", forwarded: makePayload });

  } catch (err) {
    addLog("S1_ERROR", { message: err.message });
    return res.status(500).json({ status: "error", message: err.message });
  }
});

// ─────────────────────────────────────────────
// S5 — Existing paid users (₹299 Ask a Question)
// Only sends phone number — Make looks up stored data
// Interakt webhook URL: https://your-railway-app.up.railway.app/webhook-s5
// ─────────────────────────────────────────────
app.post("/webhook-s5", async (req, res) => {
  try {
    const body = req.body;
    addLog("S5_RECEIVED", body);

    if (body.type !== "workflow_response_update") {
      addLog("S5_IGNORED", { reason: "Not workflow_response_update", type: body.type });
      return res.status(200).json({ status: "ignored" });
    }

    const data = body.data;
    const fullPhone = data.customer_number || "";

    if (!fullPhone) {
      addLog("S5_NO_PHONE", { reason: "customer_number missing from payload" });
      return res.status(200).json({ status: "no_phone" });
    }

    const { countryCode, phoneNumber } = splitPhone(fullPhone);

    const makePayload = {
      country_code: countryCode,
      phone: phoneNumber,
      phone_full: fullPhone
    };

    addLog("S5_FORWARDED_TO_MAKE", makePayload);
    const makeResponse = await axios.post(MAKE_WEBHOOK_URL_S5, makePayload, {
      headers: { "Content-Type": "application/json" }
    });

    addLog("S5_MAKE_RESPONSE", { status: makeResponse.status });
    return res.status(200).json({ status: "success", forwarded: makePayload });

  } catch (err) {
    addLog("S5_ERROR", { message: err.message });
    return res.status(500).json({ status: "error", message: err.message });
  }
});

// ─────────────────────────────────────────────
// Dashboard
// ─────────────────────────────────────────────
app.get("/", (req, res) => {
  const rows = logs.map(log => `
    <tr>
      <td>${log.time}</td>
      <td><span class="badge ${
        log.type.includes("ERROR")    ? "error"   :
        log.type.includes("FORWARDED") ? "success" :
        log.type.includes("WAITING") || log.type.includes("INVALID") ? "waiting" : "info"
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
        .endpoints { background: #1a1a2e; padding: 12px 16px; border-radius: 6px; margin-bottom: 20px; font-size: 12px; line-height: 2; }
        .endpoints span { color: #a78bfa; font-weight: bold; }
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
      <h1>🔮 Astro Middleware — Live Logs</h1>
      <p class="status">✅ Server running — auto-refreshes every 5 seconds | 🕐 Dubai Time (UTC+4)</p>
      <div class="endpoints">
        <span>S1</span> (New users — all 7 fields) → POST /webhook<br>
        <span>S5</span> (Existing paid users ₹299) → POST /webhook-s5
      </div>
      <p>Showing last ${logs.length} events</p>
      <table>
        <thead><tr><th>Time (Dubai)</th><th>Type</th><th>Data</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="3" style="color:#888">No events yet. Waiting for Interakt webhooks...</td></tr>'}</tbody>
      </table>
    </body>
    </html>
  `);
});

// ✅ THIS LINE IS CRITICAL — server won't start without it
app.listen(PORT, () => {
  console.log(`🚀 Astro middleware running on port ${PORT}`);
  console.log(`   S1 endpoint: POST /webhook`);
  console.log(`   S5 endpoint: POST /webhook-s5`);
});
