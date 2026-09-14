#!/usr/bin/env python3
"""
Weekly rankings.json updater, sourced from the official College Football
Data API (CFBD) via the `cfbd` Python client — replaces the old
collegepolltracker.com scraper.

Requires a free API key from https://collegefootballdata.com/key, passed
via the CFBD_API_KEY environment variable (never hardcode it).
"""

import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import cfbd
from cfbd.rest import ApiException

REPO_ROOT = Path(__file__).resolve().parent
RANKINGS_PATH = REPO_ROOT / "rankings.json"
LOGO_DIR = REPO_ROOT / "team-logos"

TOP_N = 25
MAX_CHAMPS = 5

# Teams whose default kebab-case slug wouldn't match the local logo
# filename actually on disk (ported from the old scrape.py's
# create_logo_filename special cases).
LOGO_SLUG_OVERRIDES = {
    "Texas A&M": "texas-am",
    "Ole Miss": "ole-miss",
    "NC State": "nc-state",
    "North Carolina": "north-carolina",
    "South Carolina": "south-carolina",
    "Arizona State": "arizona-state",
    "Kansas State": "kansas-state",
    "Iowa State": "iowa-state",
    "Ohio State": "ohio-state",
    "Penn State": "penn-state",
    "Notre Dame": "notre-dame",
    "Boise State": "boise-state",
    "Virginia Tech": "virginia-tech",
    "Georgia Tech": "georgia-tech",
    "Wake Forest": "wake-forest",
    "Boston College": "boston-college",
    "Mississippi State": "mississippi-state",
    "Miami": "miami",
    "Miami (FL)": "miami",
    "Washington State": "washington-state",
}

# script.js gates champ-eligibility on the literal string 'Ind' (see
# team.conference === 'Ind' checks), but CFBD reports independents as
# "FBS Independents" — normalize so the existing front-end logic still
# works without touching script.js.
CONFERENCE_DISPLAY_OVERRIDES = {
    "FBS Independents": "Ind",
}

# Conferences that can never produce a "conference champion" for the
# guaranteed-seed heuristic below.
NON_CHAMPIONSHIP_CONFERENCES = {"Ind", "FBS Independents", None, ""}


def log(msg):
    print(f"[update_rankings] {msg}", file=sys.stderr)


def current_season_year(today=None):
    """CFBD's 'year' param is the season's starting fall year. Bowl/CFP
    games played in January still belong to the previous calendar year's
    season (e.g. a January 2026 championship game is season year 2025)."""
    today = today or datetime.now(timezone.utc)
    return today.year if today.month >= 7 else today.year - 1


def slugify(team_name):
    if team_name in LOGO_SLUG_OVERRIDES:
        return LOGO_SLUG_OVERRIDES[team_name]
    slug = re.sub(r"[^\w\s-]", "", team_name.lower().strip())
    return re.sub(r"\s+", "-", slug)


def build_api_client():
    api_key = os.environ.get("CFBD_API_KEY")
    if not api_key:
        log("ERROR: CFBD_API_KEY environment variable is not set.")
        sys.exit(1)
    configuration = cfbd.Configuration(access_token=api_key)
    return cfbd.ApiClient(configuration)


def fetch_best_poll(api_client, year):
    """Prefer the CFP Selection Committee's latest snapshot; fall back to
    AP Top 25, then Coaches Poll, from the most recent available week.

    Deliberately avoids the get_rankings(poll=..., latest=...) filter
    kwargs some cfbd client versions expose for this — they're not present
    in every installed version (e.g. 5.13.2 lacks them), so instead this
    just pulls every week for the season (year + season_type are stable
    across versions) and scans backwards for a playoff-committee poll by
    name. Before the committee starts publishing (~week 10) no week has
    one, so this naturally falls through to the AP/Coaches fallback below
    with no date logic needed.
    """
    rankings_api = cfbd.RankingsApi(api_client)

    try:
        all_weeks = rankings_api.get_rankings(year=year, season_type="regular")
    except ApiException as e:
        log(f"ERROR: CFBD rankings lookup failed: {e}")
        sys.exit(1)

    if not all_weeks:
        log(f"ERROR: CFBD returned no ranking weeks at all for {year}.")
        sys.exit(1)

    weeks_by_recency = sorted(all_weeks, key=lambda w: w.week, reverse=True)

    for week in weeks_by_recency:
        for poll in week.polls:
            if poll.ranks and "playoff" in poll.poll.lower():
                return poll.poll, poll.ranks

    latest_week = weeks_by_recency[0]
    for preferred in ("AP Top 25", "Coaches Poll"):
        for poll in latest_week.polls:
            if poll.poll == preferred and poll.ranks:
                return poll.poll, poll.ranks

    if latest_week.polls:
        best = max(latest_week.polls, key=lambda p: len(p.ranks or []))
        if best.ranks:
            log(f"WARNING: using unexpected fallback poll '{best.poll}'.")
            return best.poll, best.ranks

    log("ERROR: could not find any usable poll with ranked teams.")
    sys.exit(1)


