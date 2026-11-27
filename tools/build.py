"""
Forgecraft Slicer - build script.

    python tools/build.py                    # rebuild printer settings + website
    python tools/build.py --html-only        # just re-bundle the website (no Bambu Studio needed)
    python tools/build.py --import-presets   # copy the "0.28mm Name Plate ..." presets from this PC's
                                             # Bambu Studio into presets/ (after you edit them)
    python tools/build.py --bambu <folder>   # use a specific Bambu Studio (folder or bambu-studio.exe)

What it does:
  1. Flattens Bambu Studio's printer / process / Generic PLA presets, asks the
     Bambu Studio command line to slice a test cube with them for each printer,
     and keeps the resulting full project settings in src/templates.js.
     The Name Plate tweaks come from presets/*.json.
  2. Bundles src/ into site/ (a single index.html + app files) for GitHub Pages.

On GitHub this runs automatically every week (.github/workflows/build.yml).
"""
import argparse
import datetime
import glob
import hashlib
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
SITE = os.path.join(ROOT, "site")
PRESETS = os.path.join(ROOT, "presets")
TEMPLATES_JS = os.path.join(SRC, "templates.js")
BUILD_INFO = os.path.join(ROOT, "build-info.json")
APPDATA = os.environ.get("APPDATA", "")

# key, button label, machine preset, standard process, filament preset, name plate preset, base slot, letter slot
# Forgecraft uses Generic PLA on every printer.
PRINTERS = [
    ("X1C", "X1C", "Bambu Lab X1 Carbon 0.4 nozzle", "0.20mm Standard @BBL X1C", "Generic PLA", "0.28mm Name Plate X1C", 1, 2),
    ("P1S", "P1S", "Bambu Lab P1S 0.4 nozzle", "0.20mm Standard @BBL X1C", "Generic PLA", "0.28mm Name Plate P1S", 1, 2),
    ("P2S", "P2S", "Bambu Lab P2S 0.4 nozzle", "0.20mm Standard @BBL P2S", "Generic PLA @BBL P2S", "0.28mm Name Plate P2S", 1, 2),
    ("H2D", "H2D", "Bambu Lab H2D 0.4 nozzle", "0.20mm Standard @BBL H2D", "Generic PLA @BBL H2D", "0.28mm Name Plate H2D", 1, 2),
    ("X2D", "X2D", "Bambu Lab X2D 0.4 nozzle", "0.20mm Standard @BBL X2D", "Generic PLA @BBL X2D 0.4 nozzle", "0.28mm Name Plate X2D", 1, 2),
    ("A1", "A1", "Bambu Lab A1 0.4 nozzle", "0.20mm Standard @BBL A1", "Generic PLA @BBL A1", "0.28mm Name Plate A1", 2, 3),
    ("A1M", "A1 mini", "Bambu Lab A1 mini 0.4 nozzle", "0.20mm Standard @BBL A1M", "Generic PLA @BBL A1M", "0.28mm Name Plate A1 Mini", 2, 3),
]

GUI_EXTRA_KEYS = {
    "host_type": "octoprint",
    "printhost_authorization_type": "key",
    "printhost_ssl_ignore_revoke": "0",
    "multi_nozzle_diameter_mode": "0",
    "printer_nozzle_diameter_mode": "",
}
DROP_KEYS = ["filament_map_2", "compatible_printers_condition"]
PRESET_META = {"from", "inherits", "name", "print_settings_id", "version", "print_extruder_id",
               "print_extruder_variant", "setting_id", "base_id", "updated_time", "user_id",
               "compatible_printers", "compatible_printers_condition", "filament_id", "instantiation"}
PALETTE_ORDER = ["Jade White", "Black", "Light Gray", "Gray", "Dark Gray", "Silver", "Red", "Maroon Red",
                 "Hot Pink", "Pink", "Magenta", "Orange", "Pumpkin Orange", "Yellow", "Sunflower Yellow",
                 "Gold", "Bronze", "Bright Green", "Bambu Green", "Mistletoe Green", "Turquoise", "Cyan",
                 "Cobalt Blue", "Blue", "Blue Gray", "Purple", "Indigo Purple", "Beige", "Brown", "Cocoa Brown"]


