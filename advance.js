// advance.js – Daily Advance (tomorrow) – Supercompressed format
// Output directory: ADVANCE_DIR (default ./advance)
// Environment:
//   ADVANCE_DIR  – output directory (default ./advance)
//   PRETTY       – set to 'true' for pretty-printed JSON (default false)

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
  API_URL: 'https://districtvenues.text2027mail.workers.dev/?cinema_id={cid}&date={date}',
  VENUES_FILE: 'districtvenues.json',
  RETRY_ATTEMPTS: 3,
  RETRY_DELAY: 1000,
  FETCH_CONCURRENCY: 10,
  ADVANCE_DIR: process.env.ADVANCE_DIR || './advance',
  PRETTY: process.env.PRETTY === 'true', // default false
};

// Ensure directory exists
if (!fs.existsSync(CONFIG.ADVANCE_DIR)) {
  fs.mkdirSync(CONFIG.ADVANCE_DIR, { recursive: true });
}

// ------------------------- COMPRESSION / DECOMPRESSION (identical to fetchold.js) -------------------------
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
    // minsLeft always 0 for advance bookings (no cutoff)
    return [cityId, stateId, venueId, chainId, timeId, audiId, total, avail, sold, gross, occupancy, 0];
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

// ------------------------- FETCH HELPERS -------------------------
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

async function fetchVenueData(venue) {
  const url = CONFIG.API_URL.replace('{cid}', venue.id).replace('{date}', DATE);
  try {
    const data = await fetchWithRetry(url, {
      'User-Agent': process.env.WORKER_UA,
      'x-api-key': process.env.WORKER_KEY,
    });
    if (!data) return null;
    const sessionDates = data?.data?.sessionDates || [];
    if (!sessionDates.includes(DATE)) return null;
    return { venue, data };
  } catch {
    return null;
  }
}

// ------------------------- MAIN LOGIC -------------------------
const nowIST = dayjs().tz('Asia/Kolkata');
const DATE = nowIST.add(1, 'day').format('YYYY-MM-DD');
const detailedPath = path.join(CONFIG.ADVANCE_DIR, `${DATE}_Detailed.json`);

// Load existing advance data (if any)
let existingShows = {};
if (fs.existsSync(detailedPath)) {
  try {
    const oldData = JSON.parse(fs.readFileSync(detailedPath, 'utf8'));
    if (oldData.movies) {
      for (const [movie, compressedShows] of Object.entries(oldData.movies)) {
        if (movie === 'date' || movie === 'lastUpdated' || movie === 'dicts') continue;
        existingShows[movie] = compressedShows.map(arr => decompressShow(arr, oldData.dicts));
      }
    }
  } catch { existingShows = {}; }
}

// Load venues
const VENUES = JSON.parse(fs.readFileSync(CONFIG.VENUES_FILE, 'utf8'));

// Fetch all venues with concurrency
async function fetchAll() {
  const results = [];
  const concurrency = CONFIG.FETCH_CONCURRENCY;
  for (let i = 0; i < VENUES.length; i += concurrency) {
    const chunk = VENUES.slice(i, i + concurrency);
    const chunkResults = await Promise.all(chunk.map(v => fetchVenueData(v)));
    results.push(...chunkResults);
  }
  return results;
}

(async function main() {
  console.log(`📅 Daily Advance for ${DATE}`);

  const results = await fetchAll();

  for (const res of results) {
    if (!res) continue;
    const { venue, data } = res;
    // Keep state and chain raw – no formatting, matches fetchold.js
    const city = venue.city;
    const state = venue.state || 'Unknown';
    const chain = venue.chainKey || 'Unknown';

    const moviesMap = {};
    (data.meta?.movies || []).forEach(m => (moviesMap[m.id] = m));

    for (const session of data.pageData?.sessions || []) {
      const movie = moviesMap[session.mid];
      if (!movie) continue;

      const name = movie.name;
      const lang = session.lang || movie.lang || '';
      const format = session.scrnFmt || '';
      const formattedFormat = format ? format.replace(/-/g, ' | ') : '';
      const key = formattedFormat ? `${name} [${formattedFormat} | ${lang}]` : `${name} | ${lang}`;

      if (!existingShows[key]) existingShows[key] = [];

      const total = session.total || 0;
      const avail = session.avail || 0;
      const sold = total - avail;
      let gross = 0;
      (session.areas || []).forEach(a => {
        gross += (a.sTotal - a.sAvail) * (a.price || 0);
      });

      const newShow = {
        time: session.showTime ? dayjs.utc(session.showTime).tz('Asia/Kolkata').format('hh:mm A') : '',
        audi: session.audi || '',
        totalSeats: total,
        available: avail,
        sold,
        gross,
        venue: venue.name,
        city,
        state,
        chain,
      };

      // Update or append (same venue/time/audi)
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

  // Build dictionaries from all shows
  const allShows = Object.values(existingShows).flat();
  const dicts = buildDictionaries(allShows);

  const compressedMovies = {};
  for (const [movie, shows] of Object.entries(existingShows)) {
    compressedMovies[movie] = compressShows(shows, dicts.forward);
  }

  const outputDetailed = {
    date: DATE,
    lastUpdated: nowIST.format('hh:mm A, DD MMMM YYYY'),
    dicts: dicts.forward,
    movies: compressedMovies,
  };

  // Write with minified JSON by default (unless PRETTY=true)
  const newStr = CONFIG.PRETTY ? JSON.stringify(outputDetailed, null, 2) : JSON.stringify(outputDetailed);
  let oldStr = '';
  if (fs.existsSync(detailedPath)) {
    oldStr = fs.readFileSync(detailedPath, 'utf8');
  }
  if (newStr !== oldStr) {
    fs.writeFileSync(detailedPath, newStr, 'utf8');
    console.log(`✅ Updated advance: ${detailedPath}`);
  } else {
    console.log(`⏭️ No changes to advance: ${detailedPath}`);
  }

  console.log('✅ Daily Advance completed.');
})();
