import json
import requests
import os
import re
from datetime import datetime, timedelta, timezone
from concurrent.futures import ThreadPoolExecutor, as_completed

# =====================================================
# CONFIGURATION
# =====================================================

BASE_URL = "https://districtdata2026.pages.dev/advance"
OUTPUT_FILE = "movielist.json"
DEFAULT_START_DATE = "2025-09-01"

FUTURE_DAYS = 10
CONCURRENCY = 100
REQUEST_TIMEOUT = 20

IST = timezone(timedelta(hours=5, minutes=30))

# =====================================================
# TIME HELPERS
# =====================================================

def today_ist():
    return datetime.now(IST).date()

# =====================================================
# NORMALIZE MOVIE NAME
# =====================================================

def normalize_movie(name):
    """For duplicate detection – removes colons/hyphens and lowercases."""
    name = str(name).strip().lower()
    name = re.sub(r"[:\-]", "", name)
    name = re.sub(r"\s+", " ", name)
    return name.strip()

# =====================================================
# FETCH DAILY JSON
# =====================================================

def fetch_daily_json(date_str):
    """Fetch Detailed JSON for a given date."""
    url = f"{BASE_URL}/{date_str}_Detailed.json"

    try:
        print(f"📥 Fetching {date_str} ...")

        response = requests.get(
            url,
            timeout=REQUEST_TIMEOUT
        )

        if response.status_code == 200:
            data = response.json()

            if isinstance(data, dict) and isinstance(data.get("movies"), dict):
                print(
                    f"   ✅ {date_str} → "
                    f"{len(data['movies'])} movie entries"
                )
                return date_str, data

            print(f"   ⚠️ {date_str} → Invalid movies structure")

        elif response.status_code == 404:
            print(f"   ⏭️ {date_str} → 404")

        else:
            print(f"   ⚠️ {date_str} → HTTP {response.status_code}")

    except requests.RequestException as e:
        print(f"   ⚠️ {date_str} → Request error: {e}")

    except Exception as e:
        print(f"   ⚠️ {date_str} → Error: {e}")

    return date_str, None

# =====================================================
# PARSE MOVIE KEY
# =====================================================

def parse_movie_key(key):
    """
    Handle both old and new key formats:

    Old:
        "Movie Name [2D | Hindi]" → ("Movie Name", "Hindi")

    New:
        "Jolly | Kannada" → ("Jolly", "Kannada")
    """

    key = str(key).strip()

    # Old bracket format
    if "[" in key and "]" in key:
        base = key.split("[", 1)[0].strip()
        inside = key.split("[", 1)[1].split("]", 1)[0]

        if "|" in inside:
            parts = [p.strip() for p in inside.split("|")]

            if parts:
                return base, parts[-1]

        return base, "Unknown"

    # New pipe format
    if "|" in key:
        parts = [p.strip() for p in key.split("|")]

        if len(parts) >= 2:
            return parts[0], parts[-1]

    return key, "Unknown"

# =====================================================
# LOAD EXISTING MOVIELIST
# Supports old & compact formats
# =====================================================

