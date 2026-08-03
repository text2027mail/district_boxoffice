// fetchold_parallel.js – Parallel historical migration (concurrency 50) – CHUNKED VERSION
// Downloads old JSONs from GitHub and converts to new compressed format.
// Environment variables:
//   BOXOFFICE_DIR – output for boxoffice (default ./boxoffice)
//   ADVANCE_DIR   – output for advance   (default ./advance)
//   LOGS_DIR      – output for logs      (default ./logs)
//   START_DATE    – start date YYYY-MM-DD (default 2025-08-01)
//   END_DATE      – end date YYYY-MM-DD   (default today)
//   CONCURRENCY   – number of parallel downloads per chunk (default 50)

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
async function downloadAndConvert(url, outFile) {
  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      console.log(`⚠️ Failed to fetch ${url} (status ${resp.status})`);
      return false;
    }
    const data = await resp.json();
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
      console.log(`⏭️ No shows found in ${url}`);
      return false;
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

    await fsPromises.writeFile(outFile, JSON.stringify(output, null, 2), 'utf8');
    console.log(`✅ Converted ${outFile} (${totalShows} shows)`);
    return true;
  } catch (err) {
    console.log(`❌ Error processing ${url}: ${err.message}`);
    return false;
  }
}

// ------------------------- CONCURRENCY LIMITER (chunked) -------------------------
async function runWithConcurrency(tasks, concurrency) {
  const results = [];
  for (let i = 0; i < tasks.length; i += concurrency) {
    const chunk = tasks.slice(i, i + concurrency);
    // Filter out any non‑function tasks (shouldn't happen, but safe)
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

  // ----- Generate list of tasks -----
  const tasks = [];

  // For each date, add boxoffice and advance tasks
  let current = START_DATE.clone();
  while (current.isBefore(END_DATE) || current.isSame(END_DATE, 'day')) {
    const dateStr = current.format('YYYY-MM-DD');
    const boxofficeUrl = `${BASE_URL_BOXOFFICE}${dateStr}_Detailed.json`;
    const advanceUrl = `${BASE_URL_ADVANCE}${dateStr}_Detailed.json`;
    const boxofficeOut = path.join(BOXOFFICE_OUT, `${dateStr}_Detailed.json`);
    const advanceOut = path.join(ADVANCE_OUT, `${dateStr}_Detailed.json`);

    // Only add tasks if output file doesn't exist
    if (!fs.existsSync(boxofficeOut)) {
      tasks.push(async () => {
        console.log(`⬇️ Downloading boxoffice ${dateStr}...`);
        const ok = await downloadAndConvert(boxofficeUrl, boxofficeOut);
        return { type: 'boxoffice', date: dateStr, success: ok };
      });
    } else {
      console.log(`⏭️ Boxoffice ${dateStr} already exists, skipping.`);
    }

    if (!fs.existsSync(advanceOut)) {
      tasks.push(async () => {
        console.log(`⬇️ Downloading advance ${dateStr}...`);
        const ok = await downloadAndConvert(advanceUrl, advanceOut);
        return { type: 'advance', date: dateStr, success: ok };
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
        try {
          const resp = await fetch(logUrl);
          if (resp.ok) {
            const data = await resp.json();
            await fsPromises.writeFile(logOut, JSON.stringify(data, null, 2), 'utf8');
            console.log(`✅ Log ${month} downloaded.`);
            return { type: 'log', month, success: true };
          } else {
            console.log(`⚠️ Log ${month} not found (status ${resp.status})`);
            return { type: 'log', month, success: false };
          }
        } catch (err) {
          console.log(`❌ Error downloading log ${month}: ${err.message}`);
          return { type: 'log', month, success: false };
        }
      });
    } else {
      console.log(`⏭️ Log ${month} already exists.`);
    }
  }

  console.log(`\n📦 Total tasks: ${tasks.length}`);

  // ----- Run with concurrency (chunked) -----
  const results = await runWithConcurrency(tasks, CONCURRENCY);

  // ----- Summarize -----
  const successCount = results.filter(r => r && r.success).length;
  const failCount = results.length - successCount;
  console.log(`\n✅ Migration complete. Success: ${successCount}, Fail: ${failCount}`);
  process.exit(failCount === 0 ? 0 : 1);
})();