def log(*a, **kw):
    print(*a, flush=True, **kw)


def fail(msg):
    log("ERROR: " + msg)
    sys.exit(1)


# --------------------------------------------------------------------------- locating Bambu Studio
def find_bambu(arg):
    cands = []
    if arg:
        cands.append(arg)
    if os.environ.get("BAMBU_STUDIO"):
        cands.append(os.environ["BAMBU_STUDIO"])
    cands += [r"C:\Program Files\Bambu Studio", r"C:\Program Files (x86)\Bambu Studio"]
    for c in cands:
        if os.path.isfile(c):
            return c
        if os.path.isdir(c):
            hits = glob.glob(os.path.join(c, "**", "bambu-studio.exe"), recursive=True)
            if hits:
                return sorted(hits, key=len)[0]
    return None


def find_profiles(exe, arg):
    cands = []
    if arg:
        cands.append(arg)
    if os.environ.get("BAMBU_PROFILES"):
        cands.append(os.environ["BAMBU_PROFILES"])
    if not os.environ.get("CI"):
        # on a normal PC Bambu Studio keeps newer downloaded profiles here
        cands.append(os.path.join(APPDATA, "BambuStudio", "system", "BBL"))
    cands.append(os.path.join(os.path.dirname(exe), "resources", "profiles", "BBL"))
    return next((c for c in cands if c and os.path.isdir(os.path.join(c, "machine"))), None)


# --------------------------------------------------------------------------- presets
class Profiles:
    META = {"name", "inherits", "include", "instantiation", "type", "from", "setting_id",
            "filament_id", "description", "renamed_from"}

    def __init__(self, base):
        self.base = base
        self.idx = {}
        for cat in ("machine", "process", "filament"):
            for f in glob.glob(os.path.join(base, cat, "*.json")):
                try:
                    d = json.load(open(f, encoding="utf-8"))
                except Exception:
                    continue
                if "name" in d:
                    self.idx[(cat, d["name"])] = d

    def has(self, cat, name):
        return (cat, name) in self.idx

    def resolve(self, cat, name):
        d = self.idx[(cat, name)]
        out = {}
        if d.get("inherits"):
            out.update(self.resolve(cat, d["inherits"]))
        for inc in d.get("include", []):
            out.update({k: v for k, v in self.resolve(cat, inc).items() if k not in self.META})
        out.update({k: v for k, v in d.items() if k not in ("inherits", "include")})
        return out

    def flat(self, cat, name):
        r = self.resolve(cat, name)
        r.pop("include", None)
        r["inherits"] = ""
        r["from"] = "system"
        r["instantiation"] = "true"
        return r


def local_user_preset_dirs():
    return glob.glob(os.path.join(APPDATA, "BambuStudio", "user", "*", "process"))


def load_name_plate_preset(name):
    p = os.path.join(PRESETS, name + ".json")
    if os.path.exists(p):
        return json.load(open(p, encoding="utf-8")), p
    for d in local_user_preset_dirs():
        q = os.path.join(d, name + ".json")
        if os.path.exists(q):
            return json.load(open(q, encoding="utf-8")), q
    return None, None


def import_presets():
    os.makedirs(PRESETS, exist_ok=True)
    n = 0
    for entry in PRINTERS:
        name = entry[5]
        for d in local_user_preset_dirs():
            q = os.path.join(d, name + ".json")
            if os.path.exists(q):
                shutil.copyfile(q, os.path.join(PRESETS, name + ".json"))
                log("  copied", name)
                n += 1
                break
        else:
            log("  ! not found on this PC:", name)
    log(f"Imported {n} preset(s) into presets/. Commit and push them to publish.")


# --------------------------------------------------------------------------- helpers
def cube_stl(path, s=20.0):
    v = [(0, 0, 0), (s, 0, 0), (s, s, 0), (0, s, 0), (0, 0, s), (s, 0, s), (s, s, s), (0, s, s)]
    f = [(0, 2, 1), (0, 3, 2), (4, 5, 6), (4, 6, 7), (0, 1, 5), (0, 5, 4), (1, 2, 6), (1, 6, 5),
         (2, 3, 7), (2, 7, 6), (3, 0, 4), (3, 4, 7)]
    with open(path, "wb") as fh:
        fh.write(b"\0" * 80 + struct.pack("<I", len(f)))
        for a, b, c in f:
            fh.write(struct.pack("<3f", 0, 0, 0))
            for i in (a, b, c):
                fh.write(struct.pack("<3f", *v[i]))
            fh.write(b"\0\0")


