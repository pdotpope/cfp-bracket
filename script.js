/*
 * CFP Bracket — client-side state, rendering, and sharing.
 *
 * State model
 * -----------
 * The whole app state is two things:
 *   - `rankings`: ordered array of team objects (copied from rankings.json,
 *     so toggling `champ` never mutates the fetched data).
 *   - `picks`: 11 slots, one per playoff game, each holding the *name* of
 *     the team picked to win that game (or null).
 *
 * Every matchup is derived from those two on each render (see
 * computeGames). Storing picks by team name rather than by bracket
 * position means a pick survives any ranking change that keeps that team
 * in the same game, and is pruned automatically when it doesn't — so a
 * later round can never show a team that no longer won the earlier game.
 *
 * Game layout (indices into `picks`)
 * ----------------------------------
 *   0-3  First round:   8v9, 5v12, 7v10, 6v11   (seeds hosted by higher)
 *   4-7  Quarterfinals: 1 / 4 / 2 / 3 seed vs winner of game 0 / 1 / 2 / 3
 *   8-9  Semifinals:    W4 v W5, W6 v W7
 *   10   Championship:  W8 v W9
 */

const SITE_URL = 'https://cfp-bracket.pdot.dev/';
const STORAGE_KEY = 'cfp-bracket-state-v1';
const GAME_COUNT = 11;

// Seed indices (0-based) for each first-round game: [higher, lower].
const FIRST_ROUND_SEEDS = [[7, 8], [4, 11], [6, 9], [5, 10]];
// Seed index of the bye team hosting each quarterfinal (games 4-7).
const QUARTERFINAL_BYE_SEEDS = [0, 3, 1, 2];

// Conferences that can never hold a conference-champion auto-bid.
// Independents have no conference title game. (The Pac-12 was excluded
// while it was a two-team league in 2024-25; it is a full conference
// again from 2026, and update_rankings.py can award it a champion.)
const NON_CHAMP_CONFERENCES = new Set(['Ind']);

let rankings = [];
let picks = Array(GAME_COUNT).fill(null);
// Fingerprint of the rankings.json currently served; used to tell whether a
// returning visitor's saved bracket was built on this week's rankings.
let dataFingerprint = '';
// This week's rankings exactly as served by rankings.json; the baseline
// that "Reset Rankings" restores. Never mutated: copies are handed out.
let officialRankings = [];

/* ------------------------------------------------------------------ */
/* View switching (mobile/tablet tabs; desktop shows both via CSS)     */
/* ------------------------------------------------------------------ */

function switchView(viewName) {
    document.querySelectorAll('.view-section').forEach(section => {
        section.classList.remove('active');
    });
    document.querySelectorAll('.tab-button').forEach(button => {
        button.classList.remove('active');
    });
    document.getElementById(viewName + '-view').classList.add('active');
    document.querySelector(`[data-view="${viewName}"]`).classList.add('active');
}

/* ------------------------------------------------------------------ */
/* Seeding and bracket derivation                                     */
/* ------------------------------------------------------------------ */

// 12-team format: the five highest-ranked conference champions are
// guaranteed a spot, the rest are filled by ranking, and all 12 are then
// seeded straight by ranking (no champion-only byes).
function calculateSeeds() {
    const guaranteedChamps = rankings.filter(team => team.champ).slice(0, 5);
    const playoffTeams = [...guaranteedChamps];

    for (const team of rankings) {
        if (playoffTeams.length >= 12) break;
        if (!playoffTeams.includes(team)) playoffTeams.push(team);
    }

    playoffTeams.sort((a, b) => rankings.indexOf(a) - rankings.indexOf(b));
    return playoffTeams.map((team, index) => ({ ...team, seed: index + 1 }));
}

