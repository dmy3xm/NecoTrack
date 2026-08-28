const CLIENT_ID = '43448';
const REDIRECT_URI = window.location.href.split('?')[0].split('#')[0];

let token = null;
let currentUser = null;
let allEntries = [];
let currentTab = 'CURRENT';
let groupingEnabled = true;
let editingEntry = null;
let modalScore = 0;
let modalStatus = '';
let modalStatusTouched = false;
let mediaCache = {};
let topYear = 'all';
let topCache = {};   // year -> { rows, page, hasNext }

// Formats that count as a main series; anything else is side content.
const MAIN_FORMATS = ['TV', 'TV_SHORT'];

const $ = id => document.getElementById(id);

// resolve "status.CURRENT" style dotted keys against T
const tr = key => key.split('.').reduce((o, k) => o && o[k], T);

// Notes are the one user-authored string rendered through innerHTML. Quotes are
// escaped too, so this is safe for attribute values, not just text.
const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => el.textContent = tr(el.dataset.i18n));
  document.querySelectorAll('[data-i18n-ph]').forEach(el => el.placeholder = tr(el.dataset.i18nPh));
  document.querySelectorAll('[data-i18n-title]').forEach(el => el.title = tr(el.dataset.i18nTitle));
}

// ── AUTH ──
function startOAuth() {
  const url = `https://anilist.co/api/v2/oauth/authorize?client_id=${CLIENT_ID}&response_type=token`;
  window.location.href = url;
}

function loginWithToken() {
  const t = $('manual-token').value.trim();
  if (!t) { showToast(T.enterToken); return; }
  token = t;
  localStorage.setItem('al_token', t);
  initApp();
}

function logout() {
  localStorage.removeItem('al_token');
  token = null;
  allEntries = [];
  $('auth-screen').style.display = 'flex';
  $('app').style.display = 'none';
}

function parseTokenFromHash() {
  const hash = window.location.hash;
  if (!hash) return null;
  const params = new URLSearchParams(hash.substring(1));
  return params.get('access_token');
}

// ── GRAPHQL ──
async function gql(query, variables = {}) {
  const res = await fetch('https://graphql.anilist.co', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ query, variables })
  });
  const data = await res.json();
  if (data.errors) throw new Error(data.errors[0].message);
  return data.data;
}

async function fetchUser() {
  const data = await gql(`query { Viewer { id name avatar { medium } } }`);
  return data.Viewer;
}

async function fetchList(userId) {
  const data = await gql(`
    query($userId: Int) {
      MediaListCollection(userId: $userId, type: ANIME) {
        lists {
          entries {
            id
            status
            score(format: POINT_10)
            progress
            notes
            updatedAt
            media {
              id
              idMal
              title { romaji english }
              coverImage { medium large }
              format
              episodes
              season
              seasonYear
              relations {
                edges {
                  relationType(version: 2)
                  node { id type }
                }
              }
            }
          }
        }
      }
    }
  `, { userId });
  const entries = [];
  for (const list of data.MediaListCollection.lists) {
    for (const e of list.entries) entries.push(e);
  }
  return entries;
}

async function updateEntry(listId, status, score, progress, notes) {
  return gql(`
    mutation($id: Int, $status: MediaListStatus, $score: Float, $progress: Int, $notes: String) {
      SaveMediaListEntry(id: $id, status: $status, score: $score, progress: $progress, notes: $notes) {
        id status score progress notes
      }
    }
  `, { id: listId, status, score, progress, notes });
}

// ── GROUPING ──
function buildSeriesGroups(entries) {
  const byId = {};
  for (const e of entries) byId[e.media.id] = e;

  const parent = {};
  function find(x) {
    if (parent[x] === undefined) parent[x] = x;
    if (parent[x] !== x) parent[x] = find(parent[x]);
    return parent[x];
  }
  function union(a, b) {
    a = find(a); b = find(b);
    if (a !== b) parent[b] = a;
  }

  for (const e of entries) {
    const id = e.media.id;
    for (const edge of e.media.relations.edges) {
      if (edge.node.type !== 'ANIME' || !byId[edge.node.id]) continue;
      const rt = edge.relationType;
      if (rt === 'SEQUEL' || rt === 'PREQUEL') {
        union(id, edge.node.id);
      } else if (rt === 'PARENT' || rt === 'SIDE_STORY') {
        // Attach movies/OVAs/specials to their series, but never merge two main
        // series this way — that collapses umbrella franchises like Gundam.
        const other = byId[edge.node.id];
        if (!MAIN_FORMATS.includes(e.media.format) || !MAIN_FORMATS.includes(other.media.format)) {
          union(id, edge.node.id);
        }
      }
    }
  }

  const groups = {};
  for (const e of entries) {
    const root = find(e.media.id);
    if (!groups[root]) groups[root] = [];
    groups[root].push(e);
  }

  return Object.values(groups).map(g => {
    g.sort((a, b) => (a.media.seasonYear || 9999) - (b.media.seasonYear || 9999));
    return g;
  });
}

// ── RENDER HELPERS ──
// ── UKRAINIAN TITLES, LIVE FROM HIKKA ──
// hikka.io publishes an open API with no key, but sends Access-Control-Allow-Origin
// only to its own site — a plain fetch from here fails outright, GET included. So
// calls go through our own Cloudflare Worker, which forwards to api.hikka.io and
// nothing else. Public proxies were tried first and two of them changed terms or
// died within two days; this one is ours, so nobody else's policy can break it.
// AniList hands us idMal, so the join is an integer, never a string compare.
const UK_PROXY = u =>
  'https://necotrack-hikka.dmy3x-m.workers.dev/?url=' + encodeURIComponent(u);
const UK_STORE = 'uk_titles_v1';
const ukCache = new Map(JSON.parse(localStorage.getItem(UK_STORE) || '[]'));
const ukPending = new Set();
let ukSaveTimer = null;

function ukPersist() {
  clearTimeout(ukSaveTimer);
  // one write per burst rather than one per title
  ukSaveTimer = setTimeout(() => {
    try { localStorage.setItem(UK_STORE, JSON.stringify([...ukCache])); } catch(e) {}
  }, 600);
}

// A miss is cached as null on purpose: without it, every repaint re-asks for the
// titles Hikka does not have, which is most of the long tail.
// Hikka gains titles over time, so "not there" has to be allowed to expire —
// stored as a plain null it never would. A cache value is therefore either the
// name (a string) or the moment the lookup came up empty (a number). Values left
// as null by the earlier format read as stale and get one free re-check.
const UK_MISS_TTL = 14 * 24 * 60 * 60 * 1000;
const ukStale = v => v === null || (typeof v === 'number' && Date.now() - v > UK_MISS_TTL);

async function ukLookup(idMal) {
  ukPending.add(idMal);
  try {
    const r = await fetch(UK_PROXY('https://api.hikka.io/integrations/mal/anime/' + idMal));
    const uk = r.ok ? ((await r.json()).title_ua || null) : null;
    ukCache.set(idMal, uk || Date.now());
    return !!uk;
  } catch(e) {
    ukCache.set(idMal, Date.now());
    return false;
  } finally {
    ukPending.delete(idMal);
  }
}

// getTitle() is synchronous and every render path depends on that, so names
// cannot arrive mid-render. Instead: paint with what is cached, fetch the rest,
// repaint once. Repaint only when something new landed, or this recurses.
async function resolveUk(medias, repaint) {
  const want = [...new Set(medias.map(m => m && m.idMal)
    .filter(id => id && !ukPending.has(id)
      && (!ukCache.has(id) || ukStale(ukCache.get(id)))))];
  if (!want.length) return;
  let found = 0;
  const queue = want.map(id => () => ukLookup(id).then(ok => { if (ok) found++; }));
  while (queue.length) await Promise.all(queue.splice(0, 5).map(f => f()));
  ukPersist();
  if (found) repaint();
}

// About four results fit the dropdown before it scrolls, and it rarely gets
// scrolled — so fetching a dozen is a page nobody reads. Six leaves headroom.
const SEARCH_SHOW = 6;

// AniList stores no Ukrainian titles at all, so a Cyrillic query can only be
// answered by Hikka. It hands back mal_id, AniList takes those as a filter, and
// what comes out is ordinary AniList media — so the dropdown, the info card and
// "+ Add" all keep working untouched.
async function searchViaHikka(query) {
  const r = await fetch(UK_PROXY(`https://api.hikka.io/anime?page=1&size=${SEARCH_SHOW + 3}`), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query })
  });
  if (!r.ok) throw new Error('Hikka ' + r.status);
  const ids = [];
  for (const a of (await r.json()).list || []) {
    if (!a.mal_id) continue;
    ids.push(a.mal_id);
    // the Ukrainian name arrived with the search, so it costs nothing to keep
    ukCache.set(a.mal_id, a.title_ua || Date.now());
  }
  if (!ids.length) return [];
  ukPersist();
  const data = await gql(`
    query($ids: [Int]) {
      Page(perPage: ${SEARCH_SHOW + 3}) {
        media(idMal_in: $ids, type: ANIME) {
          id idMal title { romaji english } coverImage { medium }
          episodes seasonYear format
        }
      }
    }
  `, { ids });
  // AniList returns its own order; Hikka's was by relevance, so put it back
  const rank = new Map(ids.map((id, i) => [id, i]));
  return (data.Page.media || [])
    .sort((a, b) => rank.get(a.idMal) - rank.get(b.idMal))
    .slice(0, SEARCH_SHOW);
}

