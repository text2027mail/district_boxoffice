// dailybo.js – Enterprise-grade Daily Boxoffice (Supercompressed format)
// Output directories can be overridden by env vars:
//   BOXOFFICE_DIR (default ./boxoffice)
//   LOGS_DIR      (default ./logs)
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

// ------------------------- CONFIGURATION -------------------------
const CONFIG = {
  API_URL: 'https://districtvenues.text2026mail.workers.dev/?cinema_id={cid}&date={date}',
  VENUES_FILE: 'districtvenues.json',
  CUTOFF_MINS: 200,
  RETRY_ATTEMPTS: 3,
  RETRY_DELAY: 1000,
  FETCH_CONCURRENCY: 30,
  BOXOFFICE_DIR: process.env.BOXOFFICE_DIR || './boxoffice',
  LOGS_DIR: process.env.LOGS_DIR || './logs',
  PRETTY: process.env.PRETTY === 'true',
};

// Ensure directories exist
function ensureDirs() {
  [CONFIG.BOXOFFICE_DIR, CONFIG.LOGS_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });
}
ensureDirs();

// ------------------------- COMPRESSION / DECOMPRESSION -------------------------
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

function decompressShow(arr, dicts) {
  const reverse = {
    cities: Object.fromEntries(Object.entries(dicts.cities).map(([k, v]) => [v, k])),
    states: Object.fromEntries(Object.entries(dicts.states).map(([k, v]) => [v, k])),
    venues: Object.fromEntries(Object.entries(dicts.venues).map(([k, v]) => [v, k])),
    chains: Object.fromEntries(Object.entries(dicts.chains).map(([k, v]) => [v, k])),
    showtimes: Object.fromEntries(Object.entries(dicts.showtimes).map(([k, v]) => [v, k])),
    audis: Object.fromEntries(Object.entries(dicts.audis).map(([k, v]) => [v, k])),
  };
  return {
    city: reverse.cities[arr[0]],
    state: reverse.states[arr[1]],
    venue: reverse.venues[arr[2]],
    chain: reverse.chains[arr[3]],
    time: reverse.showtimes[arr[4]],
    audi: reverse.audis[arr[5]],
    totalSeats: arr[6],
    available: arr[7],
    sold: arr[8],
    gross: arr[9] / 100,
    occupancy: (arr[10] / 100).toFixed(2) + '%',
    minsLeft: arr[11],
  };
}

// ------------------------- HELPERS -------------------------
function roundToHourLabel(timeObj) {
  const mins = timeObj.minute();
  let hour = timeObj.hour();
  if (mins > 45) hour += 1;
  return dayjs(timeObj).hour(hour).minute(0).format('hA');
}

// 🔥 NEW: Convert a key that may include format (e.g., "Movie [3D | English]")
// to the simple "Movie | English" format used by the old code.
function simplifyKey(rawKey) {
  // If it contains brackets, extract movie name and language
  const bracketMatch = rawKey.match(/^(.+?)\s*\[([^\]]+)\]\s*$/);
  if (bracketMatch) {
    const fullName = bracketMatch[1].trim();
    const inside = bracketMatch[2].trim();
    // Split by '|', take the last part as language
    const parts = inside.split('|').map(s => s.trim());
    const lang = parts[parts.length - 1];
    return `${fullName} | ${lang}`;
  }
  // If no brackets, return as is (already "Movie | Language")
  return rawKey;
}

async function fetchWithRetry(url, headers, attempts = CONFIG.RETRY_ATTEMPTS) {
  for (let i = 0; i < attempts; i++) {
    try {
      const resp = await fetch(url, { headers, timeout: 20000 });
      if (resp.ok) return await resp.json();
    } catch (err) {
      if (i === attempts - 1) throw err;
      await new Promise(r => setTimeout(r, CONFIG.RETRY_DELAY * (i + 1)));
    }
  }
  return null;
}

