const axios = require("axios");
const { Pool } = require("pg");

const INTERAKT_API_KEY = process.env.INTERAKT_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

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

async function fetchAllContacts() {
  let page = 1;
  let allContacts = [];

  while (true) {
    console.log(`Fetching page ${page}...`);
    const response = await axios.get("https://api.interakt.ai/v1/public/apis/contacts/", {
      headers: {
        "Authorization": `Basic ${INTERAKT_API_KEY}`,
        "Content-Type": "application/json"
      },
      params: {
        offset: (page - 1) * 100,
        limit: 100
      }
    });

    const contacts = response.data?.result || [];
    if (contacts.length === 0) break;

    allContacts = allContacts.concat(contacts);
    console.log(`Got ${contacts.length} contacts (total: ${allContacts.length})`);

    if (contacts.length < 100) break;
    page++;
  }

  return allContacts;
}

async function migrateContacts() {
  const contacts = await fetchAllContacts();
  console.log(`\nTotal contacts to migrate: ${contacts.length}`);

  let inserted = 0;
  let skipped = 0;

  for (const contact of contacts) {
    const traits = contact.traits || {};
    const phoneRaw = contact.phone_number || "";

    const fullPhone = phoneRaw.startsWith("+") ? phoneRaw : `+${phoneRaw}`;

    const name       = traits.name || contact.name || null;
    const birthDay   = traits.user_birth_day || null;
    const birthMonth = traits.user_birth_month || null;
    const birthYear  = traits.user_birth_year || null;
    const birthTime  = traits.user_birth_time || null;
    const birthPlace = traits.user_birth_place || null;

    const dob = (birthDay && birthMonth && birthYear)
      ? `${birthDay} ${birthMonth} ${birthYear}`
      : null;

    if (!name && !dob) {
      console.log(`⏭ Skipping ${fullPhone} — no useful data`);
      skipped++;
      continue;
    }

    const { countryCode, phoneNumber } = splitPhone(fullPhone);

    try {
      await pool.query(`
        INSERT INTO users (phone, name, dob, birth_time, birth_place, country_code, phone_nocode, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
        ON CONFLICT (phone) DO UPDATE SET
          name        = COALESCE(EXCLUDED.name, users.name),
          dob         = COALESCE(EXCLUDED.dob, users.dob),
          birth_time  = COALESCE(EXCLUDED.birth_time, users.birth_time),
          birth_place = COALESCE(EXCLUDED.birth_place, users.birth_place),
          updated_at  = NOW()
      `, [fullPhone, name, dob, birthTime, birthPlace, countryCode, phoneNumber]);

      console.log(`✅ ${fullPhone} — ${name} — ${dob || "no dob"}`);
      inserted++;
    } catch (err) {
      console.error(`❌ Failed for ${fullPhone}:`, err.message);
    }
  }

  console.log(`\n✅ Migration complete: ${inserted} inserted/updated, ${skipped} skipped`);
  await pool.end();
}

migrateContacts().catch(err => {
  console.error("Migration failed:", err.message);
  process.exit(1);
});