// Builds all 11 games from the current seeds and picks. Also prunes any
// pick whose team is no longer in that game, which is what keeps later
// rounds consistent after an earlier pick or the rankings change.
function computeGames() {
    const seeds = calculateSeeds();
    const games = [];

    const resolveWinner = (gameIndex) => {
        const game = games[gameIndex];
        const pickedName = picks[gameIndex];
        if (!pickedName) return null;
        if (game.a?.name === pickedName) return game.a;
        if (game.b?.name === pickedName) return game.b;
        picks[gameIndex] = null; // stale pick: that team isn't in this game anymore
        return null;
    };

    FIRST_ROUND_SEEDS.forEach(([hi, lo]) => {
        games.push({ a: seeds[hi] || null, b: seeds[lo] || null });
    });
    QUARTERFINAL_BYE_SEEDS.forEach((byeSeed, i) => {
        games.push({ a: seeds[byeSeed] || null, b: null, feederB: i });
    });

    // Fill games in order so each round sees the already-pruned winners
    // of the round before it.
    for (let i = 0; i < GAME_COUNT; i++) {
        if (i >= 4 && i <= 7) {
            games[i].b = resolveWinner(i - 4);
        } else if (i === 8 || i === 9) {
            const first = 4 + (i - 8) * 2;
            games.push({ a: resolveWinner(first), b: resolveWinner(first + 1) });
        } else if (i === 10) {
            games.push({ a: resolveWinner(8), b: resolveWinner(9) });
        }
    }
    const champion = resolveWinner(10);
    return { games, champion };
}

function pickWinner(gameIndex, side) {
    const { games } = computeGames();
    const team = side === 'a' ? games[gameIndex].a : games[gameIndex].b;
    if (!team) return; // empty slot: nothing to advance yet

    picks[gameIndex] = team.name;
    renderBracket();
    persistState();

    if (gameIndex === GAME_COUNT - 1) {
        trackEvent('champion/' + slugify(team.name), `Champion pick: ${team.name}`);
    }
}

// Restores this week's official order and conference champions. Picks are
// left alone: computeGames() prunes any that the restored seeding makes
// impossible, and keeps the ones that still hold.
function resetRankings() {
    rankings = officialRankings.map(t => ({ ...t }));
    onRankingsChanged();
}

function resetBracket() {
    picks = Array(GAME_COUNT).fill(null);
    renderBracket();
    persistState();
}

/* ------------------------------------------------------------------ */
/* Rankings mutations                                                 */
/* ------------------------------------------------------------------ */

function onRankingsChanged() {
    renderRankings();
    renderBracket();
    persistState();
}

function moveTeam(fromIndex, toIndex) {
    if (toIndex < 0 || toIndex >= rankings.length || fromIndex === toIndex) return;
    const [team] = rankings.splice(fromIndex, 1);
    rankings.splice(toIndex, 0, team);
    onRankingsChanged();
}

// Makes `team` its conference's champion, clearing any other champion from
// the same conference. With `allowUnset`, clicking an existing champion
// clears it (used by the desktop right-click shortcut).
function setConferenceChampion(team, allowUnset = false) {
    if (NON_CHAMP_CONFERENCES.has(team.conference)) return;

    if (team.champ) {
        if (!allowUnset) return;
        team.champ = false;
    } else {
        rankings.forEach(t => {
            if (t.conference === team.conference) t.champ = false;
        });
        team.champ = true;
    }
    onRankingsChanged();
}

/* ------------------------------------------------------------------ */
/* Rendering                                                          */
/* ------------------------------------------------------------------ */

// Shared fallback for any logo that fails to load (e.g. a CDN hiccup on
// an auto-generated logo URL) so a broken-image icon never shows.
const LOGO_FALLBACK = '/other-logos/notrophy.png';
const logoImg = (src, cls) =>
    `<img src="${src}" alt="" class="${cls}" onerror="this.onerror=null;this.src='${LOGO_FALLBACK}'">`;

