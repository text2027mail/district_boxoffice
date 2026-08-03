// dailybo.js – Fast Daily Boxoffice (no compression, full JSON)
// Directories can be overridden by env vars:
//   BOXOFFICE_DIR (default ./boxoffice)
//   LOGS_DIR      (default ./logs)
//   PRETTY        – set to 'true' for pretty-printed JSON (default false)

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
  FETCH_CONCURRENCY: 20,                // increased for speed
  BOXOFFICE_DIR: process.env.BOXOFFICE_DIR || './boxoffice',
  LOGS_DIR: process.env.LOGS_DIR || './logs',
  PRETTY: process.env.PRETTY === 'true',
};

// Ensure directories exist
[CONFIG.BOXOFFICE_DIR, CONFIG.LOGS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

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
    if (!data) {
      console.log(`⚠️ ${venue.id} – no data (failed after retries)`);
      return null;
    }
    const sessionDates = data?.data?.sessionDates || [];
    if (!sessionDates.includes(DATE)) {
      console.log(`⏭️ ${venue.id} – no shows for ${DATE}`);
      return null;
    }
    console.log(`✅ ${venue.id} – fetched (${sessionDates.length} dates)`);
    return { venue, data };
  } catch (err) {
    console.log(`❌ ${venue.id} – error: ${err.message}`);
    return null;
  }
}

// ------------------------- MAIN LOGIC -------------------------
const nowIST = dayjs().tz('Asia/Kolkata');
const DATE = nowIST.format('YYYY-MM-DD');
const MONTH_YEAR = nowIST.format('MM-YYYY');

const detailedPath = path.join(CONFIG.BOXOFFICE_DIR, `${DATE}_Detailed.json`);
const summaryPath  = path.join(CONFIG.BOXOFFICE_DIR, `${DATE}.json`);
const monthlyLogPath = path.join(CONFIG.LOGS_DIR, `${MONTH_YEAR}.json`);

// Load existing detailed (full data, no compression)
let detailedOutput = {};
if (fs.existsSync(detailedPath)) {
  try {
    detailedOutput = JSON.parse(fs.readFileSync(detailedPath, 'utf8'));
    // remove meta fields to avoid mixing
    delete detailedOutput.date;
    delete detailedOutput.lastUpdated;
  } catch {
    detailedOutput = {};
  }
}

// Load venues
const VENUES = JSON.parse(fs.readFileSync(CONFIG.VENUES_FILE, 'utf8'));