def fetch_team_directory(api_client, year):
    """name -> cfbd.Team, used for conference/logo fallbacks."""
    teams_api = cfbd.TeamsApi(api_client)
    return {t.school: t for t in teams_api.get_teams(year=year)}


def fetch_records(api_client, year):
    """name -> 'W-L' (or 'W-L-T') string, via a single bulk call for the
    whole season rather than one request per ranked team."""
    games_api = cfbd.GamesApi(api_client)
    out = {}
    for r in games_api.get_records(year=year):
        total = r.total
        if total is None:
            continue
        out[r.team] = (
            f"{total.wins}-{total.losses}-{total.ties}"
            if total.ties
            else f"{total.wins}-{total.losses}"
        )
    return out


def resolve_logo(team_name, team_directory):
    slug = slugify(team_name)
    local_path = LOGO_DIR / f"{slug}.png"
    if local_path.exists():
        return f"/team-logos/{slug}.png"

    team = team_directory.get(team_name)
    if team and team.logos:
        return team.logos[0]

    log(f"WARNING: no local or CFBD logo found for '{team_name}' (slug '{slug}').")
    return ""


def resolve_conference(poll_rank, team_directory):
    conference = poll_rank.conference
    if not conference:
        team = team_directory.get(poll_rank.school)
        conference = team.conference if team else None
        if not conference:
            log(f"WARNING: no conference found for '{poll_rank.school}'; defaulting to 'Ind'.")
            conference = "Ind"
    return CONFERENCE_DISPLAY_OVERRIDES.get(conference, conference)


def determine_champs(teams):
    """Highest-ranked team from each conference, in rank order, is treated
    as that conference's champion, until 5 champions are found. This is a
    heuristic stand-in (ported unchanged from the old scrape.py) — real
    conference-championship results aren't derivable from a poll."""
    seen, champs = set(), set()
    for team in teams:
        conf = team["conference"]
        if conf in NON_CHAMPIONSHIP_CONFERENCES:
            continue
        if conf not in seen and len(champs) < MAX_CHAMPS:
            seen.add(conf)
            champs.add(team["name"])
    return champs


def main():
    year = current_season_year()
    log(f"Season year resolved to {year}.")

    api_client = build_api_client()

    poll_label, ranks = fetch_best_poll(api_client, year)
    log(f"Using poll: '{poll_label}' ({len(ranks)} ranked teams).")

    team_directory = fetch_team_directory(api_client, year)
    records = fetch_records(api_client, year)

    top25 = sorted(ranks, key=lambda r: r.rank)[:TOP_N]

    teams = []
    for entry in top25:
        name = entry.school
        record = records.get(name, "")
        if not record:
            log(f"WARNING: no record found for '{name}'.")
        teams.append({
            "id": entry.rank,
            "name": name,
            "conference": resolve_conference(entry, team_directory),
            "logo": resolve_logo(name, team_directory),
            "record": record,
            "champ": False,
        })

    champs = determine_champs(teams)
    for team in teams:
        team["champ"] = team["name"] in champs

    RANKINGS_PATH.write_text(json.dumps(teams, indent=2) + "\n")
    log(f"Wrote {len(teams)} teams to {RANKINGS_PATH}.")


if __name__ == "__main__":
    main()