function getTitle(media) {
  const t = media.title;
  const uk = media.idMal ? ukCache.get(media.idMal) : null;
  if (typeof uk === 'string' && uk) return uk;   // a number here is a past miss
  /* BACKUP — the previous file-based system. If Hikka or the proxy dies, restore
     uk-titles.js, uncomment its <script> in index.html, and uncomment this:
  if (typeof UK_TITLES !== 'undefined') {
    const f = UK_TITLES[media.id] || UK_TITLES[t.english] || UK_TITLES[t.romaji] || UK_TITLES[t.native];
    if (f) return f;
  }
  */
  return t.english || t.romaji;
}

// AniList fills year, month and day independently, so a start date is often
// partial — an unaired title regularly has a year and nothing else. Each level
// is formatted with only what is actually known rather than inventing a day.
function releaseDateText(d) {
  if (!d || !d.year) return T.dateUnknown;
  const parts = d.month
    ? (d.day ? { day: 'numeric', month: 'long', year: 'numeric' } : { month: 'long', year: 'numeric' })
    : { year: 'numeric' };
  return new Date(d.year, (d.month || 1) - 1, d.day || 1).toLocaleDateString(T.locale, parts);
}

// The unaired-poster treatment, in one place so every grid that shows covers
// wears the same one: the status covers the art and clears on hover, and the
// release date sits under the poster, revealed by hovering it. Both are empty
// for anything already aired — only an unaired title carries a date.
const isUnaired = m => m.status === 'NOT_YET_RELEASED';

function unairedBadge(m) {
  return isUnaired(m) ? `<div class="cover-status">${T.mediaStatus[m.status]}</div>` : '';
}

// Sits inside the poster, mirroring the status badge at the other end, so the
// card keeps exactly the shape every other card has. Both clear together on
// hover to hand the art back.
function unairedDate(m) {
  return isUnaired(m) ? `<div class="poster-date">${esc(releaseDateText(m.startDate))}</div>` : '';
}

function getSeriesTitle(group) {
  /* BACKUP — UK_SERIES came from uk-titles.js and named whole franchises. Hikka
     names every season separately instead, so the header is derived by stripping
     the season suffix. Uncomment alongside the block in getTitle().
  if (typeof UK_SERIES !== 'undefined') {
    for (const e of group) {
      if (UK_SERIES[e.media.id]) return UK_SERIES[e.media.id];
    }
  }
  */
  const main = group.find(e => MAIN_FORMATS.includes(e.media.format)) || group[0];
  const t = getTitle(main.media);
  return t.replace(/\s+(Season\s+\d+|S\d+|\d+(st|nd|rd|th)\s+Season)$/i,'')
          // Hikka's own form, e.g. "Ґінтама - 4 сезон, 2 частина"
          .replace(/\s*[-–—]\s*\d+\s*сезон(\s*,\s*\d+\s*частина)?\s*$/i,'')
          .trim() || t;
}

function normalize(s) {
  // \w is ASCII-only, so the old [^\w\s] deleted every Cyrillic letter and left
  // an empty query — which then matched every row. \p{L} keeps any alphabet.
  return s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu,'').replace(/\s+/g,' ').trim();
}

function fuzzyMatch(query, target) {
  if (!target) return false;
  const q = normalize(query), t = normalize(target);
  if (t.includes(q)) return true;
  return q.split(' ').filter(Boolean).every(tok => t.includes(tok));
}

// ── CATALOG SEARCH ──
let catalogTimer = null;
let lastCatalogQuery = '';
let lastCatalogResults = [];

// Typing one title fires a query per keystroke and backspacing retreads them, so
// search is the one path that repeats. Memory only: results are bulky, they go
// stale, and the Ukrainian names inside them already persist via ukCache.
const SEARCH_TTL = 10 * 60 * 1000;
const SEARCH_MAX = 60;
const searchCache = new Map();

function searchCached(q) {
  const hit = searchCache.get(q);
  if (!hit) return null;
  if (Date.now() - hit.at > SEARCH_TTL) { searchCache.delete(q); return null; }
  return hit.results;
}

function searchStore(q, results) {
  // Empty results are not cached: a miss is often the proxy failing rather than
  // the catalogue lacking the title, and that should be retried, not remembered.
  if (!results.length) return;
  searchCache.set(q, { at: Date.now(), results });
  // Map keeps insertion order, so the first key is always the oldest
  while (searchCache.size > SEARCH_MAX) searchCache.delete(searchCache.keys().next().value);
}

function onSearchInput(val) {
  if (currentTab !== 'TOP') renderList();
  const v = val.trim();
  if (v.length < 2) { closeCatalog(); return; }
  clearTimeout(catalogTimer);
  catalogTimer = setTimeout(() => searchCatalog(v), 400);
}

async function searchCatalog(query) {
  if (query === lastCatalogQuery) return;
  lastCatalogQuery = query;
  lastCatalogResults = [];
  const drop = $('catalog-results');
  drop.style.display = 'block';

  const cached = searchCached(query);
  if (cached) { lastCatalogResults = cached; paintCatalog(); return; }

  drop.innerHTML = `<div class="catalog-loading">${T.searching}</div>`;
  try {
    // Hikka first, for every query — it prefix-matches properly where AniList's
    // is erratic ("Frieren" answers there at two letters, then nothing until
    // seven), and it indexes English and Japanese names, not only Ukrainian.
    // AniList is the rescue: it still finds the oddly-named sequels Hikka has no
    // entry for, and it is where every search lands if the proxy stops
    // answering — so an outage costs the better matching, never the search.
    try {
      lastCatalogResults = await searchViaHikka(query);
    } catch(e) {
      lastCatalogResults = [];
    }
    if (!lastCatalogResults.length) {
      const data = await gql(`
        query($search: String) {
          Page(perPage: ${SEARCH_SHOW}) {
            media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
              id
              idMal
              title { romaji english }
              coverImage { medium }
              episodes
              seasonYear
              format
            }
          }
        }
      `, { search: query });
      lastCatalogResults = data.Page.media;
    }
    searchStore(query, lastCatalogResults);
    paintCatalog();
  } catch(e) {
    drop.innerHTML = `<div class="catalog-loading">${T.errPrefix}${e.message}</div>`;
  }
}

// Split from the fetch so that changing the year on Top can re-mark the
// wrong-year rows from the results already in hand, without a second request.
const CYRILLIC = /[Ѐ-ӿ]/;

// Which of a title's names did the query actually hit? A romaji search should
// confirm itself rather than answering with an English name nobody typed.
function matchedName(m, query) {
  const en = m.title.english || '', ro = m.title.romaji || '';
  const q = normalize(query || '');
  if (q && ro && normalize(ro).includes(q) && !(en && normalize(en).includes(q))) return ro;
  return en || ro;
}

function paintCatalog() {
  const drop = $('catalog-results');
  const results = lastCatalogResults;
  if (!results.length) { drop.innerHTML = `<div class="catalog-loading">${T.nothingFound}</div>`; return; }
  const listIds = new Set(allEntries.map(e => e.media.id));
  const onTop = currentTab === 'TOP';
  const year = onTop && topYear !== 'all' ? Number(topYear) : null;
  const ukFirst = CYRILLIC.test(lastCatalogQuery || '');
  let html = `<div class="search-mode-hint"><span>${T.catalogResults}</span><button onclick="closeCatalog()">✕</button></div>`;
  for (const m of results) {
    // Lead with the name in the language that was typed: search in Latin and the
    // Latin name is the one being looked for, search in Ukrainian and it is not.
    // The other name goes underneath, so nothing is hidden either way.
    const latin = matchedName(m, lastCatalogQuery);
    const uk = getTitle(m);
    const title = ukFirst ? uk : (latin || uk);
    const second = ukFirst ? latin : uk;
    const inList = listIds.has(m.id);
    const meta = [m.format, m.episodes ? m.episodes+' '+T.epShort : null, m.seasonYear].filter(Boolean).join(' · ');
    html += `
      <div class="catalog-item" style="cursor:pointer" onclick="${onTop ? `jumpToTop(${m.id})` : `openInfoModal(${m.id})`}">
        <img src="${m.coverImage.medium}" class="catalog-cover" loading="lazy">
        <div class="catalog-info">
          <div class="catalog-title">${title}</div>
          ${second && second !== title ? `<div class="catalog-original">${second}</div>` : ''}
          <div class="catalog-meta">${meta}</div>
          ${year !== null && m.seasonYear !== year ? `<div class="catalog-warn">${T.topOtherYear(m.seasonYear)}</div>` : ''}
        </div>
        <span onclick="event.stopPropagation()">${inList
          ? `<span class="catalog-add in-list">${T.catalogInList}</span>`
          : `<button class="catalog-add" onclick="addToList(${m.id}, event)">${T.catalogAdd}</button>`
        }</span>
      </div>
    `;
  }
  drop.innerHTML = html;
}

function closeCatalog() {
  lastCatalogQuery = '';
  lastCatalogResults = [];
  const drop = $('catalog-results');
  drop.style.display = 'none';
  drop.innerHTML = '';
}

// Core add: creates a list entry with the given status and updates local state.
async function addEntry(mediaId, status) {
  const data = await gql(`
    mutation($mediaId: Int, $status: MediaListStatus) {
      SaveMediaListEntry(mediaId: $mediaId, status: $status) {
        id status score progress notes updatedAt
        media {
          id idMal title { romaji english } coverImage { medium large }
          format episodes season seasonYear
          relations { edges { relationType(version: 2) node { id type } } }
        }
      }
    }
  `, { mediaId, status });
  const entry = data.SaveMediaListEntry;
  // The same title can be added twice now that the info modal is reachable
  // from the sequel popup — replace rather than duplicate the row.
  const existing = allEntries.findIndex(e => e.media.id === entry.media.id);
  if (existing >= 0) allEntries[existing] = entry;
  else allEntries.push(entry);
  renderList();
  return entry;
}

