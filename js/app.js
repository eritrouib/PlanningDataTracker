(function () {
'use strict';

/* global L */
const T = window.PDTracker;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (n == null ? '–' : Number(n).toLocaleString('en-GB'));

const state = {
  data: window.TRACKER_DATA || null,
  boundaries: window.TRACKER_BOUNDARIES || null,
  byEntity: new Map(),
  selected: null,
  layers: new Map(),
};

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------
const map = L.map('map', { zoomSnap: 0.25 }).setView([52.7, -1.7], 6.25);
L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
  maxZoom: 16, attribution: 'Basemap &copy; Esri · Boundaries: planning.data.gov.uk (OGL)',
}).addTo(map);

function colorFor(a) {
  const s = T.summarise(a);
  const bin = T.binFor(s.score);
  return bin ? bin.color : T.NO_DATA_COLOR;
}

function drawMap() {
  if (!state.boundaries) return;
  const layer = L.geoJSON(state.boundaries, {
    style: (f) => {
      const a = state.byEntity.get(f.properties.entity);
      return { color: '#ffffff', weight: 1, fillColor: a ? colorFor(a) : T.NO_DATA_COLOR, fillOpacity: 0.85 };
    },
    onEachFeature: (f, l) => {
      state.layers.set(f.properties.entity, l);
      const a = state.byEntity.get(f.properties.entity);
      const s = a ? T.summarise(a) : null;
      l.bindTooltip(`<strong>${esc(T.displayName(f.properties.name))}</strong><br>${s && s.score != null ? `${s.score} of ${T.DATASETS.length} datasets` : 'Not checked'}${s && s.issues.length ? '<br>⚠ Data issues' : ''}`, { sticky: true });
      l.on('click', () => select(f.properties.entity, { fromMap: true }));
      l.on('mouseover', () => l.setStyle({ weight: 2.5, color: '#1b1f27' }));
      l.on('mouseout', () => l.setStyle({ weight: f.properties.entity === state.selected ? 3 : 1, color: f.properties.entity === state.selected ? '#1b1f27' : '#ffffff' }));
    },
  }).addTo(map);
  state.boundaryLayer = layer;
}

function restyle(entity) {
  const l = state.layers.get(entity);
  const a = state.byEntity.get(entity);
  if (l && a) l.setStyle({ fillColor: colorFor(a) });
}

function drawLegend() {
  $('#legend').innerHTML = `<div class="t">Datasets available (of ${T.DATASETS.length})</div>${T.BINS.map((b) => `<div class="row"><span class="k" style="background:${b.color}"></span>${b.label}</div>`).join('')}<div class="row"><span class="k" style="background:${T.NO_DATA_COLOR}"></span>Not checked</div>`;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
function drawOverview() {
  if (!state.data) {
    $('#overview').hidden = true;
    return;
  }
  const st = T.nationalStats(state.data);
  $('#tiles').innerHTML = [
    [fmt(st.authorities), 'planning authorities checked'],
    [st.median == null ? '–' : `${st.median} / ${T.DATASETS.length}`, 'datasets available (median council)'],
    [fmt(st.none), `councils with none of the ${T.DATASETS.length}`],
    [fmt(st.withIssues), 'councils with Article 4 data issues'],
  ].map(([n, l]) => `<div class="tile"><div class="num">${esc(n)}</div><div class="lbl">${esc(l)}</div></div>`).join('');
  const per = [...st.datasets].sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1));
  $('#bars').innerHTML = per.map((d) => `
    <li title="${esc(`${d.label}: ${d.yes} of ${d.checked} councils`)}">
      <span class="bl">${esc(d.label)}</span><span class="bv">${d.pct == null ? '–' : `${d.pct}%`}</span>
      <span class="bt" aria-hidden="true"><span class="bf" style="width:${d.pct || 0}%"></span></span>
    </li>`).join('');
  const g = new Date(state.data.generated);
  $('#updated').textContent = `Snapshot: ${g.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

// ---------------------------------------------------------------------------
// Council list
// ---------------------------------------------------------------------------
function drawList() {
  const q = $('#q').value.trim().toLowerCase();
  const sort = $('#sort').value;
  let list = [...state.byEntity.values()].filter((a) => !q || T.displayName(a.name).toLowerCase().includes(q));
  const sc = (a) => T.summarise(a);
  list.sort((a, b) => {
    const sa = sc(a), sb = sc(b);
    if (sort === 'score-asc') return (sa.score ?? 99) - (sb.score ?? 99) || a.name.localeCompare(b.name);
    if (sort === 'score-desc') return (sb.score ?? -1) - (sa.score ?? -1) || a.name.localeCompare(b.name);
    if (sort === 'issues') return sb.issues.length - sa.issues.length || a.name.localeCompare(b.name);
    return T.displayName(a.name).localeCompare(T.displayName(b.name));
  });
  $('#councils').innerHTML = list.slice(0, 400).map((a) => {
    const s = sc(a);
    return `<li class="${a.entity === state.selected ? 'active' : ''}"><button data-e="${a.entity}">
      <span class="sw" style="background:${colorFor(a)}"></span>
      <span class="nm">${esc(T.displayName(a.name))}${s.issues.length ? '<span class="flag" title="Data issues">⚠</span>' : ''}</span>
      <span class="sc">${s.score == null ? 'not checked' : `${s.score} / ${T.DATASETS.length}`}</span>
    </button></li>`;
  }).join('') || '<li class="muted small" style="padding:8px 4px">No councils match.</li>';
  $('#councils').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => select(Number(b.dataset.e))));
}
$('#q').addEventListener('input', drawList);
$('#sort').addEventListener('change', drawList);

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------
function select(entity, { fromMap = false } = {}) {
  const prev = state.selected;
  state.selected = entity;
  if (prev != null && state.layers.get(prev)) state.layers.get(prev).setStyle({ weight: 1, color: '#ffffff' });
  const l = state.layers.get(entity);
  if (l) {
    l.setStyle({ weight: 3, color: '#1b1f27' });
    l.bringToFront();
    if (!fromMap) map.fitBounds(l.getBounds(), { maxZoom: 11, padding: [30, 30] });
  }
  history.replaceState(null, '', `#council=${entity}`);
  drawDetail();
  drawList();
}

