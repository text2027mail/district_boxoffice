
const fs = require("fs");
const fetch = require("node-fetch");

const OUTPUT_FILE = "districtmovies.json";
const BACKUP_FILE = `backup_districtmovies_${Date.now()}.json`;

// ==========================================
// PROVIDER SWITCHES
// ==========================================

const USE_FIRECRAWL = false;
const USE_BROWSERLESS = true;

// ==========================================
// API CONFIGURATION
// ==========================================

// Keep API keys directly in code.
// Replace with your newly rotated keys.

const FIRECRAWL_TOKEN = "PASTE_FIRECRAWL_API_KEY_HERE";
const BROWSERLESS_TOKEN = "2Sb8h3EyJZrpIxz1b347cced6895fde8e5f07804af17ad7cd";

// API endpoints
const FIRECRAWL_URL = "https://api.firecrawl.dev/v2/scrape";

const BROWSERLESS_URL =
  "https://production-sfo.browserless.io/function";

const TARGET_URL =
  "https://paytmmovies.text2024mail.workers.dev/";

// ==========================================
// PARSE CITIES
// ==========================================

function parseCities(cityString) {
  if (!cityString) return [];

  return [...new Set(
    cityString
      .split(",")
      .map(c => c.trim())
      .filter(Boolean)
  )].sort();
}

// ==========================================
// LOAD EXISTING DATA
// ==========================================

function loadExistingData() {
  if (!fs.existsSync(OUTPUT_FILE)) return [];

  try {
    const raw = fs.readFileSync(OUTPUT_FILE, "utf-8");
    const data = JSON.parse(raw);

    if (!Array.isArray(data)) {
      console.warn(
        "⚠️ Existing file is not an array, starting fresh."
      );
      return [];
    }

    return data.map(entry => {
      if (Array.isArray(entry) && entry.length >= 8) {
        const cityCount =
          entry.length >= 9 ? (entry[8] || 0) : 0;

        return {
          id: entry[0],
          movie: entry[1],
          aliases: entry[2] || entry[1],
          language: entry[3],
          movieCode: entry[4] || "",
          runtime: entry[5],
          rating: entry[6],
          poster: entry[7],
          city: "",
          cityCount
        };
      }

      return entry;
    });

  } catch (err) {
    console.error(
      "⚠️ Error reading existing file:",
      err.message
    );

    return [];
  }
}

// ==========================================
// MERGE MOVIES
// ==========================================

function mergeMovies(existing, fresh) {
  const map = new Map();

  // Index existing movies by id + language
  existing.forEach(movie => {
    const key = `${movie.id}_${movie.language}`;
    map.set(key, movie);
  });

  // Process fresh movies
  fresh.forEach(movie => {
    const key = `${movie.id}_${movie.language}`;

    // Calculate city count
    const cities = parseCities(movie.city);
    movie.cityCount = cities.length;

    if (map.has(key)) {
      const existingMovie = map.get(key);

      if (existingMovie.movie === movie.movie) {
        map.set(key, movie);
      } else {
        console.warn(
          `⚠️ Skipped conflicting entry: id=${movie.id}, lang=${movie.language}, name=${movie.movie}`
        );
      }

    } else {
      map.set(key, movie);
    }
  });

  return Array.from(map.values());
}

// ==========================================
// SORT MOVIES
// ==========================================

function sortMovies(movies) {
  return movies.sort((a, b) => {
    const countA = a.cityCount || 0;
    const countB = b.cityCount || 0;

    if (countB !== countA) {
      return countB - countA;
    }

    return (a.movie || "").localeCompare(
      b.movie || ""
    );
  });
}

// ==========================================
// COMPACT JSON FORMAT
// ==========================================

function toCompactFormat(movies) {
  return movies.map(movie => [
    movie.id,
    movie.movie,
    movie.aliases || movie.movie,
    movie.language,
    movie.movieCode || "",
    movie.runtime,
    movie.rating,
    movie.poster,
    movie.cityCount || 0
  ]);
}

// ==========================================
// VALIDATE JSON DATA
// ==========================================

function validateMovieData(data, provider) {
  if (!Array.isArray(data)) {
    throw new Error(
      `${provider}: Response is not a JSON array.`
    );
  }

  if (data.length === 0) {
    throw new Error(
      `${provider}: Received empty movie data.`
    );
  }

  return data;
}

// ==========================================
// FIRECRAWL METHOD
// ==========================================

async function fetchDataFromFirecrawl() {
  if (
    !FIRECRAWL_TOKEN ||
    FIRECRAWL_TOKEN === "PASTE_FIRECRAWL_API_KEY_HERE"
  ) {
    throw new Error("Firecrawl API key is missing.");
  }

  console.log("🔥 Fetching data via Firecrawl...");

  const response = await fetch(FIRECRAWL_URL, {
    method: "POST",

    headers: {
      Authorization: `Bearer ${FIRECRAWL_TOKEN}`,
      "Content-Type": "application/json"
    },

    body: JSON.stringify({
      url: TARGET_URL,
      onlyMainContent: true,
      maxAge: 172800000,
      parsers: ["pdf"],
      formats: ["markdown"]
    })
  });

  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(
      `Firecrawl API error: ${response.status} - ${errorText}`
    );
  }

  const result = await response.json();

  if (!result.success) {
    throw new Error(
      `Firecrawl returned error: ${result.error || "Unknown error"}`
    );
  }

  const markdown = result.data?.markdown || "";

  if (!markdown) {
    throw new Error(
      "Firecrawl returned no markdown content."
    );
  }

  let parsed;

  // Parse raw JSON
  try {
    parsed = JSON.parse(markdown);

  } catch {
    // Try extracting JSON from markdown code block
    const match = markdown.match(
      /```(?:json)?\s*([\s\S]*?)```/
    );

    if (!match || !match[1]) {
      throw new Error(
        "Could not extract JSON from Firecrawl response."
      );
    }

    try {
      parsed = JSON.parse(match[1].trim());

    } catch {
      throw new Error(
        "Invalid JSON returned by Firecrawl."
      );
    }
  }

  console.log("✅ Firecrawl extraction successful.");

  return validateMovieData(parsed, "Firecrawl");
}