// Catalog quick-add (→ Planning), with button feedback.
async function addToList(mediaId, event) {
  const btn = event.target;
  btn.textContent = '…';
  btn.disabled = true;
  try {
    await addEntry(mediaId, 'PLANNING');
    btn.textContent = T.catalogInList;
    btn.classList.add('in-list');
    btn.disabled = true;
    showToast(T.added);
  } catch(e) {
    btn.textContent = T.catalogAdd;
    btn.disabled = false;
    showToast(T.errPrefix + e.message);
  }
}

// Add from the info modal with a chosen status, then refresh the modal controls.
async function addFromInfo(mediaId, status) {
  try {
    await addEntry(mediaId, status);
    showToast(T.addedToList);
    if (mediaCache[mediaId]) renderInfoModal(mediaCache[mediaId]);
  } catch(e) {
    showToast(T.errPrefix + e.message);
  }
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-wrap')) closeCatalog();
});

// ── RENDER ──
function renderList() {
  applyTopChrome();
  if (currentTab === 'TOP') { renderTop(); return; }

  const container = $('list-container');
  const search = ($('search-input').value || '').toLowerCase().trim();
  const sort = $('sort-select').value;

  let filtered = currentTab === 'ALL'
    ? [...allEntries]
    : allEntries.filter(e => e.status === currentTab);

  if (search) {
    filtered = filtered.filter(e => fuzzyMatch(search, getTitle(e.media))
      || fuzzyMatch(search, e.media.title.romaji || '')
      || fuzzyMatch(search, e.media.title.english || ''));
  }

  renderStats(filtered);

  if (filtered.length === 0) {
    container.innerHTML = `<div class="empty-state"><img src="empty.png" class="empty-img" alt="${T.emptyAlt}"><div>${T.empty}</div></div>`;
    return;
  }

  if (groupingEnabled) renderGrouped(filtered, sort, container);
  else renderFlat(filtered, sort, container);

  resolveUk(filtered.map(e => e.media), renderList);
}

function renderStats(entries) {
  const bar = $('stats-bar');
  const total = entries.length;
  const scored = entries.filter(e => e.score > 0);
  const avgScore = scored.length ? (scored.reduce((s,e)=>s+e.score,0)/scored.length).toFixed(1) : '—';
  const eps = entries.reduce((s,e)=>s+(e.progress||0),0);
  bar.innerHTML = `
    <div class="stat-chip"><strong>${total}</strong> ${T.statAnime}</div>
    <div class="stat-chip"><strong>${avgScore}</strong> ${T.statAvg}</div>
    <div class="stat-chip"><strong>${eps}</strong> ${T.statEpisodes}</div>
  `;
}

function sortEntries(entries, sort) {
  return [...entries].sort((a, b) => {
    if (sort === 'title')    return getTitle(a.media).localeCompare(getTitle(b.media));
    if (sort === 'score')    return (b.score||0) - (a.score||0);
    if (sort === 'progress') return (b.progress||0) - (a.progress||0);
    if (sort === 'updated')  return (b.updatedAt||0) - (a.updatedAt||0);
    if (sort === 'year')     return (b.media.seasonYear||0) - (a.media.seasonYear||0);
    return 0;
  });
}

function renderGrouped(entries, sort, container) {
  const groups = buildSeriesGroups(entries);

  groups.sort((ga, gb) => {
    const sort_ = $('sort-select').value;
    if (sort_ === 'title') return getSeriesTitle(ga).localeCompare(getSeriesTitle(gb));
    if (sort_ === 'score') {
      const avgA = ga.filter(e=>e.score>0).reduce((s,e)=>s+e.score,0) / (ga.filter(e=>e.score>0).length||1);
      const avgB = gb.filter(e=>e.score>0).reduce((s,e)=>s+e.score,0) / (gb.filter(e=>e.score>0).length||1);
      return avgB - avgA;
    }
    if (sort_ === 'updated') return (gb[gb.length-1].updatedAt||0) - (ga[ga.length-1].updatedAt||0);
    if (sort_ === 'year') return (gb[0].media.seasonYear||0) - (ga[0].media.seasonYear||0);
    return 0;
  });

  let html = '<div class="anime-list">';
  for (const group of groups) {
    const isMulti = group.length > 1;
    const rep = group[0];
    const seriesTitle = getSeriesTitle(group);
    const cover = rep.media.coverImage.large || rep.media.coverImage.medium;
    const scored = group.filter(e=>e.score>0);
    const avgScore = scored.length ? (scored.reduce((s,e)=>s+e.score,0)/scored.length).toFixed(1) : null;
    const groupId = 'g_' + rep.media.id;

    if (isMulti) {
      html += `
        <div class="series-group" id="${groupId}">
          <div class="series-header" onclick="toggleGroup('${groupId}')">
            <img src="${cover}" class="series-cover" loading="lazy" style="cursor:pointer" onclick="event.stopPropagation(); openInfoModal(${rep.media.id})">
            <div class="series-info">
              <div class="series-title">${seriesTitle}</div>
              <div class="series-meta">
                <span class="season-count">${group.length} ${T.seasons}</span>
                ${avgScore ? `<span class="series-score-avg">★ ${avgScore}</span>` : ''}
              </div>
            </div>
            <span class="chevron">▶</span>
          </div>
          <div class="seasons-list" style="display:none">
      `;
      for (const entry of group) html += rowHTML(entry, 'season');
      html += `</div></div>`;
    } else {
      html += rowHTML(rep, 'standalone');
    }
  }
  html += '</div>';
  container.innerHTML = html;
}

function renderFlat(entries, sort, container) {
  const sorted = sortEntries(entries, sort);
  let html = '<div class="anime-list">';
  for (const entry of sorted) html += rowHTML(entry, 'standalone');
  html += '</div>';
  container.innerHTML = html;
}

function progressBar(prog, eps) {
  if (!eps) return '';
  const pct = Math.min(100, Math.round((prog / eps) * 100));
  return `<div class="progress-bar-wrap"><div class="progress-bar-fill" style="width:${pct}%"></div></div>`;
}

// One row for both grouped seasons (variant 'season') and standalone cards (variant 'standalone').
function rowHTML(entry, variant) {
  const m = entry.media, eps = m.episodes, prog = entry.progress || 0;
  const cover = m.coverImage.large || m.coverImage.medium;
  const scored = entry.score > 0, isDone = eps && prog >= eps;
  const metaClass = variant === 'season' ? 'season-submeta' : 'standalone-meta';
  return `
    <div class="${variant}-row" style="cursor:pointer" onclick="openInfoModal(${m.id})">
      <img src="${cover}" class="${variant}-cover" loading="lazy">
      <div class="${variant}-info">
        <div class="${variant}-title">${getTitle(m)}</div>
        <div class="${metaClass}">
          <span class="status-badge status-${entry.status}">${T.status[entry.status] || entry.status}</span>
          <span class="progress-text">${prog}${eps ? '/'+eps : ''} ${T.epShort}</span>
        </div>
        ${progressBar(prog, eps)}
      </div>
      <div class="season-actions" onclick="event.stopPropagation()">
        <span class="score-badge ${scored ? '' : 'no-score'}">${scored ? entry.score : '—'}</span>
        ${isDone ? '' : `<button class="btn-plus" onclick='quickPlus(${entry.id})' title="${T.plusEpisode}">+</button>`}
        <button class="btn-sm btn-edit" onclick='openModal(${JSON.stringify(entry).replace(/'/g,"&#39;")})'>✎</button>
      </div>
    </div>
  `;
}

function toggleGroup(id) {
  const el = $(id);
  const sl = el.querySelector('.seasons-list');
  el.classList.toggle('open');
  sl.style.display = el.classList.contains('open') ? 'block' : 'none';
}

// ── QUICK +1 ──
async function quickPlus(entryId) {
  const entry = allEntries.find(e => e.id === entryId);
  if (!entry) return;
  const total = entry.media.episodes || 99999;
  const newProg = Math.min((entry.progress || 0) + 1, total);
  try {
    const newStatus = ['PLANNING', 'PAUSED', 'DROPPED'].includes(entry.status) ? 'CURRENT' : entry.status;
    await updateEntry(entry.id, newStatus, entry.score, newProg, entry.notes);
    entry.progress = newProg;
    entry.status = newStatus;
    let justCompleted = false;
    if (entry.media.episodes && newProg >= entry.media.episodes && entry.status === 'CURRENT') {
      entry.status = 'COMPLETED';
      await updateEntry(entry.id, 'COMPLETED', entry.score, newProg, entry.notes);
      showToast(T.completed);
      justCompleted = true;
    } else {
      showToast(T.toastProgress(newProg, entry.media.episodes));
    }
    renderList();
    if (justCompleted) maybeSuggestSequel(entry);
  } catch(e) {
    showToast(T.errPrefix + e.message);
  }
}

// ── TOP (global AniList ranking) ──
// Current year down to 1940, the oldest year AniList has a scored entry for.
// The current year is the newest worth offering — next year has nothing scored.
// Rebuilt per render so a session left open across New Year still picks it up.
const TOP_FIRST_YEAR = 1940;
const TOP_FIND_AHEAD = 300;   // how far past the loaded rows a search may walk
function topYears() {
  const out = ['all'];
  for (let y = new Date().getFullYear(); y >= TOP_FIRST_YEAR; y--) out.push(y);
  return out;
}