function drawDetail() {
  const a = state.byEntity.get(state.selected);
  const el = $('#detail');
  if (!a) { el.hidden = true; return; }
  const s = T.summarise(a);
  const rows = T.DATASETS.map((d) => {
    const n = (a.counts || {})[d.id];
    const cls = n == null ? 'unk' : n > 0 ? 'yes' : 'no';
    const ic = n == null ? '?' : n > 0 ? '✓' : '✗';
    const txt = n == null ? 'not checked' : n > 0 ? `${fmt(n)} record${n === 1 ? '' : 's'}` : 'none';
    return `<li class="${cls}"><span class="ic" aria-hidden="true">${ic}</span><span>${esc(d.label)}</span>
      <span class="n">${n > 0 ? `<a href="${T.datasetSearchUrl(d.id, a.entity)}" target="_blank" rel="noopener">${txt}</a>` : txt}</span></li>`;
  }).join('');
  const issues = s.issues.length ? `<h4>Data issues</h4><ul class="issues">${s.issues.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>
    ${a.article4 && a.article4.orgs ? `<p class="small muted">Examples: ${esc(a.article4.orgs.flatMap((o) => o.examples || []).slice(0, 3).join(', '))}</p>` : ''}` : '';
  const missing = s.missing.length ? `<p class="small">For the datasets marked ✗, a planning tool can't tell you "no": the answer is unknown until the council publishes them.</p>` : '';
  el.innerHTML = `
    <header><div><h3>${esc(T.displayName(a.name))}</h3><span class="small muted">${esc(a.reference || '')}</span></div>
      <button class="close" aria-label="Close">×</button></header>
    <div class="body">
      <div class="score"><span class="num">${s.score == null ? '–' : s.score}</span><span class="muted">of ${T.DATASETS.length} datasets available</span></div>
      <ul class="ds">${rows}</ul>
      ${missing}
      ${issues}
      <button class="btn" id="live">Check this council live now</button>
      <div class="live-note">${a.checkedLive ? `Checked live ${new Date(a.checkedLive).toLocaleString('en-GB')}.` : state.data ? `From the snapshot of ${new Date(state.data.generated).toLocaleDateString('en-GB')}.` : 'Not checked yet.'}
      <a href="${T.entityUrl(a.entity)}" target="_blank" rel="noopener">Authority on Planning Data</a></div>
    </div>`;
  el.hidden = false;
  el.querySelector('.close').addEventListener('click', () => { el.hidden = true; });
  el.querySelector('#live').addEventListener('click', async (e) => {
    const btn = e.target;
    btn.disabled = true;
    try {
      const updated = await T.liveCheck(fetch, a, { onProgress: (d, n) => { btn.textContent = `Checking… ${d}/${n}`; } });
      state.byEntity.set(a.entity, updated);
      restyle(a.entity);
      drawDetail();
      drawList();
    } catch (err) {
      btn.textContent = 'Couldn\'t check right now';
    }
  });
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
async function start() {
  drawLegend();
  if (state.data) {
    for (const a of state.data.authorities) state.byEntity.set(a.entity, a);
  } else {
    $('#nodata').hidden = false;
    try {
      const res = await fetch(`${T.API}/entity.json?dataset=local-planning-authority&limit=500&exclude_field=geometry,point`);
      const json = await res.json();
      const today = new Date().toISOString().slice(0, 10);
      for (const e of json.entities || []) {
        if (e['end-date'] && e['end-date'] <= today) continue;
        state.byEntity.set(e.entity, { entity: e.entity, name: e.name, reference: e.reference, counts: {} });
      }
    } catch (e) {
      $('#councils').innerHTML = '<li class="muted small" style="padding:8px 4px">Couldn\'t load the list of councils from Planning Data.</li>';
    }
  }
  drawOverview();
  drawMap();
  drawList();
  const m = location.hash.match(/council=(\d+)/);
  if (m && state.byEntity.has(Number(m[1]))) select(Number(m[1]));
}
start();
})();
