// advancebo.js – Enterprise‑grade Daily Advance Bookings (Supercompressed format)
// Output directory can be overridden by env var: ADVANCE_DIR (default ./advance)
//   PRETTY – set to 'true' for pretty-printed JSON (default false)

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

dayjs.extend(utc);
dayjs.extend(timezone);

// ------------------------- CONFIGURATION -------------------------
const CONFIG = {
  API_URL: 'https://districtvenues.text2027mail.workers.dev/?cinema_id={cid}&date={date}',
  VENUES_FILE: 'districtvenues.json',
  CUTOFF_MINS: 200,              // not critical for advance, but keep
  RETRY_ATTEMPTS: 3,
  RETRY_DELAY: 1000,
  FETCH_CONCURRENCY: 30,
  ADVANCE_DIR: process.env.ADVANCE_DIR || './advance',
  PRETTY: process.env.PRETTY === 'true',
};

// Ensure directory exists
function ensureDirs() {
  if (!fs.existsSync(CONFIG.ADVANCE_DIR)) {
    fs.mkdirSync(CONFIG.ADVANCE_DIR, { recursive: true });
  }
}
ensureDirs();

// ------------------------- COMPRESSION / DECOMPRESSION (unchanged) -------------------------
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
function simplifyKey(rawKey) {
  // Convert "Movie [Format | Language]" -> "Movie | Language"
  const bracketMatch = rawKey.match(/^(.+?)\s*\[([^\]]+)\]\s*$/);
  if (bracketMatch) {
    const fullName = bracketMatch[1].trim();
    const inside = bracketMatch[2].trim();
    const parts = inside.split('|').map(s => s.trim());
    const lang = parts[parts.length - 1];
    return `${fullName} | ${lang}`;
  }
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

// ------------------------- MAIN (tomorrow's date) -------------------------
const nowIST = dayjs().tz('Asia/Kolkata');
const DATE = nowIST.add(1, 'day').format('YYYY-MM-DD');   // +1 day

const detailedPath = path.join(CONFIG.ADVANCE_DIR, `${DATE}_Detailed.json`);

// Load existing detailed (if any)
let existingShows = {};
if (fs.existsSync(detailedPath)) {
  try {
    const oldData = JSON.parse(fs.readFileSync(detailedPath, 'utf8'));
    if (oldData.movies) {
      for (const [movie, compressedShows] of Object.entries(oldData.movies)) {
        if (movie === 'date' || movie === 'lastUpdated' || movie === 'dicts') continue;
        const simpleKey = simplifyKey(movie);
        if (!existingShows[simpleKey]) existingShows[simpleKey] = [];
        const decompressed = compressedShows.map(arr => decompressShow(arr, oldData.dicts));
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
  console.log(`📡 Fetching ${total} venues (concurrency ${concurrency}) for ${DATE}...`);
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
  console.log(`📅 Advance Bookings for ${DATE}`);

  // 1. Fetch live data
  const results = await fetchAll();

  // 2. Update existingShows with new shows (only if within cutoff; for advance we keep all)
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
      // For advance, we don't filter by cutoff; keep all shows for tomorrow
      // const minutesLeft = showTime.diff(nowIST, 'minute');
      // if (minutesLeft >= CONFIG.CUTOFF_MINS) continue;

      const name = movie.name;
      const lang = session.lang || movie.lang || '';
      const key = `${name} | ${lang}`;   // Simple key – merges all formats

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
        minsLeft: 0,   // not used for advance
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

  // 5. Write compressed detailed file (no summary, no logs)
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

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`✅ Advance bookings completed in ${elapsed}s.`);
})();
