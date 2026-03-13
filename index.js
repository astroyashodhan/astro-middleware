const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;
const PORT = process.env.PORT || 3000;

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

    // Only process workflow_response_update events
    if (body.type !== "workflow_response_update") {
      console.log("Ignored event type:", body.type);
      return res.status(200).json({ status: "ignored" });
    }

    const data = body.data;
    const dataArray = data.data || [];

    // Extract all fields from question/answer pairs
    const birthDay   = extractField(dataArray, "user_birth_day");
    const birthMonth = extractField(dataArray, "user_birth_month");
    const birthYear  = extractField(dataArray, "user_birth_year");

    // Build DOB string
    const monthNames = {
      "1": "January", "2": "February", "3": "March", "4": "April",
      "5": "May", "6": "June", "7": "July", "8": "August",
      "9": "September", "10": "October", "11": "November", "12": "December"
    };
    const monthName = monthNames[birthMonth] || birthMonth;
    const dob = `${birthDay} ${monthName} ${birthYear}`;

    // Build clean payload for Make.com
    const makePayload = {
      name:         extractField(dataArray, "name"),
      dob:          dob,
      birth_place:  extractField(dataArray, "user_birth_place"),
      tob:          extractField(dataArray, "user_birth_time"),
      topic:        extractField(dataArray, "prediction_choice"),
      phone_full:   data.customer_number,
      customer_name: data.customer_name,
      customer_id:  data.customer_id,
      workflow_id:  data.workflow_id,
      timestamp:    body.timestamp
    };

    console.log("Sending to Make.com:", JSON.stringify(makePayload, null, 2));

    // Forward to Make.com
    const makeResponse = await axios.post(MAKE_WEBHOOK_URL, makePayload, {
      headers: { "Content-Type": "application/json" }
    });

    console.log("Make.com response:", makeResponse.status);
    return res.status(200).json({ status: "success", forwarded: makePayload });

  } catch (err) {
    console.error("Error:", err.message);
    return res.status(500).json({ status: "error", message: err.message });
  }
});

// Health check
app.get("/", (req, res) => {
  res.json({ status: "Astro Middleware Running" });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