// Fetch all venues with concurrency
async function fetchAll() {
  const results = [];
  const concurrency = CONFIG.FETCH_CONCURRENCY;
  console.log(`📡 Fetching ${VENUES.length} venues (concurrency ${concurrency})...`);
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

  // 2. Update detailedOutput with new shows (only if within cutoff)
  for (const res of results) {
    if (!res) continue;
    const { venue, data } = res;
    const city = venue.city;
    const state = formatState(venue.state);

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
      const key = `${name} | ${lang}`;

      if (!detailedOutput[key]) detailedOutput[key] = [];

      const total = session.total || 0;
      const avail = session.avail || 0;
      const sold = total - avail;
      let gross = 0;
      (session.areas || []).forEach(a => {
        gross += (a.sTotal - a.sAvail) * (a.price || 0);
      });

      const newEntry = {
        city,
        state,
        venue: venue.name,
        time: showTime.format('hh:mm A'),
        audi: session.audi || '',
        totalSeats: total,
        available: avail,
        sold,
        gross,
        occupancy: total ? `${((sold / total) * 100).toFixed(2)}%` : '0%',
        minsLeft: minutesLeft,
      };

      const existingIndex = detailedOutput[key].findIndex(
        e => e.venue === venue.name &&
             e.time === newEntry.time &&
             e.audi === newEntry.audi
      );
      if (existingIndex !== -1) {
        detailedOutput[key][existingIndex] = newEntry;
      } else {
        detailedOutput[key].push(newEntry);
      }
    }
  }

  // 3. Build summary from detailedOutput
  const summary = {};
  for (const [movieKey, shows] of Object.entries(detailedOutput)) {
    if (movieKey === 'date' || movieKey === 'lastUpdated') continue;
    if (!Array.isArray(shows)) continue;

    summary[movieKey] = {
      shows: 0,
      gross: 0,
      sold: 0,
      totalSeats: 0,
      venues: new Set(),
      cities: new Set(),
      fastfilling: 0,
      housefull: 0,
      cityDetails: {},
    };

    for (const s of shows) {
      const total = Number(s.totalSeats || 0);
      const sold = Number(s.sold || 0);
      const gross = Number(s.gross || 0);
      const occ = total ? (sold / total) * 100 : 0;

      summary[movieKey].shows++;
      summary[movieKey].gross += gross;
      summary[movieKey].sold += sold;
      summary[movieKey].totalSeats += total;
      summary[movieKey].venues.add(s.venue);
      summary[movieKey].cities.add(s.city);

      if (occ >= 50 && occ < 98) summary[movieKey].fastfilling++;
      if (occ >= 98) summary[movieKey].housefull++;

      const cityStateKey = `${s.city} | ${s.state}`;
      if (!summary[movieKey].cityDetails[cityStateKey]) {
        summary[movieKey].cityDetails[cityStateKey] = {
          city: s.city,
          state: s.state,
          shows: 0,
          gross: 0,
          sold: 0,
          totalSeats: 0,
          fastfilling: 0,
          housefull: 0,
        };
      }
      const c = summary[movieKey].cityDetails[cityStateKey];
      c.shows++;
      c.gross += gross;
      c.sold += sold;
      c.totalSeats += total;
      if (occ >= 50 && occ < 98) c.fastfilling++;
      if (occ >= 98) c.housefull++;
    }
  }

  // Build final summary object (with city venue counts)
  const finalSummaryData = {};
  for (const [movie, vals] of Object.entries(summary)) {
    finalSummaryData[movie] = {
      shows: vals.shows,
      gross: +vals.gross.toFixed(2),
      sold: vals.sold,
      totalSeats: vals.totalSeats,
      venues: vals.venues.size,
      cities: vals.cities.size,
      fastfilling: vals.fastfilling,
      housefull: vals.housefull,
      occupancy: vals.totalSeats ? +(vals.sold / vals.totalSeats * 100).toFixed(2) : 0,
      details: Object.values(vals.cityDetails).map(d => {
        // compute venues for this city (from detailedOutput)
        const cityVenues = new Set();
        if (detailedOutput[movie]) {
          detailedOutput[movie].forEach(s => {
            if (s.city === d.city && s.state === d.state) cityVenues.add(s.venue);
          });
        }
        return {
          city: d.city,
          state: d.state,
          shows: d.shows,
          gross: +d.gross.toFixed(2),
          sold: d.sold,
          venues: cityVenues.size,
          fastfilling: d.fastfilling,
          housefull: d.housefull,
          occupancy: d.totalSeats ? +(d.sold / d.totalSeats * 100).toFixed(2) : 0,
        };
      }),
    };
  }

  // 4. Monthly logs (top 50 by gross)
  let monthlyLogs = {};
  if (fs.existsSync(monthlyLogPath)) {
    try { monthlyLogs = JSON.parse(fs.readFileSync(monthlyLogPath, 'utf8')); } catch { monthlyLogs = {}; }
  }

  const roundedLabel = roundToHourLabel(nowIST);
  const stamp = `${roundedLabel}, ${nowIST.format('DD/MM/YYYY')}`;

  const top50 = Object.entries(finalSummaryData)
    .sort((a, b) => b[1].gross - a[1].gross)
    .slice(0, 50);

  for (const [movie, data] of top50) {
    if (!monthlyLogs[movie]) monthlyLogs[movie] = {};
    monthlyLogs[movie][stamp] = {
      gross: data.gross,
      tickets: data.sold,
      occ: `${data.occupancy}%`,
      shows: data.shows,
    };
  }

  // 5. Write output files
  const formattedLastUpdated = nowIST.format('hh:mm A, DD MMMM YYYY');

  const outputSummary = {
    date: DATE,
    lastUpdated: formattedLastUpdated,
    ...finalSummaryData,
  };

  const outputDetailed = {
    date: DATE,
    lastUpdated: formattedLastUpdated,
    ...detailedOutput,
  };

  const stringify = (obj) => CONFIG.PRETTY ? JSON.stringify(obj, null, 2) : JSON.stringify(obj);

  fs.writeFileSync(summaryPath, stringify(outputSummary), 'utf8');
  fs.writeFileSync(detailedPath, stringify(outputDetailed), 'utf8');
  fs.writeFileSync(monthlyLogPath, stringify(monthlyLogs), 'utf8');

  console.log(`✅ Summary saved: ${summaryPath}`);
  console.log(`✅ Detailed saved: ${detailedPath}`);
  console.log(`✅ Monthly logs saved: ${monthlyLogPath}`);
  console.log('✅ Daily Boxoffice completed.');
})();
