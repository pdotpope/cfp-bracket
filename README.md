# College Football Playoff Bracket Predictor 🏆
_Predict rankings and playoff results!_
- [Live Website](https://cfp-bracket.pdot.dev)
  
## Automated Weekly Rankings Updates

`rankings.json` is refreshed weekly by a GitHub Actions workflow
(`.github/workflows/update-rankings.yml`) that runs `update_rankings.py`.
The script pulls the latest CFP Selection Committee rankings via the
official [CFBD API](https://collegefootballdata.com/) once the committee
starts publishing them (typically early November), or the AP Top 25 poll
otherwise, fills in each team's conference, current record, and logo
(caching any new logo into `team-logos/` so every image is same-origin),
and commits the result straight to `main`, so the live site updates with
no manual step.

When the rankings change, the workflow also runs `make_og_image.py`, which
redraws `og-image.png` (the link-preview card) as an "if the playoff
started today" bracket and bumps its `?v=` cache-buster in `index.html`.

### One-time setup

1. Get a free API key at https://collegefootballdata.com/key.
2. In this repo's GitHub settings, go to **Settings → Secrets and
   variables → Actions → New repository secret** and add it as
   `CFBD_API_KEY`.
3. Done — the workflow runs every Tuesday night (Wed 05:00 UTC), or trigger it manually from
   the **Actions** tab (**Update Weekly Rankings** → **Run workflow**).

### Running it locally

```bash
pip install -r requirements.txt
export CFBD_API_KEY=your_key_here
python update_rankings.py
```