// Sort, grouping and the stats bar all describe the user's own list, so they are
// hidden on Top; the search box becomes a global AniList search instead.
function applyTopChrome() {
  const isTop = currentTab === 'TOP';
  $('sort-select').style.display = isTop ? 'none' : '';
  document.querySelector('.toggle-group').style.display = isTop ? 'none' : '';
  $('stats-bar').style.display = isTop ? 'none' : '';
  $('top-filters').classList.toggle('open', isTop);
  const inp = $('search-input');
  inp.placeholder = isTop ? T.topSearchPh : T.searchPlaceholder;
  inp.classList.toggle('global-search', isTop);
}

async function fetchTop(year, page) {
  const data = await gql(`
    query($page: Int, $year: Int) {
      Page(page: $page, perPage: 50) {
        pageInfo { hasNextPage }
        media(type: ANIME, sort: SCORE_DESC, seasonYear: $year, averageScore_greater: 1) {
          id idMal title { romaji english } coverImage { medium large }
          averageScore format episodes seasonYear
        }
      }
    }
  `, { page, year: year === 'all' ? undefined : year });
  return { rows: data.Page.media, hasNext: data.Page.pageInfo.hasNextPage };
}

function renderTopYears() {
  const allOn = topYear === 'all';
  $('top-years').innerHTML = topYears().map(y => {
    if (y === 'all') return `<button class="chip chip-all ${allOn ? 'on' : ''}" onclick="setTopYear('all')">${T.topAllYears}</button>`;
    const cls = String(y) === String(topYear) ? 'on' : (allOn ? 'lit' : '');
    return `<button class="chip ${cls}" onclick="setTopYear(${y})">${y}</button>`;
  }).join('');
  $('top-heading').textContent = T.topHeading(allOn ? T.topAllTime : topYear);
  // the strip is long now — don't leave the active year scrolled out of sight
  const active = $('top-years').querySelector('.chip.on');
  if (active) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  syncYearArrows();
}

function setTopYear(y) {
  topYear = y;
  renderTop();
  // the wrong-year note depends on which year is selected, so repaint an open
  // dropdown — from the results already fetched, not a second request.
  if (lastCatalogResults.length) paintCatalog();
}

async function renderTop() {
  renderTopYears();
  const container = $('list-container');
  const key = String(topYear);
  if (!topCache[key]) {
    container.innerHTML = `<div class="loading"><div class="spinner"></div><div>${T.loading}</div></div>`;
    try {
      const { rows, hasNext } = await fetchTop(topYear, 1);
      topCache[key] = { rows, page: 1, hasNext };
    } catch(e) {
      container.innerHTML = `<div class="empty-state"><div>${T.errPrefix}${e.message}</div></div>`;
      return;
    }
    if (currentTab !== 'TOP' || String(topYear) !== key) return;   // user moved on while loading
  }
  paintTop();
}

function paintTop() {
  const state = topCache[String(topYear)];
  if (!state) return;
  const listIds = new Set(allEntries.map(e => e.media.id));
  const rows = state.rows.map((m, i) => `
    <div class="top-row" data-id="${m.id}" onclick="openInfoModal(${m.id})">
      <div class="top-rank${i < 3 ? ' top3' : ''}">${i + 1}</div>
      <img src="${m.coverImage.large || m.coverImage.medium}" class="top-cover" loading="lazy">
      <div class="top-info">
        <div class="top-title">${getTitle(m)}</div>
        <div class="top-meta">${[T.format[m.format] || m.format, m.seasonYear, m.episodes ? m.episodes + ' ' + T.epShort : ''].filter(Boolean).join(' · ')}</div>
        ${listIds.has(m.id)
          ? `<div class="top-add"><span class="catalog-add in-list">${T.catalogInList}</span></div>`
          : ''}
      </div>
      <div class="top-score">★ ${(m.averageScore / 10).toFixed(1)}</div>
    </div>`).join('');
  const more = state.hasNext
    ? `<button class="top-more" onclick="loadMoreTop()">${T.topMore}</button>` : '';
  $('list-container').innerHTML = `<div class="top-list">${rows}${more}</div>`;

  resolveUk(state.rows, () => { if (currentTab === 'TOP') paintTop(); });
}

async function loadMoreTop() {
  const key = String(topYear);
  const state = topCache[key];
  if (!state || state.loading || !state.hasNext) return;
  state.loading = true;
  const btn = document.querySelector('.top-more');
  if (btn) { btn.textContent = '…'; btn.disabled = true; }
  try {
    const { rows, hasNext } = await fetchTop(topYear, state.page + 1);
    state.rows = state.rows.concat(rows);
    state.page += 1;
    state.hasNext = hasNext;
    if (currentTab === 'TOP' && String(topYear) === key) paintTop();
  } catch(e) {
    showToast(T.errPrefix + e.message);
    if (btn) { btn.textContent = T.topMore; btn.disabled = false; }
  }
  state.loading = false;
}

// Desktop needs an explicit affordance: there is no drag with a mouse.
// Paging by a fixed step overshot the visible strip and stepped straight over
// years that were never on screen, so a click moves by whole chips instead: the
// first year that is even partly cut off becomes the first fully visible one.
// Nothing is skipped in either direction and no year is left half-drawn.
function scrollYears(dir) {
  const el = $('top-years');
  const chips = [...el.children];
  if (!chips.length) return;

  const view = el.clientWidth;
  const strip = el.getBoundingClientRect();
  // Chip edges in the strip's own scroll coordinates, so gaps and padding are
  // already accounted for and nothing depends on where offsetParent lands.
  const edges = chips.map(c => {
    const box = c.getBoundingClientRect();
    return { start: box.left - strip.left + el.scrollLeft, width: box.width };
  });

  // Anchor on the last year that *begins* inside the view rather than the first
  // one that is cut off: a chip overflowing by a fraction of a pixel would slip
  // under any "is it clipped" tolerance and be stepped over. This way a clipped
  // year becomes whole and an already-whole one merely repeats, so consecutive
  // pages always overlap by a chip and can never leave a gap between them.
  let target;
  if (dir > 0) {
    const anchor = [...edges].reverse().find(e => e.start < el.scrollLeft + view - 1);
    target = anchor && anchor.start > el.scrollLeft + 1 ? anchor.start : el.scrollLeft + view;
  } else {
    const anchor = edges.find(e => e.start + e.width > el.scrollLeft + 1);
    const aligned = anchor ? anchor.start + anchor.width - view : el.scrollLeft - view;
    target = aligned < el.scrollLeft - 1 ? aligned : el.scrollLeft - view;
  }
  const max = Math.max(0, el.scrollWidth - view);
  el.scrollTo({ left: Math.max(0, Math.min(target, max)), behavior: 'smooth' });
}

function syncYearArrows() {
  const el = $('top-years');
  const max = el.scrollWidth - el.clientWidth;
  $('year-prev').disabled = el.scrollLeft <= 1;
  $('year-next').disabled = el.scrollLeft >= max - 1;
}

function flashTopRow(row) {
  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  row.classList.add('found');
  setTimeout(() => row.classList.remove('found'), 2000);
}

// Picking a search result on Top moves the ranking to that title. A rank can't
// be queried (pageInfo.total is a fixed 5000), so the only way to locate one is
// to walk pages — bounded here to TOP_FIND_AHEAD past whatever is already loaded.
async function jumpToTop(mediaId, picked) {
  picked = picked || lastCatalogResults.find(m => m.id === mediaId) || null;
  closeCatalog();
  $('search-input').value = '';

  const key = String(topYear);
  const state = topCache[key];
  if (!state) return;

  // A release from another year cannot be in this ranking at all, so walking
  // pages for it would spend requests to learn nothing. Say which year it is
  // and leave the switch to the user.
  if (picked && topYear !== 'all' && picked.seasonYear !== Number(topYear)) {
    showTopFind(picked, 'year', state.rows.length);
    return;
  }
  const hit = () => document.querySelector(`.top-row[data-id="${mediaId}"]`);
  let row = hit();
  if (row) { flashTopRow(row); return; }

  const limit = state.rows.length + TOP_FIND_AHEAD;
  const btn = document.querySelector('.top-more');
  if (btn) { btn.textContent = T.topSearching; btn.disabled = true; }

  while (!row && state.hasNext && state.rows.length < limit) {
    let batch;
    try {
      batch = await fetchTop(topYear, state.page + 1);
    } catch(e) {
      showToast(T.errPrefix + e.message);
      break;
    }
    if (currentTab !== 'TOP' || String(topYear) !== key) return;   // user moved on
    state.rows = state.rows.concat(batch.rows);
    state.page += 1;
    state.hasNext = batch.hasNext;
    paintTop();
    row = hit();
  }

  // paintTop() rebuilds the button, but a walk that never looped — nothing left
  // to fetch, or already deep enough — has to hand it back itself.
  const stale = document.querySelector('.top-more');
  if (stale && stale.disabled) { stale.textContent = T.topMore; stale.disabled = false; }

  if (row) { flashTopRow(row); return; }
  // Running out of pages means the whole ranking was walked, so searching
  // further is not on offer — the title is simply unscored and not ranked.
  showTopFind(picked, state.hasNext ? 'deeper' : 'unranked', state.rows.length);
}