def area_bbox(poly):
    pts = [tuple(float(x) for x in p.strip().split("x")) for p in poly if p.strip()]
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return [min(xs), min(ys), max(xs), max(ys)]


def read_palette(pdir):
    """Bambu's own PLA colour list (names + hex)."""
    try:
        d = json.load(open(os.path.join(pdir, "filament", "filaments_color_codes.json"), encoding="utf-8"))
        cols = [(x["fila_color_name"].get("en"), x["fila_color"][0][:7].upper())
                for x in d["data"] if x.get("fila_type") == "PLA Basic" and len(x.get("fila_color", [])) == 1]
    except Exception:
        cols = [("Jade White", "#FFFFFF"), ("Black", "#000000"), ("Blue", "#0A2989"), ("Red", "#C12E1F")]
    rank = {n: i for i, n in enumerate(PALETTE_ORDER)}
    cols.sort(key=lambda c: rank.get(c[0], 999))
    return [list(c) for c in cols]


# --------------------------------------------------------------------------- one printer
def build_printer(exe, prof, work, entry):
    key, label, mname, pname, fname, npname, base_slot, letter_slot = entry
    n = letter_slot  # filaments in the project = up to the letter slot
    for cat, name in (("machine", mname), ("process", pname), ("filament", fname)):
        if not prof.has(cat, name):
            fail(f"[{key}] Bambu preset not found: {cat} '{name}'. Bambu may have renamed it - update PRINTERS in tools/build.py.")
    flat_m = prof.flat("machine", mname)
    flat_p = prof.flat("process", pname)
    flat_f = prof.flat("filament", fname)
    paths = {}
    for cat, d in (("machine", flat_m), ("process", flat_p), ("filament", flat_f)):
        paths[cat] = os.path.join(work, f"{key}_{cat}.json")
        json.dump(d, open(paths[cat], "w", encoding="utf-8"), indent=1)
    stl = os.path.join(work, "cube.stl")
    # Slice once: the sliced project carries the complete per-nozzle settings
    # (a plain export leaves dual-nozzle printers half described).
    out_name = f"{key}.gcode.3mf"
    args = [exe, "--slice", "0", "--outputdir", work,
            "--load-settings", paths["machine"] + ";" + paths["process"],
            "--load-filaments", ";".join([paths["filament"]] * n),
            "--export-3mf", out_name, stl]
    r = subprocess.run(args, capture_output=True)
    out = os.path.join(work, out_name)
    if not os.path.exists(out):
        fail(f"[{key}] Bambu Studio command line failed (exit {r.returncode})")
    cfg = json.loads(zipfile.ZipFile(out).read("Metadata/project_settings.config"))

    for k in DROP_KEYS:
        cfg.pop(k, None)
    for k, v in GUI_EXTRA_KEYS.items():
        cfg.setdefault(k, v)
    for k, v in flat_m.items():  # the CLI clamps machine limits for cloud slicing
        if k.startswith("machine_max_") and k in cfg and isinstance(v, list) and len(v) == len(cfg[k]) and v != cfg[k]:
            cfg[k] = v
    for k, v in flat_f.items():  # per-filament lists the CLI collapsed
        if isinstance(v, list) and len(v) > 1 and k in cfg and len(cfg[k]) == n and len(v) * n != len(cfg[k]):
            cfg[k] = v * n

    nozzles = len(cfg.get("nozzle_diameter", ["0.4"]))
    extruder = int(cfg.get("master_extruder_id", "1") or 1) if nozzles > 1 else 1

    variants = cfg.get("printer_extruder_id", ["1"])
    vi = variants.index(str(extruder)) if str(extruder) in variants else 0
    nozvol = float((cfg.get("nozzle_volume") or ["0"])[vi])
    fil_long = (cfg.get("filament_long_retractions_when_cut") or ["nil"])[0]
    pr_long = (cfg.get("long_retractions_when_cut") or ["0"])[0]
    active = str(cfg.get("enable_long_retraction_when_cut", "0")) == "2" and (fil_long == "1" or (fil_long == "nil" and pr_long == "1"))
    dist = (cfg.get("filament_retraction_distances_when_cut") or ["nil"])[0]
    if dist == "nil":
        dist = (cfg.get("retraction_distances_when_cut") or ["0"])[0]
    min_flush = int(nozvol - (float(dist) * 3.14159265 * 1.75 * 1.75 / 4 if active else 0))

    bed = area_bbox(cfg["printable_area"])
    if nozzles > 1 and cfg.get("extruder_printable_area"):
        ex_area = area_bbox(cfg["extruder_printable_area"][extruder - 1].split(","))
        bed = [max(bed[0], ex_area[0]), max(bed[1], ex_area[1]), min(bed[2], ex_area[2]), min(bed[3], ex_area[3])]
    excl = [area_bbox(cfg["bed_exclude_area"])] if cfg.get("bed_exclude_area") else []

    up, up_path = load_name_plate_preset(npname)
    if up is None:
        log(f"\n  ! [{key}] preset '{npname}' not in presets/ - using the standard three name plate tweaks")
        up = {"inherits": pname, "layer_height": "0.28", "top_color_penetration_layers": "2",
              "wall_generator": "arachne", "name": npname}
    overrides = {k: v for k, v in up.items() if k not in PRESET_META}
    inherits = up.get("inherits", pname)
    if inherits != pname and prof.has("process", inherits):
        base_np = prof.flat("process", inherits)
        for k, v in base_np.items():
            if k in cfg and k not in overrides and cfg[k] != v and not isinstance(v, list):
                overrides[k] = v
    diff = sorted(k for k, v in overrides.items() if flat_p.get(k) != v)

    return {
        "key": key, "label": label, "model": cfg.get("printer_model"), "printer": mname,
        "standardProcess": pname, "namePlateProcess": npname, "namePlateInherits": inherits,
        "namePlateOverrides": overrides, "namePlateDiff": ";".join(diff),
        "slots": {"base": base_slot, "letter": letter_slot}, "filaments": n,
        "nozzles": nozzles, "extruder": extruder, "bed": bed,
        "bedSize": area_bbox(cfg["printable_area"])[2:], "exclude": excl,
        "height": float(cfg.get("printable_height", "250")),
        "primeTowerWidth": float(cfg.get("prime_tower_width", "35")),
        "minFlush": min_flush, "config": cfg,
    }


