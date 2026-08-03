// fetchold.js – Parallel historical migration with concurrency control
// Downloads old JSONs from GitHub and converts to new compressed format.
// Environment variables:
//   BOXOFFICE_DIR – output for boxoffice (default ./boxoffice)
//   ADVANCE_DIR   – output for advance   (default ./advance)
//   LOGS_DIR      – output for logs      (default ./logs)
//   START_DATE    – start date YYYY-MM-DD (default 2025-08-01)
//   END_DATE      – end date YYYY-MM-DD   (default today)
//   CONCURRENCY   – number of parallel downloads per chunk (default 50)
//   PRETTY        – set to 'true' for pretty-printed JSON (default false)

require('dotenv').config();
const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');
const fetch = require('node-fetch');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

dayjs.extend(utc);
dayjs.extend(timezone);

// ------------------------- CONFIG -------------------------
const BASE_URL_BOXOFFICE = 'https://raw.githubusercontent.com/unknownman2024/district_tracking/refs/heads/main/Daily%20Boxoffice/';
const BASE_URL_ADVANCE = 'https://raw.githubusercontent.com/unknownman2024/district_tracking/refs/heads/main/Daily%20Advance/';
const LOGS_URL = 'https://raw.githubusercontent.com/unknownman2024/district_tracking/refs/heads/main/Daily%20Boxoffice/logs/';

const BOXOFFICE_OUT = process.env.BOXOFFICE_DIR || './boxoffice';
const ADVANCE_OUT = process.env.ADVANCE_DIR || './advance';
const LOGS_OUT = process.env.LOGS_DIR || './logs';
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '50', 10);
const PRETTY = process.env.PRETTY === 'true';

// Ensure directories exist
[BOXOFFICE_OUT, ADVANCE_OUT, LOGS_OUT].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Parse start/end dates from env
const START_DATE = process.env.START_DATE ? dayjs(process.env.START_DATE) : dayjs('2025-08-01');
const END_DATE = process.env.END_DATE ? dayjs(process.env.END_DATE) : dayjs().tz('Asia/Kolkata');

// ------------------------- HELPERS (compression logic) -------------------------
function buildDictionaries(shows) {
  const dicts = {
    cities: {}, states: {}, venues: {}, chains: {}, showtimes: {}, audis: {},
  };
  const nextId = { cities: 0, states: 0, venues: 0, chains: 0, showtimes: 0, audis: 0 };
  shows.forEach(s => {
    const city = s.city; if (!dicts.cities[city]) dicts.cities[city] = nextId.cities++;
    const state = s.state; if (!dicts.states[state]) dicts.states[state] = nextId.states++;
    const venue = s.venue; if (!dicts.venues[venue]) dicts.venues[venue] = nextId.venues++;
    const chain = s.chain; if (!dicts.chains[chain]) dicts.chains[chain] = nextId.chains++;
    const time = s.time; if (!dicts.showtimes[time]) dicts.showtimes[time] = nextId.showtimes++;
    const audi = s.audi || ''; if (!dicts.audis[audi]) dicts.audis[audi] = nextId.audis++;
  });
  return { forward: dicts };
}

function compressShows(shows, dicts) {
  return shows.map(s => {
    const cityId = dicts.cities[s.city];
    const stateId = dicts.states[s.state];
    const venueId = dicts.venues[s.venue];
    const chainId = dicts.chains[s.chain];
    const timeId = dicts.showtimes[s.time];
    const audiId = dicts.audis[s.audi || ''];
    const total = s.totalSeats || 0;
    const avail = s.available || 0;
    const sold = s.sold || 0;
    const gross = Math.round(s.gross * 100);
    const occupancy = total ? Math.round((sold / total) * 10000) : 0;
    const minsLeft = s.minsLeft || 0;
    return [cityId, stateId, venueId, chainId, timeId, audiId, total, avail, sold, gross, occupancy, minsLeft];
  });
}

// ------------------------- ASYNC DOWNLOAD AND CONVERT -------------------------
/**
 * Downloads a JSON file from `url`, compresses it, and writes to `outFile`.
 * Returns an object:
 *   { success: boolean, type, dateOrMonth, status?: 'not_found' | 'ok' | 'error' }
 */
