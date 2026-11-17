# Forgecraft Slicer

Drop a TinkerCAD name plate STL, pick the printer, download a ready-to-print Bambu Studio project.
Base and letter colours land on the right AMS slots every time.

**Open it here: https://iskonssss.github.io/forgecraft-slicer/**

## For trainers

1. Open the link above in Chrome or Edge. Click **Install app** (top right) once, or bookmark it.
   After that it opens from the desktop / Start menu like a normal program.
2. Pick the printer, drop the student's STL files on the page.
3. Check the preview (letters visible, right height, not floating, not touching), then **Download .3mf**.
   It opens in Bambu Studio. Do the AMS mapping there as usual, then send to the printer.

| Printer | Base | Letters |
|---|---|---|
| P1S, X1C, P2S | AMS slot 1 | AMS slot 2 |
| H2D (right nozzle), X2D (main nozzle) | AMS slot 1 | AMS slot 2 |
| A1, A1 mini (AMS lite) | AMS lite slot 2 | AMS lite slot 3 |

Name plates use 0.28 mm Name Plate settings (0.2 mm first layer, top 0.56 mm of the letters painted, Arachne walls).
Spinners and other single-colour parts use 0.20 mm Standard. Generic PLA, Textured PEI plate.

Nothing to install or update. The page always loads the latest version when online, and keeps working offline once opened.
If the page ever shows a yellow "printer settings have not been checked" banner, tell the workshop owner.

## How updates work (nothing to do)

Every Monday a GitHub job checks whether Bambu Studio has a new version. If it does, it:

1. downloads the new Bambu Studio,
2. rebuilds the printer settings for all 7 printers with it,
3. slices a test name plate (`test/test-plate.stl`) on every printer, in 2-colour and 1-colour mode,
4. publishes the new site **only if every printer passes**.

If any printer fails, the site stays on the last good version and GitHub emails the repo owner about the failed run.
The job also commits a small heartbeat (`build-info.json`) every month so GitHub never pauses the schedule.

## For the maintainer

- **Changed a Name Plate preset in Bambu Studio?** On the PC with the edited presets:
  ```
  python tools/build.py --import-presets
  python tools/build.py
  ```
  then commit and push `presets/` and `src/templates.js`. Pushing publishes the site.
- **Force a rebuild now:** GitHub > Actions > *Build and publish* > *Run workflow*, tick *Rebuild printer settings*.
  Tick *test only* to try it without publishing.
- **Test locally:** `node tools/test_slice.js --printers all --mode nameplate --expect-letters 5 test/test-plate.stl`
- **Website only:** `python tools/build.py --html-only` writes the site to `site/`.

Code: `src/core.js` (STL parsing, letter detection, 3MF writer), `src/viewer.js` (3D preview),
`src/app.js` (page), `src/templates.js` (generated printer settings), `tools/build.py` (builder).

Never commit student files. `.gitignore` blocks every `.stl` and `.3mf` except the test plate.