def build_templates(bambu_arg, profiles_arg):
    exe = find_bambu(bambu_arg)
    if not exe:
        fail("Bambu Studio not found. Install it or pass --bambu <folder>.")
    pdir = find_profiles(exe, profiles_arg)
    if not pdir:
        fail("Bambu Studio printer profiles not found. Pass --profiles <folder>.")
    log("Bambu Studio:", exe)
    log("Profiles:    ", pdir)
    prof = Profiles(pdir)
    bbl_json = os.path.join(pdir, os.pardir, "BBL.json")
    ver = json.load(open(bbl_json, encoding="utf-8")).get("version", "?") if os.path.exists(bbl_json) else "?"
    work = tempfile.mkdtemp(prefix="forgecraft_")
    cube_stl(os.path.join(work, "cube.stl"))
    printers, app_version = {}, None
    for entry in PRINTERS:
        log(f"- {entry[1]:8s} ...", end="")
        t = build_printer(exe, prof, work, entry)
        app_version = t["config"].get("version", app_version)
        log(f" ok  (filaments {t['filaments']}, nozzle {t['extruder']}/{t['nozzles']}, min flush {t['minFlush']},"
            f" name plate changes: {t['namePlateDiff'] or '-'})")
        printers[t["key"]] = t
    data = {
        "generated": datetime.date.today().isoformat(),
        "bambuStudio": app_version,
        "profileVersion": ver,
        "order": [p[0] for p in PRINTERS],
        "printers": printers,
        "palette": read_palette(pdir),
    }
    js = ("/* Generated by tools/build.py - do not edit by hand. */\n"
          "var FORGECRAFT_TEMPLATES = " + json.dumps(data, separators=(",", ":")) + ";\n"
          "if (typeof module !== 'undefined') module.exports = FORGECRAFT_TEMPLATES;\n")
    open(TEMPLATES_JS, "w", encoding="utf-8").write(js)
    log(f"Wrote src/templates.js ({len(js) // 1024} KB) for Bambu Studio {app_version}")
    shutil.rmtree(work, ignore_errors=True)