// A toast was too easy to miss for something that needs a decision, so the
// dead end asks instead: give up, or spend another TOP_FIND_AHEAD pages.
let topFindMedia = null;
function showTopFind(media, reason, loaded) {
  topFindMedia = media;
  $('top-find-name').textContent = media ? getTitle(media) : '';
  $('top-find-text').textContent =
    reason === 'year' ? T.topFindOtherYear(media.seasonYear, topYear)
    : reason === 'unranked' ? T.topFindUnranked
    : T.topFindDeeper(loaded);
  const more = $('top-find-more');
  more.textContent = T.topFindMore(TOP_FIND_AHEAD);
  more.style.display = reason === 'deeper' ? '' : 'none';

  // The year it does belong to is the one useful thing known in that case, so
  // offer to go there rather than only naming it and leaving the work manual.
  const yr = $('top-find-year');
  const canYear = reason === 'year' && media && media.seasonYear;
  yr.textContent = canYear ? T.topFindGoToYear(media.seasonYear) : '';
  yr.style.display = canYear ? '' : 'none';

  // The info card is worth reaching whatever the reason was — often the point
  // of the search was the title itself, not its place in a ranking.
  const info = $('top-find-info');
  info.textContent = T.topFindInfo;
  info.style.display = media ? '' : 'none';

  $('top-find-modal').classList.add('open');
}

function closeTopFind() { $('top-find-modal').classList.remove('open'); }

// Switch the ranking to the year the title actually belongs to, then jump to it
// there. renderTop() must finish first or the jump searches an unpainted year.
async function topFindGoToYear() {
  const m = topFindMedia;
  closeTopFind();
  if (!m || !m.seasonYear) return;
  topYear = m.seasonYear;
  await renderTop();
  jumpToTop(m.id, m);
}

function topFindInfo() {
  const m = topFindMedia;
  closeTopFind();
  if (m) openInfoModal(m.id);
}

function topFindSearchMore() {
  const m = topFindMedia;
  closeTopFind();
  if (m) jumpToTop(m.id, m);
}

// ── TABS ──
function setTab(tab, btn) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  renderList();
}

function toggleGrouping(enabled) {
  groupingEnabled = enabled;
  $('toggle-group').classList.toggle('active', enabled);
  $('toggle-flat').classList.toggle('active', !enabled);
  renderList();
}

// ── MODAL ──
function openModal(entryJson) {
  const entry = typeof entryJson === 'string' ? JSON.parse(entryJson) : entryJson;
  editingEntry = entry;
  modalScore = entry.score || 0;
  modalStatus = entry.status;
  modalStatusTouched = false;

  $('modal-cover').src = entry.media.coverImage.large || entry.media.coverImage.medium;
  $('modal-title').textContent = getTitle(entry.media);
  $('modal-subtitle').textContent =
    (entry.media.season || '') + (entry.media.seasonYear ? ' ' + entry.media.seasonYear : '');
  $('modal-progress').value = entry.progress || 0;
  if (entry.media.episodes) $('modal-progress').max = entry.media.episodes;
  else $('modal-progress').removeAttribute('max');
  $('modal-total').textContent = entry.media.episodes || '?';
  $('modal-notes').value = entry.notes || '';

  const sr = $('score-row');
  sr.innerHTML = '';
  for (let i = 1; i <= 10; i++) {
    const btn = document.createElement('button');
    btn.className = 'score-btn' + (i === modalScore ? ' active' : '');
    btn.textContent = i;
    btn.onclick = () => { modalScore = i; sr.querySelectorAll('.score-btn').forEach((b,j)=>b.classList.toggle('active',j+1===i)); };
    sr.appendChild(btn);
  }

  document.querySelectorAll('.status-btn').forEach(b => {
    b.className = 'status-btn';
    if (b.dataset.status === modalStatus) b.classList.add('active-' + modalStatus);
  });

  $('edit-modal').classList.add('open');
}

function closeModal() {
  $('edit-modal').classList.remove('open');
  editingEntry = null;
}

function setModalStatus(s) {
  modalStatus = s;
  modalStatusTouched = true;
  document.querySelectorAll('.status-btn').forEach(b => {
    b.className = 'status-btn';
    if (b.dataset.status === s) b.classList.add('active-' + s);
  });
}

function clampProgress() {
  const inp = $('modal-progress');
  const total = editingEntry?.media?.episodes;
  const val = parseInt(inp.value);
  if (isNaN(val)) return;
  if (val < 0) inp.value = 0;
  else if (total && val > total) inp.value = total;
}

function adjustProgress(delta) {
  const inp = $('modal-progress');
  const val = parseInt(inp.value) || 0;
  const total = editingEntry?.media?.episodes || 99999;
  inp.value = Math.max(0, Math.min(total, val + delta));
}

async function saveEntry() {
  if (!editingEntry) return;
  const total = editingEntry.media.episodes || 0;
  const raw = parseInt($('modal-progress').value) || 0;
  const progress = total ? Math.max(0, Math.min(total, raw)) : Math.max(0, raw);
  const notes = $('modal-notes').value;
  const wasCompleted = editingEntry.status === 'COMPLETED';

  // Mirror quickPlus: watching an episode can start or finish a title. Only a
  // real increase counts, and an explicit pick in the status row always wins.
  let status = modalStatus;
  if (!modalStatusTouched && progress > (editingEntry.progress || 0) && ['PLANNING', 'PAUSED', 'DROPPED'].includes(status)) status = 'CURRENT';
  if (total && progress >= total && status === 'CURRENT') status = 'COMPLETED';
  const justCompleted = status === 'COMPLETED' && !wasCompleted;

  try {
    await updateEntry(editingEntry.id, status, modalScore, progress, notes);
    const idx = allEntries.findIndex(e => e.id === editingEntry.id);
    if (idx >= 0) {
      allEntries[idx].score = modalScore;
      allEntries[idx].status = status;
      allEntries[idx].progress = progress;
      allEntries[idx].notes = notes;
    }
    closeModal();
    renderList();
    showToast(justCompleted ? T.completed : T.saved);
    if (justCompleted && idx >= 0) maybeSuggestSequel(allEntries[idx]);
  } catch(e) {
    showToast(T.errPrefix + e.message);
  }
}

async function deleteEntry() {
  if (!editingEntry) return;
  const title = getTitle(editingEntry.media);
  if (!window.confirm(T.confirmDelete(title))) return;
  const id = editingEntry.id;
  try {
    await gql(`mutation($id: Int) { DeleteMediaListEntry(id: $id) { deleted } }`, { id });
    const idx = allEntries.findIndex(e => e.id === id);
    if (idx >= 0) allEntries.splice(idx, 1);
    closeModal();
    renderList();
    showToast(T.deleted);
  } catch(e) {
    showToast(T.errPrefix + e.message);
  }
}

// ── INFO MODAL ──
async function openInfoModal(mediaId) {
  const overlay = $('info-modal');
  const body = $('info-body');
  $('info-title').textContent = '—';
  $('info-original').textContent = '';
  $('info-romaji').textContent = '';
  $('info-subtitle').textContent = '';
  body.innerHTML = `<div class="loading"><div class="spinner"></div><div>${T.loading}</div></div>`;
  raiseModal(overlay);
  overlay.classList.add('open');

  try {
    let media = mediaCache[mediaId];
    if (!media || !media.studios) {
      const data = await gql(`
        query($id: Int) {
          Media(id: $id) {
            id
            idMal
            title { romaji english }
            coverImage { large medium extraLarge }
            trailer { id site thumbnail }
            format status
            startDate { year }
            averageScore genres
            description(asHtml: false)
            stats { scoreDistribution { score amount } }
            studios { edges { isMain node { id name } } }
            relations {
              edges {
                relationType(version: 2)
                node { id type title { romaji english } coverImage { medium } }
              }
            }
          }
        }
      `, { id: mediaId });
      media = data.Media;
      mediaCache[mediaId] = media;
    }
    renderInfoModal(media);
  } catch(e) {
    body.innerHTML = `<div class="empty-state"><div>${T.errPrefix}${e.message}</div></div>`;
  }
}

function scoreDistGraph(dist) {
  if (!dist || !dist.length) return '';
  const max = Math.max(...dist.map(d => d.amount));
  const bars = dist.map(d => {
    const h = max ? Math.round((d.amount / max) * 100) : 0;
    return `<div class="dist-bar-wrap" title="${d.score / 10}: ${d.amount}">
      <div class="dist-bar" style="height:${h}%"></div>
      <div class="dist-tick">${d.score / 10}</div>
    </div>`;
  }).join('');
  return `<div class="score-dist">${bars}</div>`;
}