function renderRankings() {
    const rankingsList = document.getElementById('rankings-list');
    rankingsList.innerHTML = '';

    const seededNames = new Set(calculateSeeds().map(t => t.name));

    rankings.forEach((team, index) => {
        const inPlayoff = seededNames.has(team.name);
        const canBeChamp = !NON_CHAMP_CONFERENCES.has(team.conference);

        const rankingNumber = document.createElement('div');
        rankingNumber.className = 'team-number';
        rankingNumber.textContent = index + 1;
        if (!inPlayoff) rankingNumber.style.color = '#999';

        const teamCard = document.createElement('div');
        teamCard.className = `team-card ${inPlayoff ? '' : 'non-playoff'}`;
        teamCard.draggable = true;
        teamCard.dataset.index = index;
        teamCard.dataset.conference = team.conference;

        const trophy = team.champ ? '/other-logos/goldtrophy.png' : '/other-logos/notrophy.png';
        teamCard.innerHTML = `
            <div class="team-logo">${logoImg(team.logo, '')}</div>
            <div class="team-info">
                <div class="team-name">${team.name}</div>
                <div class="conference-info">
                    <div class="team-record">(${team.record})</div>
                    <div class="team-conference">${team.conference}</div>
                    <div class="trophy"><img src="${trophy}" alt=""></div>
                </div>
            </div>
        `;

        const arrowButtons = document.createElement('div');
        arrowButtons.className = 'arrow-buttons';

        const trophyButton = document.createElement('button');
        trophyButton.className = 'arrow-button trophy';
        trophyButton.title = 'Make conference champion';
        trophyButton.innerHTML = '<img src="/other-logos/goldtrophy.png" alt="Make conference champion">';
        trophyButton.disabled = team.champ === true || !canBeChamp;
        trophyButton.onclick = (e) => {
            e.stopPropagation();
            setConferenceChampion(team);
        };

        const upButton = document.createElement('button');
        upButton.className = 'arrow-button up';
        upButton.textContent = '↑';
        upButton.setAttribute('aria-label', `Move ${team.name} up`);
        upButton.disabled = index === 0;
        upButton.onclick = (e) => {
            e.stopPropagation();
            moveTeam(index, index - 1);
        };

        const downButton = document.createElement('button');
        downButton.className = 'arrow-button down';
        downButton.textContent = '↓';
        downButton.setAttribute('aria-label', `Move ${team.name} down`);
        downButton.disabled = index === rankings.length - 1;
        downButton.onclick = (e) => {
            e.stopPropagation();
            moveTeam(index, index + 1);
        };

        arrowButtons.append(trophyButton, upButton, downButton);
        teamCard.appendChild(arrowButtons);

        // Desktop shortcut: right-click toggles conference champion.
        teamCard.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            setConferenceChampion(team, true);
        });

        teamCard.addEventListener('dragstart', handleDragStart);
        teamCard.addEventListener('dragend', handleDragEnd);
        teamCard.addEventListener('dragover', handleDragOver);
        teamCard.addEventListener('drop', handleDrop);

        const wrapper = document.createElement('div');
        wrapper.className = 'ranking-row';
        wrapper.append(rankingNumber, teamCard);
        rankingsList.appendChild(wrapper);
    });
}

// One clickable team slot. Empty slots render a dash and ignore clicks.
function slotHTML(team, gameIndex, side, winnerName) {
    const isWinner = team && team.name === winnerName;
    const content = team
        ? `${logoImg(team.logo, 'bracket-team-logo')}<span>${team.seed} ${team.name}</span>`
        : '-';
    return `<div class="team-slot ${isWinner ? 'winner' : ''}" data-game="${gameIndex}" data-side="${side}">${content}</div>`;
}

function matchupHTML(game, gameIndex) {
    const winnerName = picks[gameIndex];
    return `
        <div class="matchup">
            ${slotHTML(game.a, gameIndex, 'a', winnerName)}
            ${slotHTML(game.b, gameIndex, 'b', winnerName)}
        </div>`;
}

