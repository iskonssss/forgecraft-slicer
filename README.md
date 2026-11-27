# Forgecraft Slicer

Drop a TinkerCAD name plate STL, pick the printer, download a ready-to-print Bambu Studio project.
Base and letter colours land on the right AMS slots every time.

**Open it here: https://iskonssss.github.io/forgecraft-slicer/**
(also has the Lattice Ball maker, Walker Prep Station and Line Thickener, see [Other tools](#other-tools-on-the-site))

## For trainers

1. Open the link above in Chrome or Edge. Click **Install app** (top right) once, or bookmark it.
   After that it opens from the desktop / Start menu like a normal program.
2. Pick the printer, drop all the students' STL files on the page at once.
   Every STL gets its own plate, named after the file (plates follow file-name order).
3. Flip through the plates with the **← →** keys (or click a file in the list) and check each one:
   letters visible, right height, not floating, not touching.
4. Click **Download**. Name plates and single-colour models come as separate projects
   (different print settings), so with both you get **Download all**, which saves both files.
   Bambu Studio allows at most 36 plates per project, so bigger groups are split into several files automatically.
5. Open the file in Bambu Studio, do the AMS mapping as usual, **Slice all**, then print each plate.

| Printer | Base | Letters |
|---|---|---|
| P1S, X1C, P2S | AMS slot 1 | AMS slot 2 |
| H2D (right nozzle), X2D (main nozzle) | AMS slot 1 | AMS slot 2 |
| A1, A1 mini (AMS lite) | AMS lite slot 2 | AMS lite slot 3 |

Name plates use 0.28 mm Name Plate settings (0.2 mm first layer, top 0.56 mm of the letters painted, Arachne walls).
Spinners and other single-colour parts use 0.20 mm Standard. Generic PLA, Textured PEI plate.

Nothing to install or update. The page always loads the latest version when online, and keeps working offline once opened.
If the page ever shows a yellow "printer settings have not been checked" banner, tell the workshop owner.

## Other tools on the site

The bar at the top of every page switches between the tools. One install covers all of them.

| Tool | Address | What it does |
|---|---|---|
| Name Plate Slicer | `/` | Name plate STLs to ready-to-print Bambu projects (this page) |
| Lattice Ball | `/lattice-ball/` | TPU bouncy ball with the student's name, STL + 3MF |
| Walker Prep | `/walker-prep/` | Ramp walker: leg slots, centre weight, support blockers, balance check |
| Line Thickener | `/line-thickener/` | Thickens too-thin lines in picsvg SVGs before Tinkercad |

Each tool is one HTML file in `apps/<folder>/`, exactly as it comes from Claude. The build adds the top bar,
the app icon and offline support, so the files themselves never need editing for the site.

### Updating a tool

1. Improve the tool in its Claude chat as usual.
2. Get the new version onto the site, either way:
   - **Ask Claude Code** (in this folder): "update the Walker Prep on the site". It fetches the latest version
     from claude.ai, checks it works, and pushes.
   - **Or by hand on GitHub:** download the HTML from the Claude chat, rename it `index.html`, then on
     github.com open `apps/<folder>/` > *Add file* > *Upload files* > *Commit changes*.
3. The site updates by itself about 2 minutes later.

### Adding a new tool

Make a folder in `apps/` with the tool as `index.html` (plus any files it loads), and add a line to
`apps/apps.json` (folder, title, one-line description). The title is what shows in the top bar.
`apps.json` can also hold small wording fixes (`replace`) applied when the site is built, for text that only
makes sense inside Claude (for example "open this page in claude.ai").

## How updates work (nothing to do)

Every Monday a GitHub job checks whether Bambu Studio has a new version. If it does, it:

1. downloads the new Bambu Studio,
2. rebuilds the printer settings for all 7 printers with it,
3. slices a test name plate (`test/test-plate.stl`) on every printer, as a 3-plate 2-colour project and in 1-colour mode,
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
- **Test locally:** `node tools/test_slice.js --printers all --mode nameplate --expect-letters 5 --copies 3 test/test-plate.stl`
  (`--copies N` puts N copies in one project, each on its own plate.)
- **Website only:** `python tools/build.py --html-only` writes the site to `site/`.

Code: `src/core.js` (STL parsing, letter detection, 3MF writer), `src/viewer.js` (3D preview),
`src/app.js` (page), `src/templates.js` (generated printer settings), `tools/build.py` (builder).

Never commit student files. `.gitignore` blocks every `.stl` and `.3mf` except the test plate.