function renderInfoModal(media) {
  // via getTitle so the header follows the Ukrainian name like every other
  // surface — it read the raw fields before, and so never localised at all.
  const title = getTitle(media);
  $('info-title').textContent = title;

  // English under the title, romaji under that — each shown only when it is not
  // already on screen, or an untranslated title prints its own name three times.
  const en = media.title.english || '';
  const ro = media.title.romaji || '';
  const second = en && en !== title ? en : (!en && ro !== title ? ro : '');
  $('info-original').textContent = second;
  $('info-romaji').textContent = ro && ro !== title && ro !== second ? ro : '';

  const year = media.startDate?.year || '';
  const fmt = T.format[media.format] || media.format || '';
  $('info-subtitle').textContent = [fmt, year].filter(Boolean).join(' · ');

  const listIds = new Set(allEntries.map(e => e.media.id));
  const animeRelations = (media.relations?.edges || []).filter(e => e.node.type === 'ANIME');
  const entry = allEntries.find(e => e.media.id === media.id);

  const genres = (media.genres || []).map(g => `<span class="genre-chip">${g}</span>`).join('');
  const statusBadge = media.status
    ? `<span class="status-badge status-${media.status}">${T.mediaStatus[media.status] || media.status}</span>`
    : '';

  const communityScoreHtml = media.averageScore
    ? `<span class="info-score"><span>★ ${(media.averageScore / 10).toFixed(1)}</span><span class="score-label">${T.communityScore}</span></span>`
    : '';
  const myScoreHtml = (entry && entry.score > 0)
    ? `<span class="info-score"><span>★ ${entry.score}</span><span class="score-label">${T.myScore}</span></span>`
    : '';

  // List controls: pick a status to add, or edit if already in the list.
  let controlsHtml;
  if (entry) {
    controlsHtml = `<div class="field-group">
      <div class="field-label">${T.inList}: ${T.status[entry.status] || entry.status}</div>
    </div>`;
  } else {
    const stBtns = Object.keys(T.status).map(s =>
      `<button class="status-btn" onclick="addFromInfo(${media.id}, '${s}')">${T.status[s]}</button>`
    ).join('');
    controlsHtml = `<div class="field-group">
      <div class="field-label">${T.addPrompt}</div>
      <div class="status-row">${stBtns}</div>
    </div>`;
  }
  // Let the browser pick: `large` is only 1x for the 220px desktop column.
  const cx = media.coverImage;
  const coverSrc = cx.large || cx.medium;
  const coverSet = [cx.large && `${cx.large} 230w`, cx.extraLarge && `${cx.extraLarge} 460w`].filter(Boolean).join(', ');

  // isMain separates the animation studio from producers and licensors, which
  // share the same connection and are not what "made by" means here.
  const studios = (media.studios?.edges || []).filter(e => e.isMain).map(e => e.node);
  const studioHtml = studios.length ? `<div class="field-group studio-group">
      <div class="field-label">${studios.length > 1 ? T.studios : T.studio}</div>
      <div class="studio-row">${studios.map(s => `
        <button class="studio-chip" data-sid="${s.id}" title="${esc(s.name)}" onclick="openStudioModal(${s.id})">
          <span class="studio-mono">${esc(studioMonogram(s.name))}</span>
          <span class="studio-name">${esc(s.name)}</span>
        </button>`).join('')}</div>
    </div>` : '';

  const anilistLink = `<a class="info-link" href="https://anilist.co/anime/${media.id}" target="_blank" rel="noopener">${T.anilistLink}</a>`;

  const notesHtml = entry?.notes?.trim()
    ? `<div class="field-group info-notes">
         <div class="field-label">${T.fldNotes}</div>
         <div class="info-notes-text">${esc(entry.notes.trim())}</div>
       </div>`
    : '';

  // AniList sometimes stores the id with trailing whitespace, which would
  // corrupt the thumbnail URL. Only YouTube is handled; Dailymotion is rare.
  // maxresdefault is missing for roughly half of older trailers, and YouTube
  // answers with a 120x90 grey placeholder rather than an error — so the
  // fallback has to test the decoded size, not wait for onerror.
  const tr = media.trailer;
  const vid = tr && tr.site === 'youtube' && tr.id ? tr.id.trim() : '';
  const trailerHtml = vid ? `
    <div class="trailer-section">
      <div class="field-label">${T.trailer}</div>
      <div class="trailer-card" onclick="playTrailer('${vid}', this)">
        <img src="https://i.ytimg.com/vi/${vid}/maxresdefault.jpg"
             onload="if (this.naturalWidth < 200) { this.onload = null; this.src = 'https://i.ytimg.com/vi/${vid}/hqdefault.jpg'; }"
             onerror="this.onerror=null; this.src='https://i.ytimg.com/vi/${vid}/hqdefault.jpg'"
             class="trailer-thumb" loading="lazy" alt="">
        <div class="trailer-veil"></div>
        <div class="trailer-play"></div>
        <div class="trailer-label">
          <span>${T.trailerOfficial}</span>
          <a href="https://www.youtube.com/watch?v=${vid}&t=0" target="_blank" rel="noopener"
             onclick="event.stopPropagation()">${T.trailerYouTube}</a>
        </div>
      </div>
    </div>` : '';

  const descId = 'info-desc-' + media.id;
  const descHtml = media.description
    ? `<div class="info-desc" id="${descId}">${media.description}</div>
       <button class="info-desc-toggle" onclick="toggleInfoDesc('${descId}', this)">${T.showMore}</button>`
    : '';

  let relatedHtml = '';
  if (animeRelations.length) {
    const items = animeRelations.map(edge => {
      const rMedia = edge.node;
      const rTitle = rMedia.title.english || rMedia.title.romaji;
      const inList = listIds.has(rMedia.id);
      const badge = inList ? `<span class="related-in-list-badge">${T.inList}</span>` : '';
      return `
        <div class="related-item" style="cursor:pointer" onclick="openInfoModal(${rMedia.id})">
          <img src="${rMedia.coverImage.medium}" class="related-thumb" loading="lazy">
          <div class="related-info">
            <div class="related-name">${rTitle}</div>
            <div class="related-type-label">${T.relation[edge.relationType] || edge.relationType}</div>
          </div>
          ${badge}
        </div>`;
    }).join('');
    relatedHtml = `<div class="related-section">
      <div class="related-title">${T.related}</div>
      ${items}
    </div>`;
  }

  $('info-body').innerHTML = `
    <div class="info-col-left">
      <img src="${coverSrc}" srcset="${coverSet}" sizes="(min-width: 650px) 220px, 130px" class="info-cover-lg" loading="lazy">
      ${anilistLink}
      ${notesHtml}
    </div>
    <div class="info-col-right">
      <div class="info-meta-row">
        ${statusBadge}
        ${communityScoreHtml}
        ${myScoreHtml}
        ${genres}
      </div>
      ${scoreDistGraph(media.stats?.scoreDistribution)}
      ${studioHtml}
      ${controlsHtml}
      ${descHtml}
      ${relatedHtml}
      ${trailerHtml}
    </div>
  `;

  studios.forEach(s => hydrateStudioLogo($('info-body').querySelector(`.studio-chip[data-sid="${s.id}"]`), s));

  // Editing is only offered for titles already on the list.
  const editBtn = $('info-edit-btn');
  editBtn.style.display = entry ? '' : 'none';
  editBtn.onclick = entry
    ? () => { closeInfoModal(); openModal(allEntries.find(e => e.media.id === media.id)); }
    : null;

  // Only repaint if the panel is still showing this title — the trailer is torn
  // down on close, and rebuilding it under a closed modal would resurrect it.
  resolveUk([media], () => {
    if ($('info-modal').classList.contains('open')) renderInfoModal(media);
  });
}

// controls=0 keeps YouTube's chrome out of the card; a click still pauses.
// playsinline stops iOS hijacking into its own fullscreen player.
function playTrailer(vid, card) {
  if (card.querySelector('iframe')) return;
  // controls=0 takes YouTube's fullscreen button with it, so supply our own.
  // Hidden where the API isn't available — iOS Safari won't fullscreen an iframe.
  if (document.fullscreenEnabled) {
    card.insertAdjacentHTML('beforeend',
      `<button class="trailer-fs" title="${T.trailerFullscreen}" aria-label="${T.trailerFullscreen}"
         onclick="event.stopPropagation(); fullscreenTrailer(this)">
         <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
              stroke-width="2.2" stroke-linecap="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>
       </button>`);
    peekFs(card);
  }
  // Laid over the thumbnail rather than replacing it, so stopping is a plain
  // removal and the card is back to its poster with nothing to rebuild.
  card.insertAdjacentHTML('beforeend',
    `<iframe src="https://www.youtube-nocookie.com/embed/${vid}?autoplay=1&playsinline=1&controls=0&rel=0&iv_load_policy=3"
      allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe>`);
}

// Removing the iframe is what actually stops playback — hiding the overlay
// leaves the video running with its audio.
let fsPeekTimer = null;
function peekFs(card) {
  card.classList.add('fs-peek');
  clearTimeout(fsPeekTimer);
  fsPeekTimer = setTimeout(() => card.classList.remove('fs-peek'), 2800);
}

function fullscreenTrailer(btn) {
  const f = btn.parentElement.querySelector('iframe');
  if (!f) return;
  (f.requestFullscreen || f.webkitRequestFullscreen || f.webkitEnterFullscreen)?.call(f);
}

function stopTrailer() {
  const card = $('info-body').querySelector('.trailer-card');
  if (!card) return;
  card.querySelector('iframe')?.remove();
  card.querySelector('.trailer-fs')?.remove();
  card.classList.remove('fs-peek');
  clearTimeout(fsPeekTimer);
}

function closeInfoModal() {
  stopTrailer();
  $('info-modal').classList.remove('open');
}

function toggleInfoDesc(id, btn) {
  const el = $(id);
  el.classList.toggle('expanded');
  btn.textContent = el.classList.contains('expanded') ? T.showLess : T.showMore;
}

// ── STUDIO ──
// AniList has no studio artwork of any kind — no logo, no image field anywhere
// on the type — so logos come from Wikidata's P154, falling back to Wikipedia's
// lead image. Key-free, and the answer — a miss included — is kept in
// localStorage, so any given studio is looked up exactly once ever.
function studioMonogram(name) {
  const w = name.split(/[\s.·]+/).filter(Boolean);
  // One word gives one initial, which reads as nothing — MAPPA deserves "MA".
  return (w.length > 1 ? w[0][0] + w[1][0] : (w[0] || '?').slice(0, 2)).toUpperCase();
}

const LOGO_CACHE_KEY = 'necotrack_studio_logos';
let studioLogoCache = {};
try {
  const saved = JSON.parse(localStorage.getItem(LOGO_CACHE_KEY)) || {};
  // Entries written in an earlier shape are dropped rather than migrated.
  for (const [id, file] of Object.entries(saved)) {
    if (typeof file === 'string') studioLogoCache[id] = file;
  }
} catch(e) {}

const WD_API = 'https://www.wikidata.org/w/api.php?format=json&origin=*&';
const WP_API = 'https://en.wikipedia.org/w/api.php?format=json&origin=*&';
const wikiJson = url => fetch(url).then(r => r.json());
const commonsUrl = file =>
  `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}?width=240`;