async function downloadAndConvert(url, outFile, type, dateOrMonth) {
  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      // 404 – file does not exist – treat as a warning, not a failure
      if (resp.status === 404) {
        console.log(`ℹ️ ${type} ${dateOrMonth} not found (status 404) – skipping`);
        return { success: true, type, dateOrMonth, status: 'not_found' };
      }
      // Other HTTP errors (500, 403, etc.) – real failure
      console.log(`⚠️ Failed to fetch ${url} (status ${resp.status})`);
      return { success: false, type, dateOrMonth, status: 'http_error', statusCode: resp.status };
    }

    const data = await resp.json();

    // --- For boxoffice / advance ---
    if (type !== 'log') {
      const movies = {};
      let totalShows = 0;
      for (const [key, value] of Object.entries(data)) {
        if (key === 'date' || key === 'lastUpdated') continue;
        if (Array.isArray(value)) {
          const convertedShows = value.map(s => ({
            city: s.city || 'Unknown',
            state: s.state || 'Unknown',
            venue: s.venue || 'Unknown',
            chain: s.chain || 'Unknown',
            time: s.time || '',
            audi: s.audi || '',
            totalSeats: s.totalSeats || 0,
            available: s.available || 0,
            sold: s.sold || 0,
            gross: s.gross || 0,
            minsLeft: s.minsLeft || 0,
          }));
          movies[key] = convertedShows;
          totalShows += convertedShows.length;
        }
      }

      if (totalShows === 0) {
        console.log(`⏭️ No shows found in ${url} – skipping`);
        // This is unusual but we treat as success (file downloaded, but empty)
        return { success: true, type, dateOrMonth, status: 'empty' };
      }

      const allShows = Object.values(movies).flat();
      const dicts = buildDictionaries(allShows);
      const compressed = {};
      for (const [movie, shows] of Object.entries(movies)) {
        compressed[movie] = compressShows(shows, dicts.forward);
      }

      const output = {
        date: data.date || '',
        lastUpdated: data.lastUpdated || '',
        dicts: dicts.forward,
        movies: compressed,
      };

      const jsonString = PRETTY ? JSON.stringify(output, null, 2) : JSON.stringify(output);
      await fsPromises.writeFile(outFile, jsonString, 'utf8');
      console.log(`✅ Converted ${outFile} (${totalShows} shows)`);
      return { success: true, type, dateOrMonth, status: 'ok' };
    }

    // --- For logs ---
    const logString = PRETTY ? JSON.stringify(data, null, 2) : JSON.stringify(data);
    await fsPromises.writeFile(outFile, logString, 'utf8');
    console.log(`✅ Log ${dateOrMonth} downloaded.`);
    return { success: true, type, dateOrMonth, status: 'ok' };

  } catch (err) {
    console.log(`❌ Error processing ${url}: ${err.message}`);
    return { success: false, type, dateOrMonth, status: 'exception', error: err.message };
  }
}

// ------------------------- CONCURRENCY LIMITER (chunked) -------------------------
async function runWithConcurrency(tasks, concurrency) {
  const results = [];
  for (let i = 0; i < tasks.length; i += concurrency) {
    const chunk = tasks.slice(i, i + concurrency);
    const validChunk = chunk.filter(task => typeof task === 'function');
    if (validChunk.length === 0) continue;
    console.log(`⏳ Processing chunk ${Math.floor(i / concurrency) + 1}/${Math.ceil(tasks.length / concurrency)} (${validChunk.length} tasks)`);
    const chunkResults = await Promise.all(validChunk.map(task => task()));
    results.push(...chunkResults);
  }
  return results;
}

