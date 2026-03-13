const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;
const PORT = process.env.PORT || 8080;

// In-memory log of last 20 incoming payloads
const logs = [];

function addLog(type, data) {
  logs.unshift({ time: new Date().toISOString(), type, data });
  if (logs.length > 20) logs.pop();
}

// Helper: extract answer by user_trait_name from data array
function extractField(dataArray, traitName) {
  const item = dataArray.find(
    (d) => d.question && d.question.user_trait_name === traitName
  );
  return item ? item.answer.message : null;
}

app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;
    addLog("RECEIVED", body);

    // Only process workflow_response_update events
    if (body.type !== "workflow_response_update") {
      addLog("IGNORED", { reason: "Not workflow_response_update", type: body.type });
      return res.status(200).json({ status: "ignored" });
    }

    const data = body.data;
    const dataArray = data.data || [];

    // Extract all fields
    const name       = extractField(dataArray, "name");
    const birthDay   = extractField(dataArray, "user_birth_day");
    const birthMonth = extractField(dataArray, "user_birth_month");
    const birthYear  = extractField(dataArray, "user_birth_year");
    const tob        = extractField(dataArray, "user_birth_time");
    const birthPlace = extractField(dataArray, "user_birth_place");
    const topic      = extractField(dataArray, "prediction_choice");

    // Wait until ALL required fields are collected (birth_place is the last one)
    if (!name || !birthDay || !birthMonth || !birthYear || !tob || !birthPlace || !topic) {
      addLog("WAITING", {
        reason: "Not all fields collected yet",
        collected: {
          name: !!name,
          birthDay: !!birthDay,
          birthMonth: !!birthMonth,
          birthYear: !!birthYear,
          tob: !!tob,
          birthPlace: !!birthPlace,
          topic: !!topic
        }
      });
      return res.status(200).json({ status: "waiting" });
    }

    // Build DOB string
    const monthNames = {
      "1": "January", "2": "February", "3": "March", "4": "April",
      "5": "May", "6": "June", "7": "July", "8": "August",
      "9": "September", "10": "October", "11": "November", "12": "December"
    };
    const dob = `${birthDay} ${monthNames[birthMonth] || birthMonth} ${birthYear}`;


    // Split phone into country code and local number
    // e.g. +919019497839 → country_code: +91, phone: 9019497839
    const fullPhone = data.customer_number || "";
    const phoneMatch = fullPhone.match(/^(\+\d{1,3})(\d+)$/);
    const countryCode = phoneMatch ? phoneMatch[1] : "";
    const phoneNumber = phoneMatch ? phoneMatch[2] : fullPhone;
    // Only send required fields to Make.com
    const makePayload = {
      name:        name,
      dob:         dob,
      birth_place: birthPlace,
      tob:         tob,
      topic:       topic,
      country_code: countryCode,
      phone:        phoneNumber,
      phone_full:   fullPhone
    };

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

// Live dashboard
app.get("/", (req, res) => {
  const rows = logs.map(log => `
    <tr>
      <td>${log.time}</td>
      <td><span class="badge ${log.type === "ERROR" ? "error" : log.type === "FORWARDED_TO_MAKE" ? "success" : log.type === "WAITING" ? "waiting" : "info"}">${log.type}</span></td>
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
        .waiting { background: #78350f; color: #fcd34d; }
        .info    { background: #1e3a5f; color: #93c5fd; }
        .status  { color: #86efac; font-size: 13px; margin-bottom: 20px; }
      </style>
    </head>
    <body>
      <h1>🔮 Astro Middleware — Live Logs</h1>
      <p class="status">✅ Server running — auto-refreshes every 5 seconds</p>
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
  console.log(`Server running on port ${PORT}`);
});
