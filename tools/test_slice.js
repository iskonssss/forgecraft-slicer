/*
 * Slicing check: STL -> Forgecraft 3MF -> Bambu Studio command line -> pass/fail.
 *
 *   node tools/test_slice.js [--bambu <folder|exe>] [--printers all|A1,H2D] [--mode nameplate|single|auto]
 *                            [--expect-letters N] [--out <folder>] file.stl [more.stl ...]
 *
 * Exits with code 1 if any printer fails, so the GitHub build will not publish.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const core = require('../src/core.js');
const T = require('../src/templates.js');

// ---------------------------------------------------------------- args
const opts = { printers: 'all', mode: 'auto', out: path.join(os.tmpdir(), 'forgecraft-test'), bambu: process.env.BAMBU_STUDIO || '', expect: null };
const files = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--printers') opts.printers = argv[++i];
  else if (a === '--mode') opts.mode = argv[++i];
  else if (a === '--out') opts.out = argv[++i];
  else if (a === '--bambu') opts.bambu = argv[++i];
  else if (a === '--expect-letters') opts.expect = +argv[++i];
  else files.push(a);
}
if (!files.length) { console.log('usage: node tools/test_slice.js [--printers all] [--mode auto] [--expect-letters N] file.stl'); process.exit(2); }

function findExe(p) {
  const cands = [p, 'C:\\Program Files\\Bambu Studio\\bambu-studio.exe'].filter(Boolean);
  for (const c of cands) {
    if (!fs.existsSync(c)) continue;
    if (fs.statSync(c).isFile()) return c;
    const stack = [c];
    while (stack.length) {
      const d = stack.pop();
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isFile() && e.name.toLowerCase() === 'bambu-studio.exe') return f;
        if (e.isDirectory()) stack.push(f);
      }
    }
  }
  return null;
}
const EXE = findExe(opts.bambu);
if (!EXE) { console.log('Bambu Studio not found (use --bambu)'); process.exit(2); }
fs.mkdirSync(opts.out, { recursive: true });

// ---------------------------------------------------------------- models
let failures = 0;
const objects = files.map(f => {
  const buf = fs.readFileSync(f);
  const prep = core.prepareModel(core.buildMesh(core.parseSTL(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length))));
  const an = prep.analysis;
  const letters = an.regions.filter(r => r.paint).length;
  console.log(`# ${path.basename(f)}: ${prep.mesh.F.length / 3} triangles, kind=${an.kind}, letters=${letters}`);
  if (opts.expect !== null && letters !== opts.expect) {
    console.log(`FAIL letter detection: expected ${opts.expect} letters, found ${letters}`);
    failures++;
  }
  return { name: path.basename(f), mesh: prep.mesh, paint: core.paintFlags(prep.mesh, an), kind: an.kind };
});

// ---------------------------------------------------------------- slice
(async () => {
  const keys = opts.printers === 'all' ? T.order : opts.printers.split(',');
  for (const key of keys) {
    const P = T.printers[key];
    if (!P) { console.log(`FAIL unknown printer ${key}`); failures++; continue; }
    const mode = opts.mode === 'auto' ? (objects.some(o => o.kind === 'nameplate') ? 'nameplate' : 'single') : opts.mode;
    const job = {
      printer: P, meta: T, mode, title: 'test',
      colors: { base: '#FFFFFF', letter: '#0A2989' },
      objects: objects.map(o => ({ name: o.name, mesh: o.mesh, paint: o.paint }))
    };
    const r = core.build3MFFiles(job);
    const zip = await core.makeZip(r.files, d => zlib.deflateRawSync(d));
    const base = `${key}_${mode}`;
    const f3mf = path.join(opts.out, base + '.3mf');
    fs.writeFileSync(f3mf, zip);
    const sliceDir = path.join(opts.out, base);
    fs.rmSync(sliceDir, { recursive: true, force: true });
    fs.mkdirSync(sliceDir);
    let code = 0;
    try {
      execFileSync(EXE, ['--slice', '0', '--outputdir', sliceDir, '--export-3mf', 'sliced.gcode.3mf', f3mf], { stdio: 'ignore', timeout: 300000 });
    } catch (e) { code = e.status; }
    let res = {};
    try { res = JSON.parse(fs.readFileSync(path.join(sliceDir, 'result.json'), 'utf8')); } catch (e) { }
    const plates = res.sliced_plates || [];
    const problems = [];
    if (code !== 0 || res.return_code !== 0) problems.push(`slicing failed (exit ${code}: ${res.error_string || 'no result'})`);
    if (r.unplaced.length) problems.push(`${r.unplaced.length} model(s) did not fit`);
    let summary = '';
    plates.forEach(p => {
      const fil = (p.filaments || []);
      summary += ` | plate ${p.id}: ${Math.round(p.main_predication / 60)} min, changes=${p.filament_change_times}, ` +
        fil.map(f => `F${f.id}:${f.main_used_g.toFixed(2)}g`).join(' ');
      const letter = fil.find(f => f.id === P.slots.letter);
      const baseF = fil.find(f => f.id === (mode === 'single' ? P.slots.base : P.slots.base));
      if (!baseF) problems.push(`plate ${p.id}: base filament ${P.slots.base} not used`);
      if (mode === 'nameplate') {
        if (!letter || letter.main_used_g < 0.05) problems.push(`plate ${p.id}: letter filament ${P.slots.letter} not used`);
        if (p.filament_change_times > 4) problems.push(`plate ${p.id}: ${p.filament_change_times} colour changes (expected 2)`);
      } else if (letter) problems.push(`plate ${p.id}: single-colour print used the letter filament`);
    });
    if (!plates.length && !problems.length) problems.push('no plates sliced');
    if (problems.length) failures++;
    console.log(`${problems.length ? 'FAIL' : 'ok  '} ${key.padEnd(4)} ${mode.padEnd(9)}${summary}${problems.length ? '  <-- ' + problems.join('; ') : ''}`);
  }
  console.log(failures ? `\n${failures} problem(s) found` : '\nAll printers passed');
  process.exit(failures ? 1 : 0);
})();
