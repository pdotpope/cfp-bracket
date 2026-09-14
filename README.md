# College Football Playoff Bracket Predictor 🏆
_Predict rankings and playoff results!_
- [Live Website](https://cfpbracket.peytonjpope.com)
- [Full Documentation](https://peytonjpope.com/projects/cfpbracket)

## Automated Weekly Rankings Updates

`rankings.json` is refreshed weekly by a GitHub Actions workflow
(`.github/workflows/update-rankings.yml`) that runs `update_rankings.py`.
The script pulls the latest CFP Selection Committee rankings via the
official [CFBD API](https://collegefootballdata.com/) once the committee
starts publishing them (typically early November), or the AP Top 25 poll
otherwise, fills in each team's conference, current record, and logo, and
opens a pull request with the updated file for review — nothing reaches
the live site until the PR is merged.

### One-time setup

1. Get a free API key at https://collegefootballdata.com/key.
2. In this repo's GitHub settings, go to **Settings → Secrets and
   variables → Actions → New repository secret** and add it as
   `CFBD_API_KEY`.
3. Done — the workflow runs every Wednesday, or trigger it manually from
   the **Actions** tab (**Update Weekly Rankings** → **Run workflow**).

### Running it locally

```bash
pip install -r requirements.txt
export CFBD_API_KEY=your_key_here
python update_rankings.py
```