// A studio name is rarely unique and the studio rarely ranks first: searching
// "OLM" puts the Czech city Olomouc on top, "Bones" a bone, "Madhouse" a
// psychiatric hospital — and the city has a logo, so taking the first hit with
// one put Olomouc's crest on an anime. Matching the description is the fix.
const STUDIO_DESC = /anim|studio|production|entertainment|media/i;
// Those words also describe works: "Passione" is an anime studio, a Bocelli
// album and two films, and "studio album" matches on `studio`. Dropping works
// outright stops one of them lending its cover art to a studio.
const NOT_STUDIO = /album|song|single|film directed|documentary|novel|manga|video game|magazine|given name|family name/i;

async function fetchWikidataLogo(name) {
  const found = await wikiJson(WD_API + 'action=wbsearchentities&language=en&limit=7&search=' + encodeURIComponent(name));
  const rank = c => /anim/i.test(c.description || '') ? 0 : 1;   // "Japanese animation studio" first
  const candidates = (found.search || [])
    .filter(c => STUDIO_DESC.test(c.description || '') && !NOT_STUDIO.test(c.description || ''))
    .sort((a, b) => rank(a) - rank(b));
  for (const cand of candidates) {
    const claims = await wikiJson(WD_API + 'action=wbgetclaims&property=P154&entity=' + cand.id);
    const file = claims.claims?.P154?.[0]?.mainsnak?.datavalue?.value;
    if (file) return commonsUrl(file);
  }
  return '';
}

// Wikidata holds no logo for a good number of studios, so English Wikipedia is
// asked next. Its search is fuzzy enough to answer "PIERROT FILMS" with Studio
// Pierrot, so whatever page it lands on has to be about the studio asked for.
const wpTitleMatches = (asked, got) => {
  const norm = t => t.toLowerCase().replace(/[^a-z0-9]/g, '');
  const [a, b] = [norm(asked), norm(got)];
  return !!a && !!b && (b.includes(a) || a.includes(b));
};

async function findWikipediaArticle(name) {
  const res = await wikiJson(WP_API + 'action=query&list=search&srlimit=1&srsearch=' +
    encodeURIComponent(name + ' anime studio'));
  const title = res.query?.search?.[0]?.title;
  return title && wpTitleMatches(name, title) ? title : '';
}

// The infobox names its logo outright, which beats every guess from a file
// name: it finds Studio Pierrot's StudioPierrot2025.jpg and Tatsunoko's
// TatsunokoPro2014.svg, neither of which says "logo" anywhere. Fair-use logos
// live on en.wikipedia rather than Commons, so the URL is built there.
async function fetchInfoboxLogo(title) {
  const res = await wikiJson(WP_API + 'action=parse&prop=wikitext&section=0&page=' + encodeURIComponent(title));
  const wikitext = res.parse?.wikitext?.['*'] || '';
  // Anchored to `| logo =` so logo_size and logo_caption don't match.
  const found = wikitext.match(/^\s*\|\s*logo\s*=\s*(?:\[\[)?(?:File:|Image:)?\s*([^\n|\]}]+?)\s*$/im);
  return found ? `https://en.wikipedia.org/wiki/Special:FilePath/${encodeURIComponent(found[1])}?width=240` : '';
}

// Last resort for a page with no infobox logo, like Manglobe's. The lead image
// is as often a photo of the head office — on Bibury's page it is a photo of
// *Gainax's* office — so it is taken only when the file name says logo.
async function fetchLeadImageLogo(title) {
  const res = await wikiJson(WP_API + 'action=query&prop=pageimages&piprop=original&titles=' + encodeURIComponent(title));
  const src = Object.values(res.query?.pages || {})[0]?.original?.source;
  if (!src) return '';
  return /logo/i.test(decodeURIComponent(src.split('/').pop())) ? src : '';
}

async function fetchStudioLogo(name) {
  const fromWikidata = await fetchWikidataLogo(name);
  if (fromWikidata) return fromWikidata;
  const title = await findWikipediaArticle(name);
  if (!title) return '';
  return (await fetchInfoboxLogo(title)) || (await fetchLeadImageLogo(title));
  // '' is cached as a miss, so a studio without one is never asked twice
}

// Nothing waits on Wikidata: the monogram is already on screen and the logo
// swaps in behind it, so a slow or failed lookup just leaves the monogram.
async function hydrateStudioLogo(host, studio) {
  if (!host) return;
  // studio-logos.js stays supported as an override and wins over the lookup.
  const override = typeof STUDIO_LOGOS !== 'undefined' ? STUDIO_LOGOS[studio.id] : undefined;
  let file = override !== undefined ? override : studioLogoCache[studio.id];
  if (file === undefined) {
    try { file = await fetchStudioLogo(studio.name); } catch(e) { return; }
    studioLogoCache[studio.id] = file;
    try { localStorage.setItem(LOGO_CACHE_KEY, JSON.stringify(studioLogoCache)); } catch(e) {}
  }
  if (!file || !host.isConnected) return;

  const img = new Image();
  img.className = 'studio-logo-img';
  img.alt = studio.name;
  // Only shown once it has actually decoded — a broken file leaves the monogram
  // rather than a gap where a logo should be.
  img.onload = () => {
    if (!host.isConnected) return;
    host.appendChild(img);
    host.classList.add('has-logo');
  };
  img.src = file;
}

// Info → studio → info can nest, so the newest overlay is bumped on top and
// closing it uncovers the one it was opened from. Reset while none are open
// keeps the counter from ever climbing past the toast.
let modalZ = 200;
function raiseModal(el) {
  if (!document.querySelector('.modal-overlay.open')) modalZ = 200;
  el.style.zIndex = ++modalZ;
}

const STUDIO_PER_PAGE = 25;  // the connection's own cap; asking for more silently returns 25
let studioState = { id: 0, name: '', page: 0, hasNext: false, items: [], loading: false };

async function openStudioModal(studioId) {
  const overlay = $('studio-modal');
  studioState = { id: studioId, name: '', page: 0, hasNext: false, items: [], loading: false };
  $('studio-title').textContent = '—';
  $('studio-subtitle').textContent = '';
  $('studio-logo').className = 'studio-logo-wrap';
  $('studio-logo').innerHTML = '';
  $('studio-body').innerHTML = `<div class="loading"><div class="spinner"></div><div>${T.loading}</div></div>`;
  raiseModal(overlay);
  overlay.classList.add('open');
  await loadStudioPage();
}

async function loadStudioPage() {
  if (studioState.loading || !studioState.id) return;
  studioState.loading = true;
  const moreBtn = $('studio-more');
  if (moreBtn) { moreBtn.textContent = T.topSearching; moreBtn.disabled = true; }
  try {
    const data = await gql(`
      query($id: Int, $page: Int, $perPage: Int) {
        Studio(id: $id) {
          id name siteUrl
          media(sort: [START_DATE_DESC], isMain: true, page: $page, perPage: $perPage) {
            pageInfo { hasNextPage }
            nodes {
              id
              title { romaji english native }
              coverImage { large medium }
              format status averageScore
              startDate { year month day }
            }
          }
        }
      }
    `, { id: studioState.id, page: studioState.page + 1, perPage: STUDIO_PER_PAGE });

    const st = data.Studio;
    studioState.name = st.name;
    studioState.page++;
    studioState.hasNext = !!st.media.pageInfo.hasNextPage;
    studioState.items.push(...st.media.nodes);
    $('studio-link').href = st.siteUrl || `https://anilist.co/studio/${st.id}`;
    renderStudioModal();
  } catch(e) {
    $('studio-body').innerHTML = `<div class="empty-state"><div>${T.errPrefix}${esc(e.message)}</div></div>`;
  } finally {
    studioState.loading = false;
  }
}

function renderStudioModal() {
  const st = studioState;
  $('studio-title').textContent = st.name;
  const logoHost = $('studio-logo');
  logoHost.className = 'studio-logo-wrap';
  logoHost.title = st.name;
  logoHost.innerHTML = `<span class="studio-mono is-lg">${esc(studioMonogram(st.name))}</span>`;
  hydrateStudioLogo(logoHost, { id: st.id, name: st.name });

  // pageInfo.total lies on this connection the same way it does on Page —
  // it answered 500, then 475, and page 20 of a claimed lastPage 20 was empty.
  // Only hasNextPage is trustworthy, so the count shown is what actually loaded.
  const shown = st.items.length;
  $('studio-subtitle').textContent = `${T.studioWorks} · ${T.studioCount(shown)}`;

  if (!shown) {
    $('studio-body').innerHTML = `<div class="empty-state"><div>${T.studioNone}</div></div>`;
    return;
  }

  const listIds = new Set(allEntries.map(e => e.media.id));
  const cards = st.items.map(m => {
    const meta = [T.format[m.format] || m.format, m.startDate?.year].filter(Boolean).join(' · ');
    const score = m.averageScore
      ? `<span class="studio-card-score">★ ${(m.averageScore / 10).toFixed(1)}</span>` : '';
    const badge = listIds.has(m.id)
      ? `<span class="studio-card-badge">${T.inList}</span>` : '';
    return `<div class="studio-card" onclick="openInfoModal(${m.id})">
      <div class="studio-card-art">
        <img src="${m.coverImage.large || m.coverImage.medium}" class="studio-card-cover" loading="lazy" alt="">
        ${unairedBadge(m)}${unairedDate(m)}
        ${badge}${score}
      </div>
      <div class="studio-card-name">${esc(getTitle(m))}</div>
      <div class="studio-card-meta">${meta}</div>
    </div>`;
  }).join('');

  const more = st.hasNext
    ? `<button class="btn-cancel studio-more" id="studio-more" onclick="loadStudioPage()">${T.topMore}</button>`
    : '';
  $('studio-body').innerHTML = `<div class="studio-grid">${cards}</div>${more}`;
}

