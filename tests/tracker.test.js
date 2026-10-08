import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../js/tracker.js';

const T = globalThis.PDTracker;
const all = (n) => Object.fromEntries(T.DATASETS.map((d) => [d.id, n]));

test('summarise counts available, missing and unknown, and lists issues', () => {
  const s = T.summarise({
    counts: { ...all(0), 'conservation-area': 28, tree: 6455, 'contaminated-land': null },
    article4: { areas: 113, directions: 3, unlinked: 113, no_location: 1 },
  });
  assert.deepEqual(s.available, ['conservation-area', 'tree']);
  assert.equal(s.unknown.length, 1);
  assert.equal(s.score, 2);
  assert.equal(s.checked, T.DATASETS.length - 1);
  assert.equal(s.issues.length, 2);
  assert.match(s.issues[0], /113 of 113/);
});

test('an authority not checked has no score', () => {
  assert.equal(T.summarise({ counts: {} }).score, null);
  assert.equal(T.binFor(null), null);
});

test('bins cover 0 to 10 with no gaps', () => {
  for (let i = 0; i <= 10; i++) assert.ok(T.binFor(i), String(i));
  assert.equal(T.binFor(0).label, '0–1');
  assert.equal(T.binFor(10).label, '8–10');
});

test('national stats', () => {
  const st = T.nationalStats({ authorities: [
    { counts: { ...all(0), 'conservation-area': 5 } },
    { counts: { ...all(3) }, article4: { areas: 2, directions: 1, unlinked: 1, no_location: 0 } },
    { counts: { ...all(0), 'conservation-area': null } },
  ] });
  const ca = st.datasets.find((d) => d.id === 'conservation-area');
  assert.equal(ca.checked, 2);
  assert.equal(ca.pct, 100);
  assert.equal(st.none, 1);
  assert.equal(st.withIssues, 1);
  assert.equal(st.median, 1);
});

test('live check mirrors the snapshot logic, including ignored filters and 422s', async () => {
  const fetch = async (url) => {
    const ds = new URL(url).searchParams.get('dataset');
    const body = ds === 'conservation-area' ? { entities: [{ entity: 1, dataset: ds }], count: 28 }
      : ds === 'contaminated-land' ? { entities: [{ entity: 9, dataset: 'local-authority' }], count: 25000000 }
        : ds === 'local-green-space' ? null
          : { entities: [], count: 0 };
    if (!body) return { ok: false, status: 422, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => body };
  };
  let ticks = 0;
  const r = await T.liveCheck(fetch, { entity: 626215, name: 'Kingston upon Thames LPA' }, { onProgress: () => { ticks++; } });
  assert.equal(r.counts['conservation-area'], 28);
  assert.equal(r.counts['contaminated-land'], null);
  assert.equal(r.counts['local-green-space'], 0);
  assert.equal(ticks, T.DATASETS.length);
  assert.ok(r.checkedLive);
  assert.equal(T.displayName(r.name), 'Kingston upon Thames');
});
