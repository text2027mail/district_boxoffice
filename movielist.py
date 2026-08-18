import json
import requests
import os
import re
from datetime import datetime, timedelta, timezone

# =====================================================
# CONFIGURATION
# =====================================================

BASE_URL = "https://districtdata2026.pages.dev/advance"
OUTPUT_FILE = "movielist.json"

# New source
DEFAULT_START_DATE = "2025-09-01"

# How many days beyond today to scan
FUTURE_DAYS = 5

REQUEST_TIMEOUT = 20

IST = timezone(timedelta(hours=5, minutes=30))


# =====================================================
# TIME
# =====================================================

def today_ist():
    return datetime.now(IST).date()


# =====================================================
# NORMALIZE MOVIE NAME
# =====================================================

def normalize_movie(name):
    """
    Used only for duplicate detection.

    Example:
        Movie: The Film
        Movie - The Film
        Movie:The Film

    become equivalent.
    """

    name = str(name).strip().lower()

    # Remove colon / hyphen
    name = re.sub(r"[:\-]", "", name)

    # Normalize whitespace
    name = re.sub(r"\s+", " ", name)

    return name.strip()


# =====================================================
# FETCH NEW DETAILED JSON
# =====================================================

def fetch_daily_json(date_str):
    """
    New format:

    https://districtdata2026.pages.dev/boxoffice/
        2026-08-18_Detailed.json
    """

    url = f"{BASE_URL}/{date_str}_Detailed.json"

    try:
        print(f"📥 Fetching {date_str} ...")

        response = requests.get(
            url,
            timeout=REQUEST_TIMEOUT
        )

        if response.status_code == 200:
            try:
                data = response.json()

                # New structure must contain movies
                if isinstance(data, dict) and isinstance(
                    data.get("movies"),
                    dict
                ):
                    print(
                        f"   ✅ {date_str} "
                        f"→ {len(data['movies'])} movie entries"
                    )
                    return data

                print(f"   ⚠️ Invalid movies structure")

            except Exception as e:
                print(f"   ⚠️ JSON parse error: {e}")

        elif response.status_code == 404:
            print(f"   ⏭️ {date_str} → 404")

        else:
            print(
                f"   ⚠️ HTTP {response.status_code}"
            )

    except requests.RequestException as e:
        print(f"   ⚠️ Request error: {e}")

    except Exception as e:
        print(f"   ⚠️ Error: {e}")

    return None


# =====================================================
# PARSE MOVIE KEY
# =====================================================

def parse_movie_key(key):
    """
    New movie keys are normally:

        Movie Name | Tamil
        Movie Name | Hindi

    Also supports the old format:

        Movie Name [2D | Tamil]

    Returns:

        movie_name, language
    """

    key = str(key).strip()

    # ---------------------------------------------
    # New format
    # ---------------------------------------------

    if "|" in key:
        parts = [p.strip() for p in key.split("|")]

        if len(parts) >= 2:
            movie = parts[0]
            lang = parts[-1]

            if movie and lang:
                return movie, lang

    # ---------------------------------------------
    # Old bracket format fallback
    # ---------------------------------------------

    if "[" in key and "]" in key:

        base = key.split("[", 1)[0].strip()

        inside = (
            key
            .split("[", 1)[1]
            .split("]", 1)[0]
        )

        parts = [
            p.strip()
            for p in inside.split("|")
        ]

        if parts:
            return base, parts[-1]

    # ---------------------------------------------
    # Unknown language
    # ---------------------------------------------

    return key, "Unknown"


# =====================================================
# LOAD EXISTING MOVIELIST
# =====================================================

def load_existing():

    movie_dict = {}

    if not os.path.exists(OUTPUT_FILE):
        return movie_dict

    try:

        with open(
            OUTPUT_FILE,
            "r",
            encoding="utf-8"
        ) as f:

            old = json.load(f)

        for movie in old.get("movies", []):

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

            if (
                not isinstance(dates, list)
                or len(dates) < 2
            ):
                continue

            key = (
                f"{name}__"
                f"{','.join(sorted(languages))}"
            )

            movie_dict[key] = {
                "movie": name,
                "languages": languages,
                "start": dates[0],
                "end": dates[1],
                "customstart": movie.get(
                    "customstartdate",
                    False
                )
            }

        print(
            f"📂 Loaded {len(movie_dict)} "
            f"existing movie entries"
        )

    except Exception as e:

        print(
            f"⚠️ Could not load existing "
            f"{OUTPUT_FILE}: {e}"
        )

    return movie_dict


# =====================================================
# MAIN BUILDER
# =====================================================

