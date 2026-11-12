# WebCAD round-40 ideation

## Candidate 1 — DXF import coverage preview
Before importing a DXF, show a pre-import summary dialog: entity counts by type (LINE/CIRCLE/ARC/LWPOLYLINE/...), which types WebCAD converts vs. skips, overall bounding box, and units. User can then confirm or cancel the import. Builds on round-32 DXF import; adds confidence and transparency for interop users. ~80–120 lines in app.js + index.html dialog + verify script.

## Candidate 2 — Per-layer visibility + lock (context menu)
Right-click a layer row to toggle Visible / Locked. Visible=false hides entities and excludes them from snapping; Locked prevents selection and modification. Standard CAD behavior, cheap and high utility. ~60–100 lines + verify script.

## Recommendation
Candidate 1 first (was already peer-reviewed as keep in the earlier improve loop and fits the scripting/interop story of the drawing-JSON article). Candidate 2 as the round-41 follow-up.