# --------------------------------------------------------------------------- website
APPS = os.path.join(ROOT, "apps")

# Shared bar at the top of every page, so trainers can jump between the tools.
NAV_CSS = """<style id="fc-nav-style">
:root { --fc-nav-h: 36px; }
.fc-nav { flex: none; position: relative; z-index: 1000; box-sizing: border-box; height: var(--fc-nav-h); margin: 0;
  display: flex; align-items: center; gap: 2px; padding: 0 10px; background: #13261B; color: #EFE9DC;
  font: 500 13px/1 system-ui, -apple-system, "Segoe UI", sans-serif; overflow-x: auto; white-space: nowrap; scrollbar-width: none; }
.fc-nav::-webkit-scrollbar { display: none; }
.fc-nav .fc-brand { font-weight: 700; margin-right: 10px; letter-spacing: .02em; }
.fc-nav .fc-brand span { color: #D4A843; }
.fc-nav a { color: inherit; text-decoration: none; padding: 6px 10px; border-radius: 6px; opacity: .78; }
.fc-nav a:hover { opacity: 1; background: rgba(255, 255, 255, .08); }
.fc-nav a[aria-current="page"] { opacity: 1; background: rgba(212, 168, 67, .2); color: #F3D68A; font-weight: 650; }
</style>"""


def load_apps():
    path = os.path.join(APPS, "apps.json")
    return json.load(open(path, encoding="utf-8")) if os.path.exists(path) else []


def nav_html(apps, current, base):
    links = [("", "Name Plate Slicer")] + [(a["folder"] + "/", a["title"]) for a in apps]
    out = []
    for href, title in links:
        cur = ' aria-current="page"' if href == current else ""
        out.append(f'<a href="{base}{href}"{cur}>{title}</a>')
    return (NAV_CSS + '\n<nav class="fc-nav" aria-label="Forgecraft tools"><span class="fc-brand">Forge<span>craft</span></span>'
            + "".join(out) + "</nav>\n")


def inject(html, head_extra, body_extra):
    """Add tags just before </head> and just after <body ...>, leaving the page itself untouched."""
    html = re.sub(r"</head>", lambda m: head_extra + "\n</head>", html, count=1, flags=re.I) \
        if re.search(r"</head>", html, re.I) else head_extra + html
    m = re.search(r"<body[^>]*>", html, re.I)
    return html[:m.end()] + "\n" + body_extra + html[m.end():] if m else body_extra + html


