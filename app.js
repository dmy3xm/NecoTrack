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
function getTitle(media) {
  return media.title.english || media.title.romaji;
}

function getSeriesTitle(group) {
  const main = group.find(e => MAIN_FORMATS.includes(e.media.format)) || group[0];
  const t = getTitle(main.media);
  return t.replace(/\s+(Season\s+\d+|S\d+|\d+(st|nd|rd|th)\s+Season)$/i,'').trim() || t;
}

function normalize(s) {
  return s.toLowerCase().replace(/[^\w\s]/g,'').replace(/\s+/g,' ').trim();
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
  drop.innerHTML = `<div class="catalog-loading">${T.searching}</div>`;
  try {
    const data = await gql(`
      query($search: String) {
        Page(perPage: 8) {
          media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
            id
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
    paintCatalog();
  } catch(e) {
    drop.innerHTML = `<div class="catalog-loading">${T.errPrefix}${e.message}</div>`;
  }
}

// Split from the fetch so that changing the year on Top can re-mark the
// wrong-year rows from the results already in hand, without a second request.
function paintCatalog() {
  const drop = $('catalog-results');
  const results = lastCatalogResults;
  if (!results.length) { drop.innerHTML = `<div class="catalog-loading">${T.nothingFound}</div>`; return; }
  const listIds = new Set(allEntries.map(e => e.media.id));
  const onTop = currentTab === 'TOP';
  const year = onTop && topYear !== 'all' ? Number(topYear) : null;
  let html = `<div class="search-mode-hint"><span>${T.catalogResults}</span><button onclick="closeCatalog()">✕</button></div>`;
  for (const m of results) {
    const title = m.title.english || m.title.romaji;
    const inList = listIds.has(m.id);
    const meta = [m.format, m.episodes ? m.episodes+' '+T.epShort : null, m.seasonYear].filter(Boolean).join(' · ');
    html += `
      <div class="catalog-item" style="cursor:pointer" onclick="${onTop ? `jumpToTop(${m.id})` : `openInfoModal(${m.id})`}">
        <img src="${m.coverImage.medium}" class="catalog-cover" loading="lazy">
        <div class="catalog-info">
          <div class="catalog-title">${title}</div>
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
          id title { romaji english } coverImage { medium large }
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
    filtered = filtered.filter(e => fuzzyMatch(search, getTitle(e.media)) || fuzzyMatch(search, e.media.title.romaji || ''));
  }

  renderStats(filtered);

  if (filtered.length === 0) {
    container.innerHTML = `<div class="empty-state"><img src="empty.png" class="empty-img" alt="${T.emptyAlt}"><div>${T.empty}</div></div>`;
    return;
  }

  if (groupingEnabled) renderGrouped(filtered, sort, container);
  else renderFlat(filtered, sort, container);
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
          ${entry.notes ? `<span style="font-size:11px;color:var(--text-muted)" title="${entry.notes}">📝</span>` : ''}
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
          id title { romaji english } coverImage { medium large }
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
  const rows = state.rows.map((m, i) => `
    <div class="top-row" data-id="${m.id}" onclick="openInfoModal(${m.id})">
      <div class="top-rank${i < 3 ? ' top3' : ''}">${i + 1}</div>
      <img src="${m.coverImage.medium}" class="top-cover" loading="lazy">
      <div class="top-info">
        <div class="top-title">${getTitle(m)}</div>
        <div class="top-meta">${[T.format[m.format] || m.format, m.seasonYear, m.episodes ? m.episodes + ' ' + T.epShort : ''].filter(Boolean).join(' · ')}</div>
      </div>
      <div class="top-score">★ ${(m.averageScore / 10).toFixed(1)}</div>
    </div>`).join('');
  const more = state.hasNext
    ? `<button class="top-more" onclick="loadMoreTop()">${T.topMore}</button>` : '';
  $('list-container').innerHTML = `<div class="top-list">${rows}${more}</div>`;
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
function scrollYears(dir) {
  const el = $('top-years');
  // The desktop strip is deliberately narrow, so a 90%-of-width step would be
  // only a few years per click across ~87 of them. Keep a sane floor.
  const step = Math.max(el.clientWidth * 0.9, 400);
  el.scrollBy({ left: dir * step, behavior: 'smooth' });
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
  $('top-find-modal').classList.add('open');
}

function closeTopFind() { $('top-find-modal').classList.remove('open'); }

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
  $('info-subtitle').textContent = '';
  body.innerHTML = `<div class="loading"><div class="spinner"></div><div>${T.loading}</div></div>`;
  overlay.classList.add('open');

  try {
    let media = mediaCache[mediaId];
    if (!media || !media.stats) {
      const data = await gql(`
        query($id: Int) {
          Media(id: $id) {
            id
            title { romaji english }
            coverImage { large medium extraLarge }
            trailer { id site thumbnail }
            format status
            startDate { year }
            averageScore genres
            description(asHtml: false)
            stats { scoreDistribution { score amount } }
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
  const title = media.title.english || media.title.romaji;
  $('info-title').textContent = title;

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

  const anilistLink = `<a class="info-link" href="https://anilist.co/anime/${media.id}" target="_blank" rel="noopener">${T.anilistLink}</a>`;

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
    </div>
    <div class="info-col-right">
      <div class="info-meta-row">
        ${statusBadge}
        ${communityScoreHtml}
        ${myScoreHtml}
        ${genres}
      </div>
      ${scoreDistGraph(media.stats?.scoreDistribution)}
      ${controlsHtml}
      ${descHtml}
      ${relatedHtml}
      ${trailerHtml}
    </div>
  `;

  // Editing is only offered for titles already on the list.
  const editBtn = $('info-edit-btn');
  editBtn.style.display = entry ? '' : 'none';
  editBtn.onclick = entry
    ? () => { closeInfoModal(); openModal(allEntries.find(e => e.media.id === media.id)); }
    : null;
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
            id title { romaji english } coverImage { medium large }
            format episodes status startDate { year }
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
    const unreleased = m.status === 'NOT_YET_RELEASED';
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
            ${unreleased ? `<div class="sequel-cover-badge">${T.mediaStatus[m.status]}</div>` : ''}
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