def load_existing():
    """Load existing movielist.json, keyed by normalized movie name."""

    movie_dict = {}

    if not os.path.exists(OUTPUT_FILE):
        return movie_dict

    try:
        with open(OUTPUT_FILE, "r", encoding="utf-8") as f:
            old = json.load(f)

        # -------------------------------------------------
        # NEW COMPACT FORMAT
        # -------------------------------------------------

        if "m" in old and isinstance(old["m"], list):

            for entry in old["m"]:

                if not isinstance(entry, list) or len(entry) < 3:
                    continue

                name = entry[0]

                languages = (
                    entry[1]
                    if isinstance(entry[1], list)
                    else []
                )

                dates = (
                    entry[2]
                    if isinstance(entry[2], list) and len(entry[2]) >= 2
                    else None
                )

                if not name or not dates:
                    continue

                customstart = (
                    bool(entry[3])
                    if len(entry) > 3
                    else False
                )

                languages = set(
                    str(x).strip()
                    for x in languages
                    if str(x).strip()
                )

                norm = normalize_movie(name)

                if norm not in movie_dict:

                    movie_dict[norm] = {
                        "movie": name,
                        "languages": languages,
                        "start": dates[0],
                        "end": dates[1],
                        "customstart": customstart
                    }

                else:

                    existing = movie_dict[norm]

                    existing["languages"].update(languages)

                    if existing["customstart"] or customstart:

                        existing["customstart"] = True
                        existing["start"] = max(
                            existing["start"],
                            dates[0]
                        )

                    else:

                        existing["start"] = min(
                            existing["start"],
                            dates[0]
                        )

                    existing["end"] = max(
                        existing["end"],
                        dates[1]
                    )

            print(
                f"📂 Loaded {len(movie_dict)} existing "
                f"movie entries (compact format)"
            )

        # -------------------------------------------------
        # OLD VERBOSE FORMAT
        # -------------------------------------------------

        elif "movies" in old and isinstance(old["movies"], list):

            for movie in old["movies"]:

                if not isinstance(movie, dict):
                    continue

                name = movie.get("movie")

                if not name:
                    continue

                languages = movie.get("languages", [])

                if not isinstance(languages, list):
                    languages = []

                languages = set(
                    str(x).strip()
                    for x in languages
                    if str(x).strip()
                )

                dates = movie.get("dates", [])

                if not isinstance(dates, list) or len(dates) < 2:
                    continue

                customstart = movie.get(
                    "customstartdate",
                    False
                )

                norm = normalize_movie(name)

                if norm not in movie_dict:

                    movie_dict[norm] = {
                        "movie": name,
                        "languages": languages,
                        "start": dates[0],
                        "end": dates[1],
                        "customstart": customstart
                    }

                else:

                    existing = movie_dict[norm]

                    existing["languages"].update(languages)

                    if existing["customstart"] or customstart:

                        existing["customstart"] = True
                        existing["start"] = max(
                            existing["start"],
                            dates[0]
                        )

                    else:

                        existing["start"] = min(
                            existing["start"],
                            dates[0]
                        )

                    existing["end"] = max(
                        existing["end"],
                        dates[1]
                    )

            print(
                f"📂 Loaded {len(movie_dict)} existing "
                f"movie entries (verbose format)"
            )

        else:
            print(
                "⚠️ Unknown movielist format, "
                "starting fresh"
            )

    except Exception as e:
        print(
            f"⚠️ Could not load {OUTPUT_FILE}: {e}"
        )

    return movie_dict

# =====================================================
# MAIN BUILDER
# =====================================================