// ------------------------- MAIN -------------------------
(async function main() {
  console.log(`🚀 Starting parallel migration from ${START_DATE.format('YYYY-MM-DD')} to ${END_DATE.format('YYYY-MM-DD')}`);
  console.log(`📁 Boxoffice output: ${BOXOFFICE_OUT}`);
  console.log(`📁 Advance output: ${ADVANCE_OUT}`);
  console.log(`📁 Logs output: ${LOGS_OUT}`);
  console.log(`⚡ Concurrency per chunk: ${CONCURRENCY}`);
  console.log(`🔘 Pretty-print JSON: ${PRETTY}`);

  // ----- Generate list of tasks -----
  const tasks = [];

  // For each date, add boxoffice and advance tasks (skip if already exists)
  let current = START_DATE.clone();
  while (current.isBefore(END_DATE) || current.isSame(END_DATE, 'day')) {
    const dateStr = current.format('YYYY-MM-DD');
    const boxofficeUrl = `${BASE_URL_BOXOFFICE}${dateStr}_Detailed.json`;
    const advanceUrl = `${BASE_URL_ADVANCE}${dateStr}_Detailed.json`;
    const boxofficeOut = path.join(BOXOFFICE_OUT, `${dateStr}_Detailed.json`);
    const advanceOut = path.join(ADVANCE_OUT, `${dateStr}_Detailed.json`);

    if (!fs.existsSync(boxofficeOut)) {
      tasks.push(async () => {
        console.log(`⬇️ Downloading boxoffice ${dateStr}...`);
        return await downloadAndConvert(boxofficeUrl, boxofficeOut, 'boxoffice', dateStr);
      });
    } else {
      console.log(`⏭️ Boxoffice ${dateStr} already exists, skipping.`);
    }

    if (!fs.existsSync(advanceOut)) {
      tasks.push(async () => {
        console.log(`⬇️ Downloading advance ${dateStr}...`);
        return await downloadAndConvert(advanceUrl, advanceOut, 'advance', dateStr);
      });
    } else {
      console.log(`⏭️ Advance ${dateStr} already exists, skipping.`);
    }

    current = current.add(1, 'day');
  }

  // ----- Monthly logs -----
  console.log('\n📊 Generating monthly log tasks...');
  const months = [];
  let m = START_DATE.clone().startOf('month');
  while (m.isBefore(END_DATE) || m.isSame(END_DATE, 'month')) {
    months.push(m.format('MM-YYYY'));
    m = m.add(1, 'month');
  }
  for (const month of months) {
    const logUrl = `${LOGS_URL}${month}.json`;
    const logOut = path.join(LOGS_OUT, `${month}.json`);
    if (!fs.existsSync(logOut)) {
      tasks.push(async () => {
        console.log(`⬇️ Downloading log ${month}...`);
        return await downloadAndConvert(logUrl, logOut, 'log', month);
      });
    } else {
      console.log(`⏭️ Log ${month} already exists.`);
    }
  }

  console.log(`\n📦 Total tasks: ${tasks.length}`);

  // ----- Run with concurrency -----
  const results = await runWithConcurrency(tasks, CONCURRENCY);

  // ----- Summarize -----
  const dataResults = results.filter(r => r && (r.type === 'boxoffice' || r.type === 'advance'));
  const logResults = results.filter(r => r && r.type === 'log');

  // Count successes, not-found (skipped), and real failures
  const dataSuccess = dataResults.filter(r => r.success).length;
  const dataNotFound = dataResults.filter(r => r.status === 'not_found').length;
  const dataFail = dataResults.filter(r => !r.success).length;

  const logSuccess = logResults.filter(r => r.success).length;
  const logNotFound = logResults.filter(r => r.status === 'not_found').length;
  const logFail = logResults.filter(r => !r.success).length;

  console.log(`\n✅ Migration complete.`);
  console.log(`   📊 Data (boxoffice/advance):`);
  console.log(`       Success (downloaded) : ${dataSuccess - dataNotFound}`);
  console.log(`       Skipped (404)        : ${dataNotFound}`);
  console.log(`       Failures (real error): ${dataFail}`);
  console.log(`   📋 Logs:`);
  console.log(`       Success (downloaded) : ${logSuccess - logNotFound}`);
  console.log(`       Skipped (404)        : ${logNotFound}`);
  console.log(`       Failures (real error): ${logFail}`);

  // Exit with error only if there is at least one real failure (non-404) for data files
  process.exit(dataFail === 0 ? 0 : 1);
})();
