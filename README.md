# WebCAD

Live app: [https://webcad.untasked.run](https://webcad.untasked.run)

A lightweight 2D CAD workspace that runs in the browser. Vanilla-JS canvas engine on the
front end, Express + PostgreSQL on the back end, so drawings persist between visits and can
be shared with a link.

## What it does

- **Draw**: line, polyline, rectangle, circle, arc, dimension, text, move, copy, rotate, erase.
- **Precision**: object snap (endpoint / midpoint / center / intersection), grid snap, ortho mode,
  numeric coordinate entry in the command bar.
- **Edit**: window and crossing selection, undo / redo (Ctrl+Z / Ctrl+Y), layers with per-layer
  colour, lineweight, visibility and lock.
- **Navigate**: pan (middle drag / space), zoom to fit, wheel zoom, grid that adapts to zoom.
- **Persist**: autosave to PostgreSQL (debounced), explicit save, drawing browser, shareable
  `/d/:id` links.
- **Reference underlay**: import a PNG/JPEG (≤4 MB, downscaled to 1600 px) as a locked, non-snapping,
  adjustable-opacity tracing reference; calibrate its scale with two points and a known distance.
  The underlay is excluded from SVG/DXF export.
- **Export**: SVG, DXF R12 (opens in AutoCAD / QCAD / LibreCAD), PNG raster of the viewport,
  and the native JSON document (also importable by drag and drop).

## Layout

```
server.js          Express API + static host + DDL/bootstrap
public/index.html  App shell: toolbar, palettes, status bar
public/style.css   Dark CAD theme
public/app.js      Canvas engine, tools, snapping, undo, persistence, exporters
untasked.yaml      Web process description (dockerfile, port, health)
```

### API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Liveness + DB probe |
| GET | `/api/drawings` | List drawings (id, name, rev, entity count, timestamps) |
| POST | `/api/drawings` | Create a drawing `{name, data}` |
| GET | `/api/drawings/:id` | Fetch one drawing with its document |
| PUT | `/api/drawings/:id` | Update name/document; bumps `rev`, snapshots every 10th revision into `drawing_versions` |
| DELETE | `/api/drawings/:id` | Delete |
| GET | `/d/:id` | Share link; serves the app which loads that id |

### Schema

`drawings(id text pk, name, data jsonb, rev, created_at, updated_at)` and
`drawing_versions(id serial pk, drawing_id fk, rev, data, created_at)`, created on boot.
`MIGRATION_DATABASE_URL` is used for DDL when present (the runtime role cannot create
objects in the hosted schema); `DATABASE_URL` is used for request-time queries.

A sample floor-plan drawing is seeded when the table is empty.

## About

This project is built and maintained by [Untasked](https://untasked.app) AI agents. Untasked is a platform where autonomous AI agents turn your ideas into working software, from development to deployment and ongoing maintenance.

## Local development

```bash
cp .env.example .env      # point DATABASE_URL at any PostgreSQL
docker compose up --build # http://localhost:8080
```

Self-hosting is supported: the only requirements are PostgreSQL and a container host.
A hosted deployment injects `DATABASE_URL` and `MIGRATION_DATABASE_URL` at runtime; those
credentials are not part of this repository.

## Keyboard

| Key | Action |
| --- | --- |
| L / PL / REC / C / A / D / T | line, polyline, rectangle, circle, arc, dimension, text |
| M / CO / RO / E | move, copy, rotate, erase |
| Esc | cancel current command / clear selection |
| F3 / F8 / F9 / F7 | osnap / ortho / grid snap / grid |
| Ctrl+Z / Ctrl+Y | undo / redo |
| Ctrl+S | save |
| Del | erase selection |
