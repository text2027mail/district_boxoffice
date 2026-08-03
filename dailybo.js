// dailybo.js – Enterprise-grade Daily Boxoffice
// Output directories can be overridden by env vars:
//   BOXOFFICE_DIR (default ./boxoffice)
//   LOGS_DIR      (default ./logs)

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
  API_URL: 'https://districtvenues.text2026mail.workers.dev/?cinema_id={cid}&date={date}',
  VENUES_FILE: 'districtvenues.json',
  CUTOFF_MINS: 200,
  RETRY_ATTEMPTS: 3,
  RETRY_DELAY: 1000,
  FETCH_CONCURRENCY: 10,
  BOXOFFICE_DIR: process.env.BOXOFFICE_DIR || './boxoffice',
  LOGS_DIR: process.env.LOGS_DIR || './logs',
};

// Ensure directories exist
function ensureDirs() {
  [CONFIG.BOXOFFICE_DIR, CONFIG.LOGS_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });
}
ensureDirs();

// ------------------------- HELPERS -------------------------
function formatState(stateStr) {
  if (!stateStr || typeof stateStr !== 'string') return 'Unknown';
  return stateStr.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function roundToHourLabel(timeObj) {
  const mins = timeObj.minute();
  let hour = timeObj.hour();
  if (mins > 45) hour += 1;
  return dayjs(timeObj).hour(hour).minute(0).format('hA');
}

// ------------------------- FETCH WITH RETRIES -------------------------
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

// ------------------------- COMPRESS / DECOMPRESS (with embedded dictionaries) -------------------------
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
    const gross = Math.round(s.gross * 100); // paisa
    const occupancy = total ? Math.round((sold / total) * 10000) : 0; // basis points
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

// ------------------------- MAIN LOGIC -------------------------
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
  console.log(`📅 Daily Boxoffice for ${DATE}`);

  // 1. Fetch live data
  const results = await fetchAll();

  // 2. Update existingShows with new shows (only if within cutoff)
  for (const res of results) {
    if (!res) continue;
    const { venue, data } = res;
    const city = venue.city;
    const state = formatState(venue.state);
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

      // Check for existing entry (venue, time, audi)
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

  // 3. Build dictionaries from all shows (union of all movies)
  const allShows = Object.values(existingShows).flat();
  const dicts = buildDictionaries(allShows);

  // 4. Compress each movie's shows
  const compressedMovies = {};
  for (const [movie, shows] of Object.entries(existingShows)) {
    compressedMovies[movie] = compressShows(shows, dicts.forward);
  }

  // 5. Update monthly logs (top 50 by gross)
  let monthlyLogs = {};
  if (fs.existsSync(monthlyLogPath)) {
    try { monthlyLogs = JSON.parse(fs.readFileSync(monthlyLogPath, 'utf8')); } catch { monthlyLogs = {}; }
  }

  // Compute summary from existingShows
  const summary = {};
  for (const [movie, shows] of Object.entries(existingShows)) {
    let totalGross = 0, totalSold = 0, totalShows = 0, totalSeats = 0;
    for (const s of shows) {
      totalGross += s.gross;
      totalSold += s.sold;
      totalShows++;
      totalSeats += s.totalSeats;
    }
    summary[movie] = { gross: totalGross, sold: totalSold, shows: totalShows, seats: totalSeats };
  }
  const top50 = Object.entries(summary)
    .sort((a, b) => b[1].gross - a[1].gross)
    .slice(0, 50);

  const roundedLabel = roundToHourLabel(nowIST);
  const stamp = `${roundedLabel}, ${nowIST.format('DD/MM/YYYY')}`;
  for (const [movie, data] of top50) {
    if (!monthlyLogs[movie]) monthlyLogs[movie] = {};
    monthlyLogs[movie][stamp] = [
      Math.round(data.gross * 100), // gross in paisa
      data.sold,
      data.shows,
      data.seats ? Math.round((data.sold / data.seats) * 10000) : 0, // occupancy bp
    ];
  }

  // 6. Write compressed detailed file with embedded dictionaries
  const outputDetailed = {
    date: DATE,
    lastUpdated: nowIST.format('hh:mm A, DD MMMM YYYY'),
    dicts: dicts.forward,
    movies: compressedMovies,
  };

  const newStr = JSON.stringify(outputDetailed, null, 2);
  let oldStr = '';
  if (fs.existsSync(detailedPath)) {
    oldStr = fs.readFileSync(detailedPath, 'utf8');
  }
  if (newStr !== oldStr) {
    fs.writeFileSync(detailedPath, newStr, 'utf8');
    console.log(`✅ Updated detailed: ${detailedPath}`);
  } else {
    console.log(`⏭️ No changes to detailed: ${detailedPath}`);
  }

  // Write monthly logs (already compressed)
  const logStr = JSON.stringify(monthlyLogs, null, 2);
  if (!fs.existsSync(monthlyLogPath) || logStr !== fs.readFileSync(monthlyLogPath, 'utf8')) {
    fs.writeFileSync(monthlyLogPath, logStr, 'utf8');
    console.log(`✅ Updated logs: ${monthlyLogPath}`);
  } else {
    console.log(`⏭️ No changes to logs: ${monthlyLogPath}`);
  }

  console.log('✅ Daily Boxoffice completed.');
})();