// ==========================================
// BROWSERLESS METHOD
// ==========================================

async function fetchDataFromBrowserless() {
  if (
    !BROWSERLESS_TOKEN ||
    BROWSERLESS_TOKEN === "PASTE_NEW_BROWSERLESS_API_KEY_HERE"
  ) {
    throw new Error("Browserless API key is missing.");
  }

  console.log("🌐 Fetching data via Browserless...");
  console.log("   Launching cloud browser...");

  // Browserless Puppeteer function.
  // Open the original JSON URL directly.
  // Capture the actual navigation response body.

  const browserCode = `
    export default async ({ page }) => {

      const response = await page.goto(
        ${JSON.stringify(TARGET_URL)},
        {
          waitUntil: "domcontentloaded",
          timeout: 60000
        }
      );

      if (!response) {
        throw new Error(
          "Browser navigation returned no response."
        );
      }

      const status = response.status();

      const body = await response.text();

      if (!response.ok()) {
        throw new Error(
          "Target HTTP " + status + ": " +
          body.substring(0, 500)
        );
      }

      if (!body) {
        throw new Error(
          "Target returned an empty response."
        );
      }

      let json;

      try {
        json = JSON.parse(body);

      } catch (err) {
        throw new Error(
          "Target response is not valid JSON: " +
          body.substring(0, 500)
        );
      }

      if (!Array.isArray(json)) {
        throw new Error(
          "Target JSON is not an array."
        );
      }

      return {
        data: json,
        type: "application/json"
      };
    };
  `;

  const response = await fetch(
    `${BROWSERLESS_URL}?token=${encodeURIComponent(BROWSERLESS_TOKEN)}`,
    {
      method: "POST",

      headers: {
        "Content-Type": "application/javascript"
      },

      body: browserCode
    }
  );

  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(
      `Browserless API error: ${response.status} ${response.statusText} - ${errorText.substring(0, 500)}`
    );
  }

  const responseText = await response.text();

  let result;

  try {
    result = JSON.parse(responseText);

  } catch {
    throw new Error(
      "Browserless returned invalid JSON: " +
      responseText.substring(0, 500)
    );
  }

  // Browserless returns:
  // {
  //   data: [...],
  //   type: "application/json"
  // }

  const extractedData =
    result &&
    typeof result === "object" &&
    !Array.isArray(result) &&
    Object.prototype.hasOwnProperty.call(result, "data")
      ? result.data
      : result;

  console.log("✅ Browserless extraction successful.");

  return validateMovieData(
    extractedData,
    "Browserless"
  );
}

// ==========================================
// PROVIDER SELECTOR
// ==========================================

async function fetchFreshData() {

  // Firecrawl has priority if both are enabled.

  if (USE_FIRECRAWL) {
    console.log("📡 Provider selected: Firecrawl");

    return await fetchDataFromFirecrawl();
  }

  if (USE_BROWSERLESS) {
    console.log("📡 Provider selected: Browserless");

    return await fetchDataFromBrowserless();
  }

  throw new Error(
    "Both providers are OFF. Enable Firecrawl or Browserless."
  );
}

// ==========================================
// MAIN
// ==========================================

async function main() {
  try {

    // 1. Fetch fresh data

    const freshData = await fetchFreshData();

    console.log(
      `📥 Fresh movies received: ${freshData.length}`
    );

    // 2. Load existing data

    console.log("📂 Loading existing movies...");

    const existingData = loadExistingData();

    console.log(
      `   Existing movies: ${existingData.length}`
    );

    // 3. Merge

    console.log("🔄 Merging movies...");

    let merged = mergeMovies(
      existingData,
      freshData
    );

    // 4. Sort

    console.log("📊 Sorting movies...");

    merged = sortMovies(merged);

    // 5. Backup old file

    if (fs.existsSync(OUTPUT_FILE)) {
      fs.copyFileSync(
        OUTPUT_FILE,
        BACKUP_FILE
      );

      console.log(
        `📦 Backup saved as ${BACKUP_FILE}`
      );
    }

    // 6. Convert to compact format

    const compact = toCompactFormat(merged);

    // 7. Save minified JSON

    console.log(`💾 Saving to ${OUTPUT_FILE}`);

    fs.writeFileSync(
      OUTPUT_FILE,
      JSON.stringify(compact),
      "utf-8"
    );

    console.log(
      `✅ Done! Total movies saved: ${compact.length}`
    );

  } catch (err) {

    console.error(
      "❌ Error:",
      err.message
    );

    process.exitCode = 1;
  }
}

main();
