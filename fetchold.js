// fetchold.js – Download old JSONs from GitHub, convert to new compressed format,
// and save under districtdata2026/{boxoffice,advance}/.
// Run once to migrate historical data.

require('dotenv').config();
const fs = require('fs');
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

const OUT_DIR = './districtdata2026';
const BOXOFFICE_OUT = path.join(OUT_DIR, 'boxoffice');
const ADVANCE_OUT = path.join(OUT_DIR, 'advance');
const LOGS_OUT = path.join(OUT_DIR, 'logs');

function ensureDirs() {
  [OUT_DIR, BOXOFFICE_OUT, ADVANCE_OUT, LOGS_OUT].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });
}
ensureDirs();

// ------------------------- HELPERS (same compress/decompress as dailybo) -------------------------
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
    // For advance, no minsLeft, but we keep consistent: use 0 for advance.
    return [cityId, stateId, venueId, chainId, timeId, audiId, total, avail, sold, gross, occupancy, minsLeft];
  });
}

// ------------------------- DOWNLOAD AND CONVERT -------------------------
async function downloadAndConvert(url, outFile, isAdvance = false) {
  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      console.log(`⚠️ Failed to fetch ${url} (status ${resp.status})`);
      return false;
    }
    const data = await resp.json();
    // data is the old format: { date, lastUpdated, ...movies }
    // For boxoffice, it has shows with city, state, venue, chain, time, audi, totalSeats, available, sold, gross, minsLeft.
    // For advance, similar but no minsLeft.
    const movies = {};
    let totalShows = 0;
    for (const [key, value] of Object.entries(data)) {
      if (key === 'date' || key === 'lastUpdated') continue;
      // value is an array of show objects (old format)
      if (Array.isArray(value)) {
        // Convert each show: ensure we have needed fields
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

    // Build dictionaries from all shows
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

    fs.writeFileSync(outFile, JSON.stringify(output, null, 2), 'utf8');
    console.log(`✅ Converted ${outFile} (${totalShows} shows)`);
    return true;
  } catch (err) {
    console.log(`❌ Error processing ${url}: ${err.message}`);
    return false;
  }
}

// ------------------------- MAIN -------------------------
(async function main() {
  // We'll iterate from August 2025 to today
  const startDate = dayjs('2025-08-01');
  const endDate = dayjs().tz('Asia/Kolkata');

  let current = startDate;
  let successCount = 0, failCount = 0;

  while (current.isBefore(endDate) || current.isSame(endDate, 'day')) {
    const dateStr = current.format('YYYY-MM-DD');
    const boxofficeUrl = `${BASE_URL_BOXOFFICE}${dateStr}_Detailed.json`;
    const advanceUrl = `${BASE_URL_ADVANCE}${dateStr}_Detailed.json`;

    const boxofficeOut = path.join(BOXOFFICE_OUT, `${dateStr}_Detailed.json`);
    const advanceOut = path.join(ADVANCE_OUT, `${dateStr}_Detailed.json`);

    // Skip if already exists
    if (fs.existsSync(boxofficeOut)) {
      console.log(`⏭️ Boxoffice ${dateStr} already exists, skipping.`);
    } else {
      console.log(`⬇️ Downloading boxoffice ${dateStr}...`);
      const ok = await downloadAndConvert(boxofficeUrl, boxofficeOut, false);
      if (ok) successCount++; else failCount++;
    }

    if (fs.existsSync(advanceOut)) {
      console.log(`⏭️ Advance ${dateStr} already exists, skipping.`);
    } else {
      console.log(`⬇️ Downloading advance ${dateStr}...`);
      const ok = await downloadAndConvert(advanceUrl, advanceOut, true);
      if (ok) successCount++; else failCount++;
    }

    current = current.add(1, 'day');
  }

  // Also download monthly logs (optional)
  console.log('\n📊 Downloading monthly logs...');
  const months = [];
  let m = dayjs('2025-08-01');
  while (m.isBefore(endDate) || m.isSame(endDate, 'month')) {
    months.push(m.format('MM-YYYY'));
    m = m.add(1, 'month');
  }
  for (const month of months) {
    const logUrl = `${LOGS_URL}${month}.json`;
    const logOut = path.join(LOGS_OUT, `${month}.json`);
    if (fs.existsSync(logOut)) {
      console.log(`⏭️ Log ${month} already exists.`);
      continue;
    }
    try {
      const resp = await fetch(logUrl);
      if (resp.ok) {
        const data = await resp.json();
        fs.writeFileSync(logOut, JSON.stringify(data, null, 2), 'utf8');
        console.log(`✅ Log ${month} downloaded.`);
      } else {
        console.log(`⚠️ Log ${month} not found.`);
      }
    } catch (err) {
      console.log(`❌ Error downloading log ${month}: ${err.message}`);
    }
  }

  console.log(`\n✅ Migration complete. Success: ${successCount}, Fail: ${failCount}`);
})();