def bundle_site():
    html = open(os.path.join(SRC, "index.html"), encoding="utf-8").read()

    def inline(m):
        code = open(os.path.join(SRC, m.group(1)), encoding="utf-8").read().replace("</script", "<\\/script")
        return f"<script>/* {m.group(1)} */\n{code}\n</script>"

    html = re.sub(r'<script src="([^"]+\.js)"></script>', inline, html)
    stamp = {"checked": datetime.date.today().isoformat()}
    if os.environ.get("SITE_URL"):
        stamp["site"] = os.environ["SITE_URL"]
    html = html.replace("<!--BUILD-->", "<script>var FORGECRAFT_BUILD = " + json.dumps(stamp) + ";</script>")
    apps = load_apps()
    html = inject(html, "", nav_html(apps, "", "./"))
    if os.path.isdir(SITE):  # empty it (deleting the folder itself fails while a local preview server uses it)
        for e in os.listdir(SITE):
            p = os.path.join(SITE, e)
            shutil.rmtree(p) if os.path.isdir(p) else os.remove(p)
    os.makedirs(os.path.join(SITE, "icons"), exist_ok=True)
    open(os.path.join(SITE, "index.html"), "w", encoding="utf-8").write(html)

    # the other tools: copied as they come from Claude, plus the shared bar, app icon and offline support
    shell = []
    head = ('<link rel="manifest" href="../manifest.webmanifest">\n<meta name="theme-color" content="#13261B">\n'
            '<link rel="icon" type="image/png" href="../icons/icon-192.png">\n<link rel="apple-touch-icon" href="../icons/icon-192.png">')
    sw_reg = ("<script>if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) "
              "navigator.serviceWorker.register('../sw.js', { scope: '../' }).catch(function () {});</script>\n")
    for a in apps:
        src_dir, out_dir = os.path.join(APPS, a["folder"]), os.path.join(SITE, a["folder"])
        shutil.copytree(src_dir, out_dir)
        page = os.path.join(out_dir, "index.html")
        text = open(page, encoding="utf-8").read()
        # small wording fixes for the website (skipped quietly if a newer version no longer has the text)
        for old, new in a.get("replace", []):
            text = text.replace(old, new)
        open(page, "w", encoding="utf-8").write(inject(text, head, nav_html(apps, a["folder"] + "/", "../") + sw_reg))
        for f in sorted(os.listdir(out_dir)):
            shell.append("./" + a["folder"] + "/" + ("" if f == "index.html" else f))

    # offline cache version changes whenever any page or file changes
    digest = hashlib.sha1()
    for dirpath, _, files in sorted(os.walk(SITE)):
        for f in sorted(files):
            digest.update(open(os.path.join(dirpath, f), "rb").read())
    version = digest.hexdigest()[:12]
    sw = open(os.path.join(SRC, "sw.js"), encoding="utf-8").read().replace("__VERSION__", version) \
        .replace("/*__APP_FILES__*/", "".join(", " + json.dumps(s) for s in shell))
    open(os.path.join(SITE, "sw.js"), "w", encoding="utf-8").write(sw)
    shutil.copyfile(os.path.join(SRC, "manifest.webmanifest"), os.path.join(SITE, "manifest.webmanifest"))
    for f in glob.glob(os.path.join(SRC, "icons", "*.png")):
        shutil.copyfile(f, os.path.join(SITE, "icons", os.path.basename(f)))
    open(os.path.join(SITE, ".nojekyll"), "w").close()
    log(f"Wrote site/ (index.html {len(html) // 1024} KB, {len(apps)} other tools, version {version}, checked {stamp['checked']})")


def update_build_info(force=False):
    """Commit-worthy heartbeat (keeps GitHub's weekly schedule alive)."""
    today = datetime.date.today()
    tpl = open(TEMPLATES_JS, encoding="utf-8").read()
    m = re.search(r'"bambuStudio":"([^"]*)"', tpl)
    info = {"bambuStudio": m.group(1) if m else "?", "lastCheck": today.isoformat()}
    old = {}
    if os.path.exists(BUILD_INFO):
        try:
            old = json.load(open(BUILD_INFO, encoding="utf-8"))
        except Exception:
            old = {}
    stale = True
    try:
        stale = (today - datetime.date.fromisoformat(old.get("lastCheck", "2000-01-01"))).days >= 25
    except ValueError:
        pass
    if force or stale or old.get("bambuStudio") != info["bambuStudio"]:
        json.dump(info, open(BUILD_INFO, "w", encoding="utf-8"), indent=2)
        log("Updated build-info.json")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Build Forgecraft Slicer")
    ap.add_argument("--html-only", action="store_true", help="only re-bundle the website")
    ap.add_argument("--import-presets", action="store_true", help="copy Name Plate presets from this PC into presets/")
    ap.add_argument("--bambu", help="Bambu Studio folder or bambu-studio.exe")
    ap.add_argument("--profiles", help="Bambu printer profile folder (…/profiles/BBL)")
    ap.add_argument("--heartbeat", action="store_true", help="update build-info.json if older than 25 days")
    a = ap.parse_args()
    if a.import_presets:
        import_presets()
        sys.exit(0)
    if not a.html_only:
        build_templates(a.bambu, a.profiles)
    if a.heartbeat or not a.html_only:
        update_build_info(force=not a.html_only)
    bundle_site()