function renderBracket() {
    const { games, champion } = computeGames();
    const renderRange = (id, from, to) => {
        document.getElementById(id).innerHTML =
            games.slice(from, to).map((g, i) => matchupHTML(g, from + i)).join('');
    };

    renderRange('first-round', 0, 4);
    renderRange('quarterfinals', 4, 8);
    renderRange('semifinals', 8, 10);
    renderRange('championship', 10, 11);

    const championDisplay = document.getElementById('champion-display');
    if (champion) {
        championDisplay.innerHTML = `
            ${logoImg(champion.logo, 'champion-team-logo')}
            <div>CHAMPION</div>
            <div class="champion-name">${champion.name}</div>
        `;
        championDisplay.classList.add('show');
    } else {
        championDisplay.innerHTML = '';
        championDisplay.classList.remove('show');
    }
}

// Event delegation: one listener for every bracket slot, so re-rendering
// the bracket HTML never has to re-wire click handlers.
document.querySelector('.bracket-container').addEventListener('click', (e) => {
    const slot = e.target.closest('.team-slot[data-game]');
    if (!slot) return;
    pickWinner(Number(slot.dataset.game), slot.dataset.side);
});

/* ------------------------------------------------------------------ */
/* Drag and drop (desktop; touch devices use the arrow buttons)       */
/* ------------------------------------------------------------------ */

let draggedIndex = null;

function handleDragStart(e) {
    draggedIndex = parseInt(e.currentTarget.dataset.index, 10);
    e.currentTarget.classList.add('dragging');
}

function handleDragEnd(e) {
    e.currentTarget.classList.remove('dragging');
}

function handleDragOver(e) {
    e.preventDefault();
}

function handleDrop(e) {
    e.preventDefault();
    const dropIndex = parseInt(e.currentTarget.dataset.index, 10);
    if (draggedIndex !== null) moveTeam(draggedIndex, dropIndex);
    draggedIndex = null;
}

/* ------------------------------------------------------------------ */
/* State serialization (share links + localStorage)                   */
/* ------------------------------------------------------------------ */
/*
 * Query format:  ?r=<order>&c=<champs>&p=<picks>
 *   r  base64url of team names joined by '|'. Names, not ids, because ids
 *      are re-assigned every week when rankings.json regenerates.
 *   c  comma-separated indices (into r) of conference champions.
 *   p  11 chars, one per game: 'a' / 'b' for the picked side, '-' for none.
 *      Sides rather than names keep links short; they are replayed in game
 *      order so each round resolves against the round before it.
 */

function toBase64Url(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    bytes.forEach(b => { binary += String.fromCharCode(b); });
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(encoded) {
    const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    return new TextDecoder().decode(Uint8Array.from(binary, ch => ch.charCodeAt(0)));
}

function serializeState() {
    const { games } = computeGames();
    const pickSides = picks.map((name, i) => {
        if (!name) return '-';
        return games[i].a?.name === name ? 'a' : 'b';
    }).join('');

    const params = new URLSearchParams();
    params.set('r', toBase64Url(rankings.map(t => t.name).join('|')));
    params.set('c', rankings.map((t, i) => (t.champ ? i : null)).filter(i => i !== null).join(','));
    params.set('p', pickSides);
    return params.toString();
}

// Applies a serialized state on top of freshly loaded rankings. Returns
// false if the payload is unusable; returns { partial: true } when some
// shared teams are no longer in this week's rankings.
function applySerializedState(query, sourceData) {
    const params = new URLSearchParams(query);
    if (!params.has('r')) return false;

    let names;
    try {
        names = fromBase64Url(params.get('r')).split('|').filter(Boolean);
    } catch {
        return false; // malformed / hand-edited link
    }

    const byName = new Map(sourceData.map(t => [t.name, { ...t }]));
    const champIndices = new Set(
        (params.get('c') || '').split(',').filter(Boolean).map(Number)
    );

    const ordered = [];
    names.forEach((name, i) => {
        const team = byName.get(name);
        if (!team) return;
        team.champ = champIndices.has(i) && !NON_CHAMP_CONFERENCES.has(team.conference);
        ordered.push(team);
        byName.delete(name);
    });
    if (ordered.length === 0) return false;

    // Teams new to this week's rankings go to the bottom, non-champion,
    // so the shared order is preserved as closely as possible.
    const extras = [...byName.values()].map(t => ({ ...t, champ: false }));
    const partial = extras.length > 0 || ordered.length !== names.length;
    rankings = [...ordered, ...extras];

    // Replay picks game by game: each pick is resolved against the
    // matchups produced by the picks before it.
    picks = Array(GAME_COUNT).fill(null);
    const sides = (params.get('p') || '').slice(0, GAME_COUNT);
    for (let i = 0; i < sides.length; i++) {
        const side = sides[i];
        if (side !== 'a' && side !== 'b') continue;
        const { games } = computeGames();
        const team = games[i][side];
        if (team) picks[i] = team.name;
    }

    return { partial };
}

function persistState() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            fingerprint: dataFingerprint,
            query: serializeState(),
        }));
    } catch {
        // Storage unavailable (private mode, blocked cookies): the app
        // still works, it just won't remember picks between visits.
    }
}

