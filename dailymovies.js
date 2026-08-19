const fs = require("fs");
const fetch = require("node-fetch");

const OUTPUT_FILE = "districtmovies.json";
const BACKUP_FILE = `backup_districtmovies_${Date.now()}.json`;

// Firecrawl configuration
const FIRECRAWL_URL = "https://api.firecrawl.dev/v2/scrape";
const FIRECRAWL_TOKEN = "fc-51a30586f6b44777a717092ff6eea2a4";
const TARGET_URL = "https://paytmmovies.text2024mail.workers.dev/";

/**
 * Parse city string into unique sorted array.
 * Used only for sorting, not stored in final output.
 */
function parseCities(cityString) {
  if (!cityString) return [];
  return [...new Set(
    cityString.split(",").map(c => c.trim()).filter(Boolean)
  )].sort();
}

/**
 * Load existing compact JSON and convert to internal object format.
 * Expected compact entry (new version):
 * [id, movie, aliases, language, movieCode, runtime, rating, poster, cityCount]
 * Supports old 8‑element format as well.
 */
function loadExistingData() {
  if (!fs.existsSync(OUTPUT_FILE)) return [];

  try {
    const raw = fs.readFileSync(OUTPUT_FILE, "utf-8");
    const data = JSON.parse(raw);

    if (!Array.isArray(data)) {
      console.warn("⚠️ Existing file is not an array, starting fresh.");
      return [];
    }

    return data.map(entry => {
      if (Array.isArray(entry) && entry.length >= 8) {
        const cityCount = entry.length >= 9 ? (entry[8] || 0) : 0;
        return {
          id: entry[0],
          movie: entry[1],
          aliases: entry[2] || entry[1],
          language: entry[3],
          movieCode: entry[4] || "",
          runtime: entry[5],
          rating: entry[6],
          poster: entry[7],
          city: "",                // city name not stored
          cityCount: cityCount     // restored from compact
        };
      }
      // Fallback for object format (should not happen after first run)
      return entry;
    });
  } catch (err) {
    console.error("⚠️ Error reading existing file:", err.message);
    return [];
  }
}

/**
 * Merge fresh movies into existing dataset.
 * Uniqueness key: id + language.
 */
function mergeMovies(existing, fresh) {
  const map = new Map();

  // Index existing by id+language
  existing.forEach(movie => {
    const key = `${movie.id}_${movie.language}`;
    map.set(key, movie);
  });

  // Process fresh movies
  fresh.forEach(movie => {
    const key = `${movie.id}_${movie.language}`;

    // Compute city count for sorting (stored in final output)
    const cities = parseCities(movie.city);
    movie.cityCount = cities.length;

    if (map.has(key)) {
      const existingMovie = map.get(key);
      // If same movie name, update with fresh (latest data)
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

/**
 * Sort movies by cityCount desc, then movie name asc.
 */
function sortMovies(movies) {
  return movies.sort((a, b) => {
    const countA = a.cityCount || 0;
    const countB = b.cityCount || 0;
    if (countB !== countA) return countB - countA;
    return (a.movie || "").localeCompare(b.movie || "");
  });
}

/**
 * Convert internal movie objects to compact array format.
 * Includes cityCount but NOT the city string.
 */
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
    movie.cityCount || 0   // ← cityCount kept, city name removed
  ]);
}

/**
 * Fetch data via Firecrawl proxy and extract JSON.
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

  const markdown = result.data?.markdown || "";
  if (!markdown) {
    throw new Error("No markdown content returned from Firecrawl");
  }

  // Try to parse markdown as raw JSON
  try {
    return JSON.parse(markdown);
  } catch {
    // Attempt to extract JSON from a code block
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
    // 1. Fetch fresh data
    const freshData = await fetchDataFromFirecrawl();
    console.log(`📥 Fresh movies received: ${freshData.length}`);

    // 2. Load existing data
    console.log("📂 Loading existing movies...");
    const existingData = loadExistingData();
    console.log(`   Existing movies: ${existingData.length}`);

    // 3. Merge
    console.log("🔄 Merging movies...");
    let merged = mergeMovies(existingData, freshData);

    // 4. Sort
    console.log("📊 Sorting movies...");
    merged = sortMovies(merged);

    // 5. Backup old file
    if (fs.existsSync(OUTPUT_FILE)) {
      fs.copyFileSync(OUTPUT_FILE, BACKUP_FILE);
      console.log(`📦 Backup saved as ${BACKUP_FILE}`);
    }

    // 6. Convert to compact format (drop city, keep cityCount)
    const compact = toCompactFormat(merged);

    // 7. Save minified one-line JSON
    console.log(`💾 Saving to ${OUTPUT_FILE}`);
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(compact, null, 0), "utf-8");

    console.log(`✅ Done! Total movies saved: ${compact.length}`);
  } catch (err) {
    console.error("❌ Error:", err.message);
  }
}

main();
