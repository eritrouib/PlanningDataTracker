(function () {
'use strict';

// Planning Data Tracker: shared logic (no DOM) so it can be tested in Node.
// Exposes globalThis.PDTracker.

const API = 'https://www.planning.data.gov.uk';

// Keep in step with DATASETS in scripts/build_tracker.py.
const DATASETS = [
  { id: 'article-4-direction-area', label: 'Article 4 areas', short: 'A4' },
  { id: 'conservation-area', label: 'Conservation areas', short: 'CA' },
  { id: 'tree-preservation-zone', label: 'Tree preservation areas', short: 'TPZ' },
  { id: 'tree', label: 'Protected trees', short: 'Tree' },
  { id: 'locally-listed-building', label: 'Locally listed buildings', short: 'LLB' },
  { id: 'brownfield-land', label: 'Brownfield land register', short: 'BFL' },
  { id: 'building-preservation-notice', label: 'Building preservation notices', short: 'BPN' },
  { id: 'asset-of-community-value', label: 'Assets of community value', short: 'ACV' },
  { id: 'local-green-space', label: 'Local green spaces', short: 'LGS' },
  { id: 'contaminated-land', label: 'Contaminated land', short: 'CL' },
];

// Sequential blue ramp (light = few datasets, dark = many). Grey = not checked.
// Validated ordinal ramp (dataviz validate_palette.js --ordinal: all checks pass).
const BINS = [
  { min: 0, max: 1, color: '#86b6ef', label: '0–1' },
  { min: 2, max: 3, color: '#5598e7', label: '2–3' },
  { min: 4, max: 5, color: '#256abf', label: '4–5' },
  { min: 6, max: 7, color: '#184f95', label: '6–7' },
  { min: 8, max: 10, color: '#0d366b', label: '8–10' },
];
const NO_DATA_COLOR = '#d6d3cd';

function binFor(score) {
  if (score == null) return null;
  return BINS.find((b) => score >= b.min && score <= b.max) || BINS[BINS.length - 1];
}

/** available = datasets with records; missing = 0 records; unknown = couldn't check. */
function summarise(authority, datasets = DATASETS) {
  const counts = authority.counts || {};
  const available = [], missing = [], unknown = [];
  for (const d of datasets) {
    const n = counts[d.id];
    if (n == null) unknown.push(d.id);
    else if (n > 0) available.push(d.id);
    else missing.push(d.id);
  }
  const checked = available.length + missing.length;
  const issues = [];
  const a4 = authority.article4;
  if (a4) {
    if (a4.unlinked) issues.push(`${a4.unlinked} of ${a4.areas} Article 4 areas don't link to a published Article 4 direction`);
    if (a4.no_location) issues.push(`${a4.no_location} Article 4 area${a4.no_location > 1 ? 's have' : ' has'} no map location`);
    if (a4.areas && !a4.directions) issues.push('Article 4 areas are published but no Article 4 directions');
  }
  return { available, missing, unknown, checked, score: checked ? available.length : null, issues };
}

/** Share of authorities with each dataset, plus overall figures. */
function nationalStats(tracker, datasets = DATASETS) {
  const auths = tracker.authorities || [];
  const per = datasets.map((d) => {
    let yes = 0, checked = 0;
    for (const a of auths) {
      const n = (a.counts || {})[d.id];
      if (n == null) continue;
      checked++;
      if (n > 0) yes++;
    }
    return { ...d, yes, checked, pct: checked ? Math.round((100 * yes) / checked) : null };
  });
  const summaries = auths.map((a) => summarise(a, datasets));
  const scores = summaries.map((s) => s.score).filter((x) => x != null);
  const withIssues = summaries.filter((s) => s.issues.length).length;
  return {
    authorities: auths.length,
    datasets: per,
    median: scores.length ? median(scores) : null,
    none: scores.filter((x) => x === 0).length,
    withIssues,
  };
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ---------------------------------------------------------------------------
// Live check of one authority from the browser (same logic as the script)
// ---------------------------------------------------------------------------
async function getJson(fetchFn, url, timeoutMs = 20000) {
  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timed out')), timeoutMs); });
  try {
    const res = await Promise.race([fetchFn(url, { headers: { Accept: 'application/json' } }), timeout]);
    if (res.status === 404 || res.status === 422 || res.status === 400) return { __status: res.status };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await Promise.race([res.json(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function countInArea(fetchFn, dataset, areaEntity) {
  const data = await getJson(fetchFn, `${API}/entity.json?dataset=${dataset}&geometry_entity=${areaEntity}`
    + '&geometry_relation=intersects&limit=1&field=entity&field=dataset');
  if (data.__status) return 0;
  const ents = data.entities || [];
  if (ents.some((e) => e.dataset && e.dataset !== dataset)) return null;
  if (typeof data.count === 'number' && data.count > 1e6) return null;
  return typeof data.count === 'number' ? data.count : ents.length;
}

async function liveCheck(fetchFn, authority, { concurrency = 4, onProgress } = {}) {
  const counts = {};
  const queue = DATASETS.map((d) => d.id);
  let done = 0;
  async function worker() {
    while (queue.length) {
      const ds = queue.shift();
      try { counts[ds] = await countInArea(fetchFn, ds, authority.entity); } catch { counts[ds] = null; }
      done++;
      if (onProgress) onProgress(done, DATASETS.length);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { ...authority, counts, article4: authority.article4 || null, checkedLive: new Date().toISOString() };
}

function entityUrl(entity) {
  return `${API}/entity/${entity}`;
}

function datasetSearchUrl(dataset, areaEntity) {
  return `${API}/entity/?dataset=${dataset}&geometry_entity=${areaEntity}&geometry_relation=intersects`;
}

/** Remove the " LPA" suffix Planning Data puts on authority names. */
function displayName(name) {
  return String(name || '').replace(/\s+LPA$/i, '');
}

globalThis.PDTracker = {
  API, DATASETS, BINS, NO_DATA_COLOR, binFor, summarise, nationalStats, liveCheck, countInArea,
  entityUrl, datasetSearchUrl, displayName,
};
})();