def build_movielist(
    start_date=DEFAULT_START_DATE
):

    movie_dict = load_existing()

    # ---------------------------------------------
    # DATE RANGE
    # ---------------------------------------------

    start = datetime.strptime(
        start_date,
        "%Y-%m-%d"
    ).date()

    end = (
        today_ist()
        + timedelta(days=FUTURE_DAYS)
    )

    print()
    print("==========================================")
    print("🎬 BUILDING MOVIE LIST")
    print("==========================================")
    print(f"📅 Start : {start}")
    print(f"📅 End   : {end}")
    print()

    current = start

    files_found = 0
    movie_entries_found = 0

    # ---------------------------------------------
    # SCAN DAILY FILES
    # ---------------------------------------------

    while current <= end:

        date_str = current.isoformat()

        data = fetch_daily_json(date_str)

        if data:

            files_found += 1

            movies = data.get(
                "movies",
                {}
            )

            if isinstance(movies, dict):

                for raw_key in movies.keys():

                    if not raw_key:
                        continue

                    movie, lang = parse_movie_key(
                        raw_key
                    )

                    movie = movie.strip()
                    lang = lang.strip()

                    if not movie:
                        continue

                    movie_entries_found += 1

                    dict_key = (
                        f"{movie}__{lang}"
                    )

                    # ---------------------------------
                    # NEW MOVIE
                    # ---------------------------------

                    if dict_key not in movie_dict:

                        movie_dict[dict_key] = {
                            "movie": movie,
                            "languages": {lang},
                            "start": date_str,
                            "end": date_str,
                            "customstart": False
                        }

                    # ---------------------------------
                    # EXISTING MOVIE
                    # ---------------------------------

                    else:

                        info = movie_dict[
                            dict_key
                        ]

                        # Keep language
                        info["languages"].add(lang)

                        start_existing = info[
                            "start"
                        ]

                        # ---------------------------------
                        # CUSTOM START DATE
                        # ---------------------------------

                        if info.get(
                            "customstart",
                            False
                        ):

                            # Do not move custom
                            # start date backwards

                            if date_str < start_existing:
                                continue

                        else:

                            info["start"] = min(
                                start_existing,
                                date_str
                            )

                        # ---------------------------------
                        # END DATE
                        # ---------------------------------

                        info["end"] = max(
                            info["end"],
                            date_str
                        )

        current += timedelta(days=1)

    # =================================================
    # DEDUPLICATE MOVIES
    # =================================================

    grouped = {}

    for info in movie_dict.values():

        norm = normalize_movie(
            info["movie"]
        )

        lang_key = ",".join(
            sorted(info["languages"])
        )

        group_key = (
            f"{norm}__{lang_key}"
        )

        if group_key not in grouped:

            grouped[group_key] = info

        else:

            existing = grouped[group_key]

            # Prefer version WITHOUT colon
            if (
                ":" in existing["movie"]
                and ":" not in info["movie"]
            ):

                grouped[group_key] = info

    # =================================================
    # BUILD FINAL LIST
    # =================================================

    movies = []

    for info in grouped.values():

        item = {
            "movie": info["movie"],
            "languages": sorted(
                info["languages"]
            ),
            "dates": [
                info["start"],
                info["end"]
            ]
        }

        if info.get(
            "customstart",
            False
        ):
            item["customstartdate"] = True

        movies.append(item)

    # =================================================
    # SORT
    # =================================================

    def sort_key(item):

        try:

            first = datetime.strptime(
                item["dates"][0],
                "%Y-%m-%d"
            )

            last = datetime.strptime(
                item["dates"][1],
                "%Y-%m-%d"
            )

            return (
                -first.year,
                -first.month,
                -first.day,
                -len(item["languages"]),
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

    movies.sort(
        key=sort_key
    )

    # =================================================
    # FINAL OUTPUT
    # =================================================

    final = {
        "last_updated": datetime.now(
            IST
        ).strftime(
            "%Y-%m-%d %H:%M IST"
        ),
        "movies": movies
    }

    # =================================================
    # SAVE
    # =================================================

    with open(
        OUTPUT_FILE,
        "w",
        encoding="utf-8"
    ) as f:

        json.dump(
            final,
            f,
            indent=2,
            ensure_ascii=False
        )

    # =================================================
    # SUMMARY
    # =================================================

    print()
    print("==========================================")
    print("✅ MOVIELIST COMPLETE")
    print("==========================================")
    print(f"📁 Output          : {OUTPUT_FILE}")
    print(f"📂 Files found     : {files_found}")
    print(
        f"🎬 Raw movie keys  : "
        f"{movie_entries_found}"
    )
    print(
        f"🎬 Final movies    : "
        f"{len(movies)}"
    )
    print(
        f"🕒 Updated         : "
        f"{final['last_updated']}"
    )
    print("==========================================")


# =====================================================
# RUN
# =====================================================

if __name__ == "__main__":

    build_movielist(
        start_date=DEFAULT_START_DATE
    )
