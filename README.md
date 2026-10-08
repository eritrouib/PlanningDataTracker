# Planning Data Tracker

**Can you trust the "no"?** Planning tools built on [planning.data.gov.uk](https://www.planning.data.gov.uk) can only answer from what each council has published. If a council hasn't published its tree preservation orders, a tool that finds "no TPO" is really saying "unknown".

This tracker shows, for every local planning authority in England:

- which of 10 council-published datasets have any records in its area: Article 4 areas, conservation areas, tree preservation areas, protected trees, locally listed buildings, the brownfield land register, building preservation notices, assets of community value, local green spaces and contaminated land
- data-quality problems with Article 4 directions: areas that don't link to a published direction, areas with no map location, and areas published without their directions

It came out of building the [Kingston Article 4 checker](https://github.com/eritrouib/Article4Kingston), where Kingston's 113 Article 4 areas turned out not to link to their three directions.

**Live site:** https://eritrouib.github.io/PlanningDataTracker/ (once GitHub Pages is enabled)

## Using it

- The map colours each authority by how many of the 10 datasets are available (darker = more).
- Click an authority (or search the list) for its checklist, record counts linking to Planning Data, and any data issues.
- **Check this council live now** re-runs the checks from your browser in a few seconds, so you're not limited to the weekly snapshot.

## How the data is built

`scripts/build_tracker.py` (Python 3, no extra packages) asks Planning Data, for each authority and dataset, how many records intersect the authority's area. It guards against answers where the location filter was ignored, checks Article 4 areas against the published directions, and simplifies the authority boundaries for a light map. It's polite to the API (about 8 requests a second at most) and takes roughly 20 to 40 minutes for all 337 authorities.

A GitHub Action (`.github/workflows/update.yml`) runs it every Monday and commits the snapshot (`data/` and `js/data.js`).

### First run

1. Push this repo to GitHub and enable Pages (Settings → Pages → Deploy from branch → `main`, `/ (root)`).
2. Settings → Actions → General → Workflow permissions → **Read and write permissions**.
3. Actions → **Update tracker** → **Run workflow**.

Until the first snapshot exists, the page still lists every authority and you can check any of them live.

Or run it on your own computer: `python scripts/build_tracker.py` (add `--limit 5` for a quick trial).

## Notes

- "Available" means at least one record of that type falls within the authority's area, whoever published it. Some datasets also have national publishers.
- Counts are records, not area coverage: one record can be a whole conservation area or a single tree.
- Document-type datasets (for example Article 4 direction documents) have no geometry, so they're checked per council for Article 4 only.

## Development

```
npm test        # JavaScript tests (Node) and Python tests
```

## Licence & attribution

Created by **@ET**.

Contains public sector information licensed under the Open Government Licence v3.0, from planning.data.gov.uk (MHCLG). Boundaries: local planning authority boundaries via planning.data.gov.uk. Basemap © Esri.
