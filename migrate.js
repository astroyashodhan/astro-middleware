const axios = require("axios");
const { Pool } = require("pg");

const INTERAKT_API_KEY = process.env.INTERAKT_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

if (!INTERAKT_API_KEY) {
  console.error("❌ INTERAKT_API_KEY env var is missing");
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error("❌ DATABASE_URL env var is missing");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

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

// ── Fetch all contacts from Interakt ──────────────────────────────────
async function fetchAllContacts() {
  let page = 1;
  let allContacts = [];

  while (true) {
    console.log(`\n📥 Fetching page ${page}...`);

    let response;
    try {
      response = await axios.get("https://api.interakt.ai/v1/public/track/users/", {
        headers: {
          "Authorization": `Basic ${INTERAKT_API_KEY}`,
          "Content-Type": "application/json"
        },
        params: {
          page: page,
          pageSize: 100
        }
      });
    } catch (err) {
      console.error(`❌ API request failed: ${err.response?.status} — ${JSON.stringify(err.response?.data)}`);
      break;
    }

    // Log response keys on first page so we know the shape
    if (page === 1) {
      console.log("📦 Response top-level keys:", Object.keys(response.data || {}));
      console.log("📦 Sample (truncated):", JSON.stringify(response.data).substring(0, 500));
    }

    // Try all common response shapes Interakt might use
    const contacts =
      response.data?.data ||
      response.data?.users ||
      response.data?.result ||
      response.data?.contacts ||
      (Array.isArray(response.data) ? response.data : []);

    if (!contacts || contacts.length === 0) {
      console.log("✅ No more contacts — done fetching.");
      break;
    }

    allContacts = allContacts.concat(contacts);
    console.log(`Got ${contacts.length} contacts on this page (total so far: ${allContacts.length})`);

    // Log first contact shape on first page
    if (page === 1 && contacts.length > 0) {
      console.log("📋 First contact sample keys:", Object.keys(contacts[0]));
      console.log("📋 First contact sample:", JSON.stringify(contacts[0]).substring(0, 400));
    }

    if (contacts.length < 100) break; // Last page
    page++;

    // Small delay to respect rate limits
    await new Promise(r => setTimeout(r, 300));
  }

  return allContacts;
}

// ── Main migration ────────────────────────────────────────────────────
async function migrateContacts() {
  console.log("🚀 Starting Interakt → Railway migration...\n");

  const contacts = await fetchAllContacts();
  console.log(`\n📊 Total contacts fetched: ${contacts.length}`);

  if (contacts.length === 0) {
    console.log("⚠️  No contacts found. Check the API response logs above.");
    await pool.end();
    return;
  }

  let inserted = 0;
  let skipped  = 0;
  let failed   = 0;

  for (const contact of contacts) {
    // ── Normalize phone ───────────────────────────────────────────────
    // Interakt may store phone as phoneNumber + countryCode separately
    // or as a combined number field
    const rawPhone      = contact.phoneNumber || contact.phone_number || contact.phone || "";
    const rawCountry    = contact.countryCode  || contact.country_code  || "";
    const combinedPhone = rawCountry
      ? `${rawCountry}${rawPhone}`.replace(/\s/g, "")
      : rawPhone.startsWith("+") ? rawPhone : `+${rawPhone}`;

    const fullPhone = combinedPhone.replace(/\s/g, "");

    // ── Extract traits ────────────────────────────────────────────────
    const traits = contact.traits || contact.attributes || contact.customAttributes || {};

    const name       = traits.name        || contact.name        || null;
    const birthDay   = traits.user_birth_day   || null;
    const birthMonth = traits.user_birth_month || null;
    const birthYear  = traits.user_birth_year  || null;
    const birthTime  = traits.user_birth_time  || null;
    const birthPlace = traits.user_birth_place || null;

    const dob = (birthDay && birthMonth && birthYear)
      ? `${birthDay} ${birthMonth} ${birthYear}`
      : null;

    // Skip if no useful data at all
    if (!name && !dob && !birthTime && !birthPlace) {
      console.log(`⏭  Skipping ${fullPhone} — no birth/name data`);
      skipped++;
      continue;
    }

    if (!fullPhone || fullPhone === "+" || fullPhone.length < 8) {
      console.log(`⏭  Skipping entry — invalid phone: "${fullPhone}"`);
      skipped++;
      continue;
    }

    const { countryCode, phoneNumber } = splitPhone(fullPhone);

    try {
      await pool.query(`
        INSERT INTO users (phone, name, dob, birth_time, birth_place, country_code, phone_nocode, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
        ON CONFLICT (phone) DO UPDATE SET
          name        = COALESCE(EXCLUDED.name,        users.name),
          dob         = COALESCE(EXCLUDED.dob,         users.dob),
          birth_time  = COALESCE(EXCLUDED.birth_time,  users.birth_time),
          birth_place = COALESCE(EXCLUDED.birth_place, users.birth_place),
          country_code = COALESCE(EXCLUDED.country_code, users.country_code),
          phone_nocode = COALESCE(EXCLUDED.phone_nocode, users.phone_nocode),
          updated_at  = NOW()
      `, [fullPhone, name, dob, birthTime, birthPlace, countryCode, phoneNumber]);

      console.log(`✅ ${fullPhone} — ${name || "no name"} — ${dob || "no dob"}`);
      inserted++;
    } catch (err) {
      console.error(`❌ DB insert failed for ${fullPhone}: ${err.message}`);
      failed++;
    }
  }

  console.log(`
╔════════════════════════════════════╗
║        Migration Complete          ║
╠════════════════════════════════════╣
║  ✅ Inserted/Updated : ${String(inserted).padEnd(11)}║
║  ⏭  Skipped          : ${String(skipped).padEnd(11)}║
║  ❌ Failed           : ${String(failed).padEnd(11)}║
╚════════════════════════════════════╝
  `);

  await pool.end();
}

migrateContacts().catch(err => {
  console.error("💥 Migration crashed:", err.message);
  process.exit(1);
});