function closeStudioModal() {
  $('studio-modal').classList.remove('open');
}

// ── SEQUEL SUGGESTION ──
// Fired right after an entry becomes COMPLETED: offer its direct sequels for Planning.
// The list query only carries relation ids, so titles/covers need one extra fetch.
async function maybeSuggestSequel(entry) {
  const listIds = new Set(allEntries.map(e => e.media.id));
  const ids = (entry.media.relations?.edges || [])
    .filter(e => e.relationType === 'SEQUEL' && e.node.type === 'ANIME' && !listIds.has(e.node.id))
    .map(e => e.node.id);
  if (!ids.length) return;
  try {
    const data = await gql(`
      query($ids: [Int]) {
        Page(perPage: 10) {
          media(id_in: $ids, type: ANIME) {
            id idMal title { romaji english } coverImage { medium large }
            format episodes status startDate { year month day }
          }
        }
      }
    `, { ids });
    const found = data.Page?.media || [];
    if (found.length) renderSequelModal(getTitle(entry.media), found);
  } catch(e) {
    // A failed suggestion must not stack an error toast on top of "Completed!".
  }
}

function renderSequelModal(sourceTitle, list) {
  $('sequel-subtitle').textContent = T.sequelDesc(sourceTitle);
  const single = list.length === 1;
  const noBtn = `<button class="btn-sequel-no" onclick="closeSequelModal()">${T.sequelNo}</button>`;
  const cards = list.map(m => {
    // An unaired sequel wears its status on the poster instead of the meta line.
    const unreleased = isUnaired(m);
    const meta = [
      T.format[m.format] || m.format,
      unreleased ? '' : (T.mediaStatus[m.status] || m.status),
      m.startDate?.year,
      m.episodes ? m.episodes + ' ' + T.epShort : ''
    ].filter(Boolean).join(' · ');
    return `
      <div class="sequel-card">
        <div class="sequel-card-main">
          <div class="sequel-cover-link" onclick="openInfoModal(${m.id})">
            <img src="${m.coverImage.large || m.coverImage.medium}" class="sequel-cover" loading="lazy">
            ${unairedBadge(m)}${unairedDate(m)}
          </div>
          <div class="sequel-body">
            <div class="sequel-text">
              <div class="sequel-name">${getTitle(m)}</div>
              <div class="sequel-meta">${meta}</div>
            </div>
            <div class="sequel-actions">
              <button class="btn-sequel-add" onclick="addSequel(${m.id}, this)">${T.sequelAdd}</button>
              ${single ? noBtn : ''}
            </div>
          </div>
        </div>
        <button class="info-link" onclick="openInfoModal(${m.id})">${T.sequelInfo}</button>
      </div>`;
  });
  $('sequel-body').innerHTML =
    `<div class="sequel-cards">${cards.join(`<div class="sequel-and">${T.sequelAnd}</div>`)}</div>` +
    (single ? '' : `<div class="sequel-actions sequel-actions-global">${noBtn}</div>`);
  $('sequel-modal').querySelector('.modal').classList.toggle('multi', !single);
  $('sequel-modal').classList.add('open');
}

async function addSequel(mediaId, btn) {
  btn.textContent = '…';
  btn.disabled = true;
  try {
    await addEntry(mediaId, 'PLANNING');
    btn.textContent = T.sequelAdded;
    btn.classList.add('in-list');
    showToast(T.added);
    // Nothing left to offer once every suggestion has been taken.
    if (!$('sequel-body').querySelector('.btn-sequel-add:not(.in-list)')) closeSequelModal();
  } catch(e) {
    btn.textContent = T.sequelAdd;
    btn.disabled = false;
    showToast(T.errPrefix + e.message);
  }
}

function closeSequelModal() {
  $('sequel-modal').classList.remove('open');
}

// ── INIT ──
async function initApp() {
  $('auth-screen').style.display = 'none';
  $('app').style.display = 'flex';
  $('app').style.flexDirection = 'column';
  $('list-container').innerHTML = `<div class="loading"><div class="spinner"></div><div>${T.loading}</div></div>`;

  try {
    currentUser = await fetchUser();
    $('user-name').textContent = currentUser.name;
    if (currentUser.avatar?.medium) {
      $('user-avatar').src = currentUser.avatar.medium;
    }
    await loadList();
  } catch(e) {
    $('list-container').innerHTML = `<div class="empty-state"><div class="icon">⚠️</div><div>${T.errPrefix}${e.message}</div></div>`;
  }
}

async function loadList() {
  $('list-container').innerHTML = `<div class="loading"><div class="spinner"></div><div>${T.loading}</div></div>`;
  try {
    allEntries = await fetchList(currentUser.id);
    renderList();
  } catch(e) {
    $('list-container').innerHTML = `<div class="empty-state"><div class="icon">⚠️</div><div>${T.loadFailed}${e.message}</div></div>`;
  }
}

// ── TOAST ──
let toastTimer;
function showToast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2500);
}

// ── STARTUP ──
(function() {
  applyI18n();
  const hashToken = parseTokenFromHash();
  if (hashToken) {
    token = hashToken;
    localStorage.setItem('al_token', hashToken);
    window.history.replaceState({}, '', window.location.pathname);
    initApp();
    return;
  }
  const saved = localStorage.getItem('al_token');
  if (saved) {
    token = saved;
    initApp();
    return;
  }
  $('auth-screen').style.display = 'flex';
})();

// ── PWA ──
(function() {
  const manifest = {
    name: 'NecoTrack', short_name: 'NecoTrack',
    start_url: window.location.pathname,
    display: 'standalone',
    background_color: '#0f0f11', theme_color: '#17171c',
    // 'portrait' locks an installed PWA to portrait at the OS level, which also
    // trapped fullscreen video. The layout is responsive, so let the device decide.
    orientation: 'any',
    icons: [
      { src: 'logo.png', sizes: '192x192', type: 'image/png' },
      { src: 'logo.png', sizes: '512x512', type: 'image/png' }
    ]
  };
  const blob = new Blob([JSON.stringify(manifest)], { type: 'application/manifest+json' });
  $('manifest-link').href = URL.createObjectURL(blob);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then(regs => { for (const r of regs) r.unregister(); });
  }
})();

// ── SWIPE BETWEEN TABS ──
(function() {
  const TAB_ORDER = ['CURRENT','ALL','COMPLETED','PLANNING','PAUSED','DROPPED'];
  let touchStartX = 0, touchStartY = 0, touchStartTime = 0;
  const SWIPE_MIN_X = 50;   // px horizontal
  const SWIPE_MAX_Y = 80;   // px vertical — prevent scroll-swipes
  const SWIPE_MAX_MS = 400; // ms

  document.addEventListener('touchstart', e => {
    // ignore if touch starts inside modal or scrollable catalog
    if (e.target.closest('#edit-modal') || e.target.closest('#info-modal') || e.target.closest('#sequel-modal') || e.target.closest('.catalog-dropdown') || e.target.closest('.tabs-wrap')) return;
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    touchStartTime = Date.now();
  }, { passive: true });

  document.addEventListener('touchend', e => {
    if (!touchStartTime) return;
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;
    const dt = Date.now() - touchStartTime;
    touchStartTime = 0;

    if (Math.abs(dx) < SWIPE_MIN_X) return;
    if (Math.abs(dy) > SWIPE_MAX_Y) return;
    if (dt > SWIPE_MAX_MS) return;

    const idx = TAB_ORDER.indexOf(currentTab);
    if (idx === -1) return;   // Top isn't a slice of the list; leave it out of swipes
    let nextIdx;
    if (dx < 0) nextIdx = Math.min(idx + 1, TAB_ORDER.length - 1); // swipe left → next
    else         nextIdx = Math.max(idx - 1, 0);                    // swipe right → prev
    if (nextIdx === idx) return;

    const nextTab = TAB_ORDER[nextIdx];
    const btn = document.querySelector(`.tab[data-tab="${nextTab}"]`);
    if (btn) {
      setTab(nextTab, btn);
      // scroll tab into view
      btn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
  }, { passive: true });
})();

// ── DISMISS ON OUTSIDE CLICK ──
$('edit-modal').addEventListener('click', e => { if (e.target === e.currentTarget) closeModal(); });
$('info-modal').addEventListener('click', e => { if (e.target === e.currentTarget) closeInfoModal(); });
$('sequel-modal').addEventListener('click', e => { if (e.target === e.currentTarget) closeSequelModal(); });
$('top-find-modal').addEventListener('click', e => { if (e.target === e.currentTarget) closeTopFind(); });
$('studio-modal').addEventListener('click', e => { if (e.target === e.currentTarget) closeStudioModal(); });

// A horizontal strip doesn't take the vertical wheel, so map it across.
$('top-years').addEventListener('scroll', syncYearArrows, { passive: true });
$('top-years').addEventListener('wheel', e => {
  const el = $('top-years');
  const d = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
  const max = el.scrollWidth - el.clientWidth;
  if (!d || max <= 0) return;
  const next = Math.max(0, Math.min(max, el.scrollLeft + d));
  if (next !== el.scrollLeft) { e.preventDefault(); el.scrollLeft = next; }
}, { passive: false });
document.addEventListener('click', e => {
  if (!e.target.closest('.search-wrap')) $('catalog-results').style.display = 'none';
});