async function fetchVenueData(venue, index, total) {
  const url = CONFIG.API_URL.replace('{cid}', venue.id).replace('{date}', DATE);
  try {
    const data = await fetchWithRetry(url, {
      'User-Agent': process.env.WORKER_UA,
      'x-api-key': process.env.WORKER_KEY,
    });
    if (!data) {
      console.log(`⚠️ [${index}/${total}] ${venue.id} – no data after retries`);
      return null;
    }
    const sessionDates = data?.data?.sessionDates || [];
    if (!sessionDates.includes(DATE)) {
      console.log(`⏭️ [${index}/${total}] ${venue.id} – no shows for ${DATE}`);
      return null;
    }
    console.log(`✅ [${index}/${total}] ${venue.id} – fetched (${sessionDates.length} dates)`);
    return { venue, data };
  } catch (err) {
    console.log(`❌ [${index}/${total}] ${venue.id} – error: ${err.message}`);
    return null;
  }
}

// ------------------------- MAIN -------------------------
const nowIST = dayjs().tz('Asia/Kolkata');
const DATE = nowIST.format('YYYY-MM-DD');
const MONTH_YEAR = nowIST.format('MM-YYYY');

const detailedPath = path.join(CONFIG.BOXOFFICE_DIR, `${DATE}_Detailed.json`);
const monthlyLogPath = path.join(CONFIG.LOGS_DIR, `${MONTH_YEAR}.json`);

// Load existing detailed (if any)
let existingShows = {};
if (fs.existsSync(detailedPath)) {
  try {
    const oldData = JSON.parse(fs.readFileSync(detailedPath, 'utf8'));
    if (oldData.movies) {
      for (const [movie, compressedShows] of Object.entries(oldData.movies)) {
        if (movie === 'date' || movie === 'lastUpdated' || movie === 'dicts') continue;
        // 🔥 Convert old key (which may include format) to simple "Movie | Language"
        const simpleKey = simplifyKey(movie);
        if (!existingShows[simpleKey]) existingShows[simpleKey] = [];
        const decompressed = compressedShows.map(arr => decompressShow(arr, oldData.dicts));
        // Merge (no duplicates because venue+time+audi uniquely identify a show)
        existingShows[simpleKey].push(...decompressed);
      }
    }
  } catch (err) {
    console.warn('⚠️ Could not load old detailed file, starting fresh.', err.message);
    existingShows = {};
  }
}

const VENUES = JSON.parse(fs.readFileSync(CONFIG.VENUES_FILE, 'utf8'));

async function fetchAll() {
  const results = [];
  const concurrency = CONFIG.FETCH_CONCURRENCY;
  const total = VENUES.length;
  console.log(`📡 Fetching ${total} venues (concurrency ${concurrency})...`);
  let completed = 0;
  for (let i = 0; i < total; i += concurrency) {
    const chunk = VENUES.slice(i, i + concurrency);
    const chunkPromises = chunk.map((v, idx) => fetchVenueData(v, i + idx + 1, total));
    const chunkResults = await Promise.all(chunkPromises);
    results.push(...chunkResults);
    completed += chunk.length;
    console.log(`📊 Progress: ${completed}/${total} venues processed`);
  }
  return results;
}