def build_movielist(start_date=DEFAULT_START_DATE):

    movie_dict = load_existing()

    start = datetime.strptime(
        start_date,
        "%Y-%m-%d"
    ).date()

    today = today_ist()

    # -------------------------------------------------
    # ALWAYS SCAN TODAY + FUTURE_DAYS
    # -------------------------------------------------

    end = today + timedelta(days=FUTURE_DAYS)

    print()
    print("==========================================")
    print("🎬 BUILDING MOVIE LIST")
    print("==========================================")
    print(f"📅 Start       : {start}")
    print(f"📅 Today       : {today}")
    print(f"📅 Future Days : +{FUTURE_DAYS}")
    print(f"📅 Scan Until  : {end}")
    print(f"⚡ Concurrency : {CONCURRENCY}")
    print()

    # -------------------------------------------------
    # BUILD DATE LIST
    # -------------------------------------------------

    dates = []

    current = start

    while current <= end:
        dates.append(current.isoformat())
        current += timedelta(days=1)

    print(
        f"📅 Total dates to check: {len(dates)}"
    )
    print()

    # -------------------------------------------------
    # FETCH ALL DAILY FILES CONCURRENTLY
    # -------------------------------------------------

    results = {}

    with ThreadPoolExecutor(
        max_workers=CONCURRENCY
    ) as executor:

        futures = {
            executor.submit(
                fetch_daily_json,
                date_str
            ): date_str
            for date_str in dates
        }

        for future in as_completed(futures):

            date_str = futures[future]

            try:
                returned_date, data = future.result()
                results[returned_date] = data

            except Exception as e:
                print(
                    f"   ⚠️ Worker error for "
                    f"{date_str}: {e}"
                )
                results[date_str] = None

    # -------------------------------------------------
    # PROCESS RESULTS IN DATE ORDER
    #
    # Even though downloads are concurrent,
    # processing remains chronological.
    # -------------------------------------------------

    files_found = 0
    movie_entries_found = 0

    print()
    print("==========================================")
    print("🔄 PROCESSING RESULTS")
    print("==========================================")
    print()

    for date_str in dates:

        data = results.get(date_str)

        if not data:
            continue

        files_found += 1

        movies = data.get("movies", {})

        if not isinstance(movies, dict):
            continue

        for raw_key in movies.keys():

            if not raw_key:
                continue

            movie, lang = parse_movie_key(raw_key)

            movie = movie.strip()
            lang = lang.strip()

            if not movie:
                continue

            movie_entries_found += 1

            norm = normalize_movie(movie)

            # -------------------------------------------------
            # NEW MOVIE
            # -------------------------------------------------

            if norm not in movie_dict:

                movie_dict[norm] = {
                    "movie": movie,
                    "languages": {lang},
                    "start": date_str,
                    "end": date_str,
                    "customstart": False
                }

            # -------------------------------------------------
            # EXISTING MOVIE
            # -------------------------------------------------

            else:

                info = movie_dict[norm]

                info["languages"].add(lang)

                # Custom start – do not move start backwards
                if info.get("customstart", False):
                    pass

                else:
                    info["start"] = min(
                        info["start"],
                        date_str
                    )

                info["end"] = max(
                    info["end"],
                    date_str
                )

    # =================================================
    # BUILD COMPACT FINAL LIST
    # =================================================

    compact_movies = []

    for info in movie_dict.values():

        entry = [
            info["movie"],
            sorted(info["languages"]),
            [
                info["start"],
                info["end"]
            ]
        ]

        if info.get("customstart", False):
            entry.append(True)

        compact_movies.append(entry)

    # =================================================
    # SORT
    # Most recent first,
    # then language count,
    # then duration
    # =================================================

    def sort_key(entry):

        try:

            first = datetime.strptime(
                entry[2][0],
                "%Y-%m-%d"
            )

            last = datetime.strptime(
                entry[2][1],
                "%Y-%m-%d"
            )

            return (
                -first.year,
                -first.month,
                -first.day,
                -len(entry[1]),
                -(last - first).days
            )

        except Exception:
            return (
                0,
                0,
                0,
                0,
                0
            )

    compact_movies.sort(
        key=sort_key
    )

    # =================================================
    # SAVE OUTPUT
    # Minified one-line JSON
    # =================================================

    final = {
        "lu": datetime.now(IST).strftime(
            "%Y-%m-%d %H:%M IST"
        ),
        "m": compact_movies
    }

    with open(
        OUTPUT_FILE,
        "w",
        encoding="utf-8"
    ) as f:

        json.dump(
            final,
            f,
            ensure_ascii=False,
            separators=(",", ":")
        )

    # =================================================
    # SUMMARY
    # =================================================

    print()
    print("==========================================")
    print("✅ MOVIELIST COMPLETE")
    print("==========================================")
    print(
        f"📁 Output          : {OUTPUT_FILE}"
    )
    print(
        f"📂 Files found     : {files_found}"
    )
    print(
        f"🎬 Raw movie keys  : {movie_entries_found}"
    )
    print(
        f"🎬 Final movies    : {len(compact_movies)}"
    )
    print(
        f"📅 Scanned through : {end}"
    )
    print(
        f"🕒 Updated         : {final['lu']}"
    )
    print("==========================================")

# =====================================================
# RUN
# =====================================================

if __name__ == "__main__":
    build_movielist(
        start_date=DEFAULT_START_DATE
    )