function loadSavedState() {
    try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    } catch {
        return null;
    }
}

/* ------------------------------------------------------------------ */
/* Sharing                                                            */
/* ------------------------------------------------------------------ */

function shareUrl() {
    return `${SITE_URL}?${serializeState()}`;
}

function shareText() {
    const { champion } = computeGames();
    return champion
        ? `My CFP bracket: ${champion.name} wins it all 🏆 Build yours:`
        : 'Build your College Football Playoff bracket:';
}

async function shareLink() {
    const url = shareUrl();
    const text = shareText();
    trackEvent('share-link', 'Share link');

    // Native share sheet on phones; desktop browsers mostly lack it.
    if (navigator.share) {
        try {
            await navigator.share({ title: 'CFP Bracket', text, url });
            return;
        } catch (err) {
            if (err.name === 'AbortError') return; // user closed the sheet
        }
    }

    try {
        await navigator.clipboard.writeText(`${text} ${url}`);
        showToast('Link copied — paste it anywhere');
    } catch {
        // Clipboard API blocked (e.g. insecure context): fall back to a
        // prompt so the user can still copy manually.
        window.prompt('Copy your bracket link:', url);
    }
}

const HTML2CANVAS_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';

// html2canvas is ~200KB and only needed when someone saves an image, so it
// is loaded on first use instead of on every page view.
function loadHtml2Canvas() {
    if (window.html2canvas) return Promise.resolve(window.html2canvas);
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = HTML2CANVAS_SRC;
        script.onload = () => resolve(window.html2canvas);
        script.onerror = () => reject(new Error('Failed to load html2canvas'));
        document.head.appendChild(script);
    });
}