(async function main() {
  const startTime = Date.now();
  console.log(`📅 Daily Boxoffice for ${DATE}`);

  // 1. Fetch live data
  const results = await fetchAll();

  // 2. Update existingShows with new shows (only if within cutoff)
  for (const res of results) {
    if (!res) continue;
    const { venue, data } = res;
    const city = venue.city;
    const state = venue.state || 'Unknown';
    const chain = venue.chainKey || 'Unknown';

    const moviesMap = {};
    (data.meta?.movies || []).forEach(m => (moviesMap[m.id] = m));

    for (const session of data.pageData?.sessions || []) {
      const movie = moviesMap[session.mid];
      if (!movie) continue;

      const showTime = dayjs.utc(session.showTime).tz('Asia/Kolkata');
      const minutesLeft = showTime.diff(nowIST, 'minute');
      if (minutesLeft >= CONFIG.CUTOFF_MINS) continue;

      const name = movie.name;
      const lang = session.lang || movie.lang || '';

      // 🔥 Use the SAME simple key as the old code – no format included
      const key = `${name} | ${lang}`;

      if (!existingShows[key]) existingShows[key] = [];

      const total = session.total || 0;
      const avail = session.avail || 0;
      const sold = total - avail;
      let gross = 0;
      (session.areas || []).forEach(a => {
        gross += (a.sTotal - a.sAvail) * (a.price || 0);
      });

      const newShow = {
        time: showTime.format('hh:mm A'),
        audi: session.audi || '',
        totalSeats: total,
        available: avail,
        sold,
        gross,
        minsLeft: minutesLeft,
        venue: venue.name,
        city,
        state,
        chain,
      };

      const existingIndex = existingShows[key].findIndex(e =>
        e.venue === venue.name &&
        e.time === newShow.time &&
        e.audi === newShow.audi
      );
      if (existingIndex !== -1) {
        existingShows[key][existingIndex] = newShow;
      } else {
        existingShows[key].push(newShow);
      }
    }
  }

  // 3. Build dictionaries from all shows
  const allShows = Object.values(existingShows).flat();
  const dicts = buildDictionaries(allShows);

  // 4. Compress each movie's shows
  const compressedMovies = {};
  for (const [movie, shows] of Object.entries(existingShows)) {
    compressedMovies[movie] = compressShows(shows, dicts.forward);
  }

  // 5. Compute per-movie totals for monthly logs (top 50)
  const summaryForLogs = {};
  for (const [movieKey, shows] of Object.entries(existingShows)) {
    if (!Array.isArray(shows)) continue;
    let gross = 0, sold = 0, totalSeats = 0, showsCount = 0;
    for (const s of shows) {
      gross += s.gross;
      sold += s.sold;
      totalSeats += s.totalSeats;
      showsCount++;
    }
    summaryForLogs[movieKey] = {
      gross: gross,
      sold: sold,
      shows: showsCount,
      totalSeats: totalSeats,
    };
  }

  // 6. Update monthly logs (top 50, compressed array format)
  let monthlyLogs = {};
  if (fs.existsSync(monthlyLogPath)) {
    try { monthlyLogs = JSON.parse(fs.readFileSync(monthlyLogPath, 'utf8')); } catch { monthlyLogs = {}; }
  }

  const roundedLabel = roundToHourLabel(nowIST);
  const stamp = `${roundedLabel}, ${nowIST.format('DD/MM/YYYY')}`;

  const top50 = Object.entries(summaryForLogs)
    .sort((a, b) => b[1].gross - a[1].gross)
    .slice(0, 50);

  for (const [movie, data] of top50) {
    if (!monthlyLogs[movie]) monthlyLogs[movie] = {};
    monthlyLogs[movie][stamp] = [
      Math.round(data.gross * 100),   // gross in paisa
      data.sold,
      data.shows,
      data.totalSeats ? Math.round((data.sold / data.totalSeats) * 10000) : 0
    ];
  }

  // 7. Write compressed detailed file
  const outputDetailed = {
    date: DATE,
    lastUpdated: nowIST.format('hh:mm A, DD MMMM YYYY'),
    dicts: dicts.forward,
    movies: compressedMovies,
  };
  const newDetailed = CONFIG.PRETTY ? JSON.stringify(outputDetailed, null, 2) : JSON.stringify(outputDetailed);
  const oldDetailed = fs.existsSync(detailedPath) ? fs.readFileSync(detailedPath, 'utf8') : '';
  if (newDetailed !== oldDetailed) {
    fs.writeFileSync(detailedPath, newDetailed, 'utf8');
    console.log(`✅ Updated detailed: ${detailedPath}`);
  } else {
    console.log(`⏭️ No changes to detailed: ${detailedPath}`);
  }

  // 8. Write monthly logs (compressed arrays)
  const newLog = CONFIG.PRETTY ? JSON.stringify(monthlyLogs, null, 2) : JSON.stringify(monthlyLogs);
  const oldLog = fs.existsSync(monthlyLogPath) ? fs.readFileSync(monthlyLogPath, 'utf8') : '';
  if (newLog !== oldLog) {
    fs.writeFileSync(monthlyLogPath, newLog, 'utf8');
    console.log(`✅ Updated logs: ${monthlyLogPath}`);
  } else {
    console.log(`⏭️ No changes to logs: ${monthlyLogPath}`);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`✅ Daily Boxoffice completed in ${elapsed}s.`);
})();
