#!/usr/bin/env python3
"""
CricWormViz server — serves static files, proxies ESPN sports API and Clicket game API.

Routes:
  GET /espn/live              → matches from the last 7 days across major cricket leagues
  GET /espn/match/<lid>/<eid> → scoreboard info for one match
  GET /espn/commentary/<lid>/<eid> → complete ball-by-ball (paginated internally)
  GET /clicket/live           → current live Clicket match ID
  GET /clicket/seasons        → list of all Clicket season numbers
  GET /clicket/season/<n>     → matches in Clicket season n
  GET /clicket/game/<id>      → full ball-by-ball Clicket game data
"""

import concurrent.futures, datetime, json, os, signal, socketserver, sys
import time, urllib.error, urllib.parse, urllib.request
from http.server import SimpleHTTPRequestHandler

PORT      = 8743
ESPN_BASE = "https://site.web.api.espn.com/apis/site/v2/sports/cricket"
CK_BASE   = "https://clicket-game.com/api"
TIMEOUT   = 12

ESPN_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, */*",
    "Accept-Language": "en-US,en;q=0.9",
}

CRICKET_LEAGUES = [
    # Major T20 leagues
    8048,  # Indian Premier League
    8044,  # Big Bash League
    8623,  # Caribbean Premier League
    8679,  # Pakistan Super League
    8653,  # Bangladesh Premier League
    8678,  # Karnataka Premier League
    # ICC events
    8604,  # ICC Men's T20 World Cup
    8040,  # ICC Men's T20 World Cup Qualifier
    8038,  # ICC Cricket World Cup Qualifier
    8037,  # ICC Champions Trophy
    8634,  # ICC Women's T20 World Cup
    8621,  # ICC Women's Cricket World Cup Qualifier
    # England domestic
    8052,  # County Championship Division One
    8204,  # County Championship Division Two
    8053,  # T20 Blast / Twenty20 Cup (England)
    8335,  # Royal London One-Day Cup
    # South Africa domestic
    8041,  # SuperSport Series
    8042,  # Standard Bank Cup
    8656,  # SA Domestic T20/Pro20
    8725,  # CSA Provincial T20 Challenge
    8723,  # CSA Provincial One-Day Challenge
    # Australia domestic
    8043,  # Sheffield Shield
    8626,  # Australian Domestic One-Day Competition
    8699,  # Australian Women's Twenty20 Cup
    # India domestic
    8050,  # Ranji Trophy
    8661,  # Syed Mushtaq Ali Trophy
    8630,  # Duleep Trophy
    8737,  # Deodhar Trophy
    8711,  # Challenger Series
    # Pakistan domestic
    8660,  # National T20 Cup
    # New Zealand domestic
    8654,  # New Zealand Domestic Twenty20
    8046,  # State League Twenty20 (NZ Women)
    # West Indies / Caribbean
    8663,  # West Indies Tri-Nation Series
    # Sri Lanka domestic
    8673,  # Sri Lanka Domestic T20
    # Bangladesh domestic
    8738,  # Dhaka Premier Division
    8701,  # Bangladesh Cricket League
    # Zimbabwe domestic
    8710,  # Castle Logan Cup
    8739,  # Domestic Twenty20 Competition (Zimbabwe)
    # Other / Africa
    8740,  # East Africa Premier League
]


# ── HTTP helpers ──────────────────────────────────────────────────────────────

def espn_get(path, params=None):
    qs  = ("?" + urllib.parse.urlencode(params)) if params else ""
    url = ESPN_BASE + path + qs
    req = urllib.request.Request(url, headers=ESPN_HEADERS)
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.loads(r.read())


def ck_get(path):
    url = CK_BASE + path
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/json",
    })
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.loads(r.read())


# ── ESPN match cache (5-minute TTL) ──────────────────────────────────────────

_cache_data = {}        # matchId → match dict
_cache_time = 0.0       # unix timestamp of last fill

# ── Active-league discovery (30-minute TTL) ───────────────────────────────────

_league_ids_cache = set()
_league_ids_time  = 0.0

def discover_active_leagues():
    """
    Fetch all currently-active cricket league IDs from the ESPN scoreboard header.
    Covers bilateral tours and ICC events that are not in the static list.
    Cached for 30 minutes.
    """
    global _league_ids_cache, _league_ids_time
    if time.time() - _league_ids_time < 1800 and _league_ids_cache:
        return _league_ids_cache
    try:
        url = (
            "https://site.web.api.espn.com/apis/v2/scoreboard/header"
            "?sport=cricket&lang=en&region=gb&limit=200&showAirings=true"
        )
        req  = urllib.request.Request(url, headers=ESPN_HEADERS)
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            data = json.loads(r.read())
        ids = set()
        for sport in data.get("sports", []):
            for league in sport.get("leagues", []):
                lid = league.get("id")
                if lid:
                    try:
                        ids.add(int(lid))
                    except (ValueError, TypeError):
                        pass
        if ids:
            _league_ids_cache = ids
            _league_ids_time  = time.time()
            return ids
    except Exception:
        pass
    return set()


def _score_str(competitor):
    """Build a display score from linescores (handles multi-innings and batting/fielding sides)."""
    s = competitor.get("score", "")
    if s:
        return s
    parts = []
    for ls in competitor.get("linescores", []):
        runs = ls.get("runs", 0)
        wkts = ls.get("wickets")
        desc = ls.get("description", "")
        # Skip innings where this team hasn't batted yet
        if not ls.get("isBatting") and runs == 0 and not desc:
            continue
        part = str(int(runs)) if isinstance(runs, float) else str(runs)
        if wkts is not None and int(wkts) < 10:
            part += f"/{int(wkts)}"
        parts.append(part)
    return " & ".join(parts) if parts else ""


def _fetch_league_date(lid_date):
    lid, date = lid_date
    try:
        data  = espn_get(f"/{lid}/scoreboard", {"dates": date})
        lname = data.get("leagues", [{}])[0].get("name", "Cricket")
        results = []
        for evt in data.get("events", []):
            comp  = evt.get("competitions", [{}])[0]
            teams = comp.get("competitors", [])
            home  = next((t for t in teams if t.get("homeAway") == "home"), teams[0] if teams else {})
            away  = next((t for t in teams if t.get("homeAway") == "away"), teams[1] if len(teams) > 1 else {})
            st    = evt.get("status", {}).get("type", {})
            results.append({
                "matchId":    f"{lid}_{evt['id']}",
                "leagueId":   lid,
                "eventId":    evt["id"],
                "league":     lname,
                "name":       evt.get("name", ""),
                "date":       evt.get("date", ""),
                "homeTeam":   home.get("team", {}).get("displayName", ""),
                "awayTeam":   away.get("team", {}).get("displayName", ""),
                "homeScore":  _score_str(home),
                "awayScore":  _score_str(away),
                "homeId":     home.get("id", ""),
                "awayId":     away.get("id", ""),
                "status":     st.get("state", ""),
                "statusText": st.get("shortDetail", st.get("description", "")),
                "isLive":     st.get("state") == "in",
                "pbpAvailable": bool(comp.get("playByPlayAvailable", False)),
            })
        return results
    except Exception:
        return []


def live_matches():
    """
    Return matches from the last 7 days across all major leagues.
    Results are cached for 5 minutes.
    """
    global _cache_data, _cache_time
    if time.time() - _cache_time < 300 and _cache_data:
        return sorted(_cache_data.values(), key=_match_sort_key)

    today    = datetime.date.today()
    dates    = [(today - datetime.timedelta(days=d)).strftime("%Y%m%d") for d in range(7)]
    all_lids = list(set(CRICKET_LEAGUES) | discover_active_leagues())
    tasks    = [(lid, date) for lid in all_lids for date in dates]

    new_cache = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=30) as ex:
        for result_list in ex.map(_fetch_league_date, tasks):
            for m in result_list:
                mid = m["matchId"]
                # Keep the most-recent entry for each match
                if mid not in new_cache or m["isLive"]:
                    new_cache[mid] = m

    _cache_data = new_cache
    _cache_time = time.time()
    return sorted(new_cache.values(), key=_match_sort_key)


def _match_sort_key(m):
    order = {"in": 0, "pre": 1, "post": 2}
    return (order.get(m["status"], 3), m.get("date", ""))


def match_info(league_id, event_id):
    """Return scoreboard info for one specific match."""
    # Try today first, then recent dates
    today = datetime.date.today()
    for days_ago in range(8):
        date = (today - datetime.timedelta(days=days_ago)).strftime("%Y%m%d")
        try:
            data = espn_get(f"/{league_id}/scoreboard", {"dates": date})
        except Exception:
            continue
        lname = data.get("leagues", [{}])[0].get("name", "Cricket")
        for evt in data.get("events", []):
            if str(evt.get("id")) == str(event_id):
                comp  = evt.get("competitions", [{}])[0]
                teams = comp.get("competitors", [])
                home  = next((t for t in teams if t.get("homeAway") == "home"), teams[0] if teams else {})
                away  = next((t for t in teams if t.get("homeAway") == "away"), teams[1] if len(teams) > 1 else {})
                st    = evt.get("status", {}).get("type", {})
                return {
                    "leagueId": league_id, "eventId": event_id,
                    "league": lname, "name": evt.get("name", ""),
                    "homeTeam": home.get("team", {}).get("displayName", ""),
                    "awayTeam": away.get("team", {}).get("displayName", ""),
                    "homeScore": home.get("score", ""),
                    "awayScore": away.get("score", ""),
                    "homeId": home.get("id", ""),
                    "awayId": away.get("id", ""),
                    "venue": comp.get("venue", {}).get("fullName", ""),
                    "status": st.get("state", ""),
                    "statusText": st.get("shortDetail", ""),
                    "isLive": st.get("state") == "in",
                }
    raise ValueError(f"Event {event_id} not found in league {league_id}")


_pbp_cache = {}   # matchId → bool

def has_pbp(league_id, event_id):
    """Return True if this match has any ball-by-ball commentary. Cached."""
    key = f"{league_id}_{event_id}"
    if key in _pbp_cache:
        return _pbp_cache[key]
    try:
        data  = espn_get(f"/{league_id}/playbyplay", {"event": event_id, "page": 1})
        count = data.get("commentary", {}).get("count", 0)
        result = bool(count)
    except Exception:
        result = False
    _pbp_cache[key] = result
    return result


def find_match(league_id, event_id):
    """Locate a specific event by league+event ID, searching 30 days back."""
    today = datetime.date.today()
    for days_ago in range(30):
        date = (today - datetime.timedelta(days=days_ago)).strftime("%Y%m%d")
        try:
            data = espn_get(f"/{league_id}/scoreboard", {"dates": date})
        except Exception:
            continue
        lname = data.get("leagues", [{}])[0].get("name", "Cricket")
        for evt in data.get("events", []):
            if str(evt.get("id")) != str(event_id):
                continue
            comp  = evt.get("competitions", [{}])[0]
            teams = comp.get("competitors", [])
            home  = next((t for t in teams if t.get("homeAway") == "home"), teams[0] if teams else {})
            away  = next((t for t in teams if t.get("homeAway") == "away"), teams[1] if len(teams) > 1 else {})
            st    = evt.get("status", {}).get("type", {})
            return {
                "matchId":    f"{league_id}_{evt['id']}",
                "leagueId":   int(league_id),
                "eventId":    evt["id"],
                "league":     lname,
                "name":       evt.get("name", ""),
                "date":       evt.get("date", ""),
                "homeTeam":   home.get("team", {}).get("displayName", ""),
                "awayTeam":   away.get("team", {}).get("displayName", ""),
                "homeScore":  _score_str(home),
                "awayScore":  _score_str(away),
                "status":     st.get("state", ""),
                "statusText": st.get("shortDetail", st.get("description", "")),
                "isLive":     st.get("state") == "in",
            }
    return None


def full_commentary(league_id, event_id):
    """Fetch all pages of ball-by-ball commentary, oldest first."""
    all_items = []
    page = 1
    max_pages = 200

    while page <= max_pages:
        try:
            data = espn_get(f"/{league_id}/playbyplay",
                            {"event": event_id, "page": page})
        except Exception:
            break

        comm  = data.get("commentary", {})
        items = comm.get("items", [])
        if not items:
            break

        all_items.extend(items)
        if page >= comm.get("pageCount", 0):
            break
        page += 1

    return all_items


# ── request handler ───────────────────────────────────────────────────────────

class Handler(SimpleHTTPRequestHandler):

    def log_message(self, fmt, *args):
        pass

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        p = self.path.split("?")[0]

        # ── ESPN routes ──────────────────────────────────────
        if p == "/espn/live":
            self._json_route(live_matches)

        elif p.startswith("/espn/match/"):
            parts = p.split("/")        # ['','espn','match',lid,eid]
            self._json_route(lambda: match_info(parts[3], parts[4]))

        elif p.startswith("/espn/commentary/"):
            parts = p.split("/")        # ['','espn','commentary',lid,eid]
            self._json_route(
                lambda: {"items": full_commentary(parts[3], parts[4])}
            )

        elif p.startswith("/espn/check-pbp/"):
            parts = p.split("/")        # ['','espn','check-pbp',lid,eid]
            self._json_route(lambda: {"hasPBP": has_pbp(parts[3], parts[4])})

        elif p.startswith("/espn/find-match/"):
            parts = p.split("/")        # ['','espn','find-match',lid,eid]
            result = find_match(parts[3], parts[4])
            if result is None:
                self._err(404, "Match not found for those IDs")
            else:
                self._json_route(lambda: result)

        # ── Clicket routes ───────────────────────────────────
        elif p == "/clicket/live":
            self._json_route(lambda: ck_get("/live"))

        elif p == "/clicket/seasons":
            self._json_route(lambda: ck_get("/season/all"))

        elif p.startswith("/clicket/season/"):
            season = p.split("/")[3]
            self._json_route(lambda: ck_get(f"/season/{season}"))

        elif p.startswith("/clicket/game/"):
            game_id = p.split("/")[3]
            self._json_route(lambda: ck_get(f"/game/{game_id}"))

        else:
            super().do_GET()

    # ── helpers ──────────────────────────────────────────────

    def _json_route(self, fn):
        try:
            data = fn()
            body = json.dumps(data).encode()
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        except urllib.error.HTTPError as e:
            self._err(e.code, f"Upstream returned HTTP {e.code}")
        except Exception as e:
            self._err(502, str(e))

    def _err(self, code, msg):
        body = json.dumps({"error": msg}).encode()
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")


class ReusableTCPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True


# ── entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    server = ReusableTCPServer(("", PORT), Handler)

    def _quit(sig, frame):
        print("\nStopped.")
        server.shutdown()
        sys.exit(0)

    signal.signal(signal.SIGINT, _quit)
    print(f"CricWormViz → http://localhost:{PORT}")
    server.serve_forever()