async function saveImage() {
    const button = document.getElementById('save-image-button');
    button.disabled = true;
    trackEvent('save-image', 'Save image');

    try {
        const html2canvas = await loadHtml2Canvas();
        const bracketEl = document.querySelector('.bracket');
        const scale = 2;
        // Height of the shrink-wrapped clone, measured in onclone below.
        let contentHeight = null;

        const rendered = await html2canvas(bracketEl, {
            backgroundColor: '#1a1a1a',
            scale,
            useCORS: true,
            // On phones the bracket scrolls horizontally; un-clip the clone
            // so the image contains every round, and stamp the site URL on
            // it so a reposted screenshot still points back here.
            onclone: (doc) => {
                // Lets style.css swap effects html2canvas can't draw
                // (gradient text, transitions) for flat equivalents.
                doc.body.classList.add('capturing');
                const clone = doc.querySelector('.bracket');
                clone.style.width = 'max-content';
                clone.style.overflow = 'visible';
                // On short mobile pages the panel is stretched to fill the
                // viewport (flex item); shrink-wrap it so the image doesn't
                // carry a band of empty space below the bracket.
                clone.style.alignSelf = 'flex-start';
                clone.style.height = 'auto';
                clone.style.minHeight = '0';
                clone.querySelector('.bracket-container').style.overflow = 'visible';
                const watermark = doc.createElement('div');
                watermark.className = 'image-watermark';
                watermark.textContent = 'cfp-bracket.pdot.dev';
                clone.appendChild(watermark);
                // Elements marked data-html2canvas-ignore (share bar,
                // instructions) are already removed from the clone, so this
                // measures only what will be drawn.
                contentHeight = clone.getBoundingClientRect().height;
            },
        });

        // html2canvas sizes its canvas from the *live* element, which on
        // phones is stretched to the viewport height, so crop the result
        // to the clone's real content height.
        let canvas = rendered;
        const croppedHeight = contentHeight ? Math.ceil(contentHeight * scale) : rendered.height;
        if (croppedHeight < rendered.height) {
            canvas = document.createElement('canvas');
            canvas.width = rendered.width;
            canvas.height = croppedHeight;
            canvas.getContext('2d').drawImage(rendered, 0, 0);
        }

        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        const file = new File([blob], 'my-cfp-bracket.png', { type: 'image/png' });

        // Mobile: hand the image straight to the share sheet (X, Messages,
        // Photos). Elsewhere: plain download.
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
            try {
                await navigator.share({ files: [file], text: `${shareText()} ${SITE_URL}` });
                return;
            } catch (err) {
                if (err.name === 'AbortError') return;
            }
        }

        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = file.name;
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 10000);
        showToast('Bracket image saved');
    } catch (err) {
        console.error(err);
        showToast("Couldn't create the image — try again");
    } finally {
        button.disabled = false;
    }
}

/* ------------------------------------------------------------------ */
/* Small utilities                                                    */
/* ------------------------------------------------------------------ */

let toastTimer = null;
function showToast(message, durationMs = 2500) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), durationMs);
}

// GoatCounter custom event. No-ops if the analytics script is blocked or
// not yet loaded, so tracking can never break the app.
function trackEvent(path, title) {
    try {
        window.goatcounter?.count?.({ path, title, event: true });
    } catch {
        /* analytics are best-effort */
    }
}

function slugify(text) {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/* ------------------------------------------------------------------ */
/* Boot                                                               */
/* ------------------------------------------------------------------ */

function showLoadError() {
    document.getElementById('rankings-list').innerHTML =
        '<div class="load-error">Couldn\'t load this week\'s rankings. Please refresh the page.</div>';
}

fetch('/rankings.json')
    .then(response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
    })
    .then(data => {
        dataFingerprint = data.map(t => `${t.name}:${t.record}`).join('|');
        officialRankings = data;
        rankings = data.map(t => ({ ...t }));

        // Priority: a shared link in the URL, then this browser's saved
        // bracket (only if built on the same rankings), then the defaults.
        const urlQuery = window.location.search;
        let appliedFromUrl = false;
        if (urlQuery.includes('r=')) {
            const result = applySerializedState(urlQuery, data);
            appliedFromUrl = Boolean(result);
            if (result?.partial) {
                showToast('Rankings have updated since this bracket was shared', 4500);
            } else if (!result) {
                showToast('That bracket link looks broken — showing your bracket instead', 4500);
            }
            // Clean the URL so a refresh doesn't re-apply the link over
            // edits made since; the state is persisted below instead.
            history.replaceState(null, '', window.location.pathname);
        }

        // A broken link falls through to the saved bracket rather than
        // overwriting it with defaults.
        if (!appliedFromUrl) {
            const saved = loadSavedState();
            if (saved && saved.fingerprint === dataFingerprint) {
                applySerializedState(saved.query, data);
            } else if (saved) {
                showToast("New rankings are out — here's this week's bracket", 4500);
            }
        }

        renderRankings();
        renderBracket();
        persistState();
    })
    .catch(error => {
        console.error('Failed to load rankings:', error);
        showLoadError();
    });
