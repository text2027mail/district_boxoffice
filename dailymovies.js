const fs = require("fs");
const fetch = require("node-fetch");

const OUTPUT_FILE = "districtmovies.json";
const BACKUP_FILE = `backup_districtmovies_${Date.now()}.json`;

// Firecrawl configuration (use the provided token)
const FIRECRAWL_URL = "https://api.firecrawl.dev/v2/scrape";
const FIRECRAWL_TOKEN = "fc-51a30586f6b44777a717092ff6eea2a4";
const TARGET_URL = "https://paytmmovies.text2024mail.workers.dev/";

// Parse city string into unique sorted array
function parseCities(cityString) {
  if (!cityString) return [];
  const cities = cityString
    .split(",")
    .map(c => c.trim())
    .filter(Boolean);
  return [...new Set(cities)]; // remove duplicates
}

// Load existing data if available
function loadExistingData() {
  if (fs.existsSync(OUTPUT_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(OUTPUT_FILE, "utf-8"));
    } catch (err) {
      console.error("⚠️ Error reading existing file, starting fresh:", err);
      return [];
    }
  }
  return [];
}

// Merge new movies into existing dataset with strict uniqueness
function mergeMovies(existing, fresh) {
  const map = new Map();

  // index existing by id+language
  existing.forEach(movie => {
    const key = `${movie.id}_${movie.language}`;
    map.set(key, movie);
  });

  // update/add fresh
  fresh.forEach(movie => {
    const key = `${movie.id}_${movie.language}`;

    if (map.has(key)) {
      // check if same movie name → update
      if (map.get(key).movie === movie.movie) {
        const cities = parseCities(movie.city);
        map.set(key, {
          ...movie,
          city: cities.join(", "),
          cityCount: cities.length
        });
      } else {
        // different movie name for same id+language → ignore
        console.warn(
          `⚠️ Skipped conflicting entry: id=${movie.id}, lang=${movie.language}, name=${movie.movie}`
        );
      }
    } else {
      // new entry → add
      const cities = parseCities(movie.city);
      map.set(key, {
        ...movie,
        city: cities.join(", "),
        cityCount: cities.length
      });
    }
  });

  return Array.from(map.values());
}

// Sort by city count (desc), then movie name (asc)
function sortMovies(movies) {
  return movies.sort((a, b) => {
    if (b.cityCount !== a.cityCount) {
      return b.cityCount - a.cityCount;
    }
    return a.movie.localeCompare(b.movie);
  });
}

/**
 * Fetch data using Firecrawl as a proxy.
 * Firecrawl returns the page content as markdown. We expect the target URL
 * to return plain JSON, so the markdown will either be the raw JSON string
 * or a code block containing it. This function extracts and parses the JSON.
 */
async function fetchDataFromFirecrawl() {
  const options = {
    method: "POST",
    headers: {
      Authorization: `Bearer ${FIRECRAWL_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url: TARGET_URL,
      onlyMainContent: true,
      maxAge: 172800000, // 2 days
      parsers: ["pdf"],
      formats: ["markdown"],
    }),
  };

  console.log("🌐 Fetching data via Firecrawl proxy...");
  const response = await fetch(FIRECRAWL_URL, options);
  if (!response.ok) {
    throw new Error(`Firecrawl API error: ${response.status} ${response.statusText}`);
  }

  const result = await response.json();
  if (!result.success) {
    throw new Error(`Firecrawl returned error: ${result.error || "Unknown error"}`);
  }

  // Extract markdown content
  const markdown = result.data?.markdown || "";
  if (!markdown) {
    throw new Error("No markdown content returned from Firecrawl");
  }

  // Try to parse the markdown as JSON directly (if it's plain text)
  try {
    return JSON.parse(markdown);
  } catch {
    // If that fails, attempt to extract JSON from a markdown code block
    const codeBlockMatch = markdown.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch && codeBlockMatch[1]) {
      try {
        return JSON.parse(codeBlockMatch[1].trim());
      } catch (innerErr) {
        throw new Error("Failed to parse JSON from markdown code block");
      }
    }
    throw new Error("Could not extract JSON from markdown response");
  }
}

async function main() {
  try {
    // Get fresh data via Firecrawl
    const freshData = await fetchDataFromFirecrawl();

    console.log("📂 Loading existing movies...");
    const existingData = loadExistingData();

    console.log("🔄 Merging movies...");
    let merged = mergeMovies(existingData, freshData);

    console.log("📊 Sorting movies...");
    merged = sortMovies(merged);

    // Backup old file
    if (fs.existsSync(OUTPUT_FILE)) {
      fs.copyFileSync(OUTPUT_FILE, BACKUP_FILE);
      console.log(`📦 Backup saved as ${BACKUP_FILE}`);
    }

    console.log("💾 Saving to", OUTPUT_FILE);
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(merged, null, 2), "utf-8");

    console.log("✅ Done! Total movies:", merged.length);
  } catch (err) {
    console.error("❌ Error:", err.message);
  }
}

main();
