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
let mediaCache = {};

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
      if (['SEQUEL','PREQUEL'].includes(edge.relationType) && edge.node.type === 'ANIME') {
        if (byId[edge.node.id]) union(id, edge.node.id);
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
  const t = getTitle(group[0].media);
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

function onSearchInput(val) {
  renderList();
  const v = val.trim();
  if (v.length < 2) { closeCatalog(); return; }
  clearTimeout(catalogTimer);
  catalogTimer = setTimeout(() => searchCatalog(v), 400);
}

async function searchCatalog(query) {
  if (query === lastCatalogQuery) return;
  lastCatalogQuery = query;
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
    const results = data.Page.media;
    if (!results.length) { drop.innerHTML = `<div class="catalog-loading">${T.nothingFound}</div>`; return; }
    const listIds = new Set(allEntries.map(e => e.media.id));
    let html = `<div class="search-mode-hint"><span>${T.catalogResults}</span><button onclick="closeCatalog()">✕</button></div>`;
    for (const m of results) {
      const title = m.title.english || m.title.romaji;
      const inList = listIds.has(m.id);
      const meta = [m.format, m.episodes ? m.episodes+' '+T.epShort : null, m.seasonYear].filter(Boolean).join(' · ');
      html += `
        <div class="catalog-item" style="cursor:pointer" onclick="openInfoModal(${m.id})">
          <img src="${m.coverImage.medium}" class="catalog-cover" loading="lazy">
          <div class="catalog-info">
            <div class="catalog-title">${title}</div>
            <div class="catalog-meta">${meta}</div>
          </div>
          <span onclick="event.stopPropagation()">${inList
            ? `<span class="catalog-add in-list">${T.catalogInList}</span>`
            : `<button class="catalog-add" onclick="addToList(${m.id}, event)">${T.catalogAdd}</button>`
          }</span>
        </div>
      `;
    }
    drop.innerHTML = html;
  } catch(e) {
    drop.innerHTML = `<div class="catalog-loading">${T.errPrefix}${e.message}</div>`;
  }
}

function closeCatalog() {
  lastCatalogQuery = '';
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
          episodes season seasonYear
          relations { edges { relationType(version: 2) node { id type } } }
        }
      }
    }
  `, { mediaId, status });
  const entry = data.SaveMediaListEntry;
  allEntries.push(entry);
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
    await updateEntry(entry.id, entry.status, entry.score, newProg, entry.notes);
    entry.progress = newProg;
    if (entry.media.episodes && newProg >= entry.media.episodes && entry.status === 'CURRENT') {
      entry.status = 'COMPLETED';
      await updateEntry(entry.id, 'COMPLETED', entry.score, newProg, entry.notes);
      showToast(T.completed);
    } else {
      showToast(T.toastProgress(newProg, entry.media.episodes));
    }
    renderList();
  } catch(e) {
    showToast(T.errPrefix + e.message);
  }
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

  $('modal-cover').src = entry.media.coverImage.large || entry.media.coverImage.medium;
  $('modal-title').textContent = getTitle(entry.media);
  $('modal-subtitle').textContent =
    (entry.media.season || '') + (entry.media.seasonYear ? ' ' + entry.media.seasonYear : '');
  $('modal-progress').value = entry.progress || 0;
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
  document.querySelectorAll('.status-btn').forEach(b => {
    b.className = 'status-btn';
    if (b.dataset.status === s) b.classList.add('active-' + s);
  });
}

function adjustProgress(delta) {
  const inp = $('modal-progress');
  const val = parseInt(inp.value) || 0;
  const total = editingEntry?.media?.episodes || 99999;
  inp.value = Math.max(0, Math.min(total, val + delta));
}

async function saveEntry() {
  if (!editingEntry) return;
  const progress = parseInt($('modal-progress').value) || 0;
  const notes = $('modal-notes').value;
  try {
    await updateEntry(editingEntry.id, modalStatus, modalScore, progress, notes);
    const idx = allEntries.findIndex(e => e.id === editingEntry.id);
    if (idx >= 0) {
      allEntries[idx].score = modalScore;
      allEntries[idx].status = modalStatus;
      allEntries[idx].progress = progress;
      allEntries[idx].notes = notes;
    }
    closeModal();
    renderList();
    showToast(T.saved);
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
    if (!media) {
      const data = await gql(`
        query($id: Int) {
          Media(id: $id) {
            id
            title { romaji english }
            coverImage { large medium }
            format status
            startDate { year }
            averageScore genres
            description(asHtml: false)
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

function renderInfoModal(media) {
  const title = media.title.english || media.title.romaji;
  $('info-title').textContent = title;

  const year = media.startDate?.year || '';
  const fmt = T.format[media.format] || media.format || '';
  $('info-subtitle').textContent = [fmt, year].filter(Boolean).join(' · ');

  const listIds = new Set(allEntries.map(e => e.media.id));
  const animeRelations = (media.relations?.edges || []).filter(e => e.node.type === 'ANIME');

  const genres = (media.genres || []).map(g => `<span class="genre-chip">${g}</span>`).join('');
  const scoreStr = media.averageScore ? `★ ${(media.averageScore / 10).toFixed(1)}` : '—';
  const statusBadge = media.status
    ? `<span class="status-badge status-${media.status}">${T.mediaStatus[media.status] || media.status}</span>`
    : '';

  // List controls: pick a status to add, or edit if already in the list.
  const entry = allEntries.find(e => e.media.id === media.id);
  let controlsHtml;
  if (entry) {
    controlsHtml = `<div class="field-group">
      <div class="field-label">${T.inList}: ${T.status[entry.status] || entry.status}</div>
      <div class="status-row"><button class="status-btn" onclick="closeInfoModal(); openModal(allEntries.find(e=>e.media.id===${media.id}))">${T.edit}</button></div>
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
  const anilistLink = `<a class="info-link" href="https://anilist.co/anime/${media.id}" target="_blank" rel="noopener">${T.anilistLink}</a>`;

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
    <img src="${media.coverImage.large || media.coverImage.medium}" class="info-cover-lg" loading="lazy">
    <div class="info-meta-row">
      ${statusBadge}
      <span class="info-score">${scoreStr}</span>
      ${anilistLink}
      ${genres}
    </div>
    ${controlsHtml}
    ${descHtml}
    ${relatedHtml}
  `;
}

function closeInfoModal() {
  $('info-modal').classList.remove('open');
}

function toggleInfoDesc(id, btn) {
  const el = $(id);
  el.classList.toggle('expanded');
  btn.textContent = el.classList.contains('expanded') ? T.showLess : T.showMore;
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
    orientation: 'portrait',
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
    if (e.target.closest('#edit-modal') || e.target.closest('#info-modal') || e.target.closest('.catalog-dropdown') || e.target.closest('.tabs-wrap')) return;
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
