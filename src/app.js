/* Forgecraft Slicer - page logic */
(function () {
  'use strict';
  var T = window.FORGECRAFT_TEMPLATES, C = window.ForgecraftCore;
  var $ = function (id) { return document.getElementById(id); };

  // ---------------------------------------------------------------- settings memory
  var store = {
    get: function (k, d) { try { var v = localStorage.getItem('forgecraft.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem('forgecraft.' + k, JSON.stringify(v)); } catch (e) { } }
  };
  var palette = (T.palette || []).map(function (p) { return { name: p[0], hex: p[1] }; });
  function colourName(hex) {
    hex = (hex || '').toUpperCase();
    for (var i = 0; i < palette.length; i++) if (palette[i].hex === hex) return palette[i].name;
    return 'Custom ' + hex;
  }
  var state = {
    printer: T.printers[store.get('printer', 'A1')] ? store.get('printer', 'A1') : T.order[0],
    colors: store.get('colors', { base: '#FFFFFF', letter: '#0A2989' }),
    singleSlot: store.get('singleSlot', 'base'),
    models: [],
    group: 'nameplate',
    plate: 0,
    openPalette: null,
    hover: null,
    selected: null
  };
  var nextId = 1;
  function P() { return T.printers[state.printer]; }

  // ---------------------------------------------------------------- viewer
  var viewer = null;
  try {
    viewer = new ForgecraftViewer($('view'), { onPick: onPick, onHover: onHover });
  } catch (e) {
    $('empty').innerHTML = '<div><b>3D preview not available</b>This browser has WebGL turned off. Downloads still work.</div>';
  }

  // ---------------------------------------------------------------- printer buttons
  function amsName(p) { return p.slots.base === 2 ? 'AMS lite' : p.nozzles > 1 ? (p.extruder === 2 ? 'right nozzle' : 'main nozzle') : 'AMS'; }
  function renderPrinters() {
    var box = $('printers');
    box.innerHTML = '';
    T.order.forEach(function (k) {
      var p = T.printers[k], b = document.createElement('button');
      b.className = 'pbtn'; b.type = 'button';
      b.setAttribute('aria-pressed', String(k === state.printer));
      b.innerHTML = '<b>' + p.label + '</b><small>' + amsName(p) + '</small>';
      b.onclick = function () { state.printer = k; store.set('printer', k); state.plate = 0; refresh(true); };
      box.appendChild(b);
    });
    var p = P();
    var where = p.nozzles > 1 ? (p.extruder === 2 ? ' on the <strong>right nozzle</strong>' : ' on the <strong>main nozzle</strong>') : '';
    $('slotnote').innerHTML = (p.slots.base === 2 ? 'AMS lite' : 'AMS') + ': base in <strong>slot ' + p.slots.base +
      '</strong>, letters in <strong>slot ' + p.slots.letter + '</strong>' + where + '.';
  }

  // ---------------------------------------------------------------- colours
  function renderColours() {
    var p = P(), box = $('colours');
    box.innerHTML = '';
    [['base', 'Base', 'colour 1', p.slots.base], ['letter', 'Letters', 'colour 2', p.slots.letter]].forEach(function (r) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'crow';
      b.setAttribute('aria-expanded', String(state.openPalette === r[0]));
      b.innerHTML = '<span class="swatch" style="background:' + state.colors[r[0]] + '"></span>' +
        '<span class="txt"><span class="role">' + r[1] + ' · ' + r[2] + '</span><span class="cname">' + colourName(state.colors[r[0]]) + '</span></span>' +
        '<span class="chip">AMS slot ' + r[3] + '</span>';
      b.onclick = function () { state.openPalette = state.openPalette === r[0] ? null : r[0]; renderColours(); };
      box.appendChild(b);
    });
    var pal = $('palette');
    if (!state.openPalette) { pal.hidden = true; return; }
    pal.hidden = false;
    var role = state.openPalette, cur = state.colors[role].toUpperCase();
    var html = '<div class="palette" role="radiogroup">';
    palette.forEach(function (c) {
      html += '<button type="button" role="radio" title="' + c.name + '" aria-label="' + c.name + '" aria-checked="' + (c.hex === cur) +
        '" data-hex="' + c.hex + '" style="background:' + c.hex + '"></button>';
    });
    html += '</div><div class="palette-foot"><span>Bambu PLA colours. Pick what is loaded in the AMS.</span>' +
      '<label>Custom <input type="color" id="customColour" value="' + cur.toLowerCase() + '"></label></div>';
    pal.innerHTML = html;
    pal.querySelectorAll('button[data-hex]').forEach(function (b) {
      b.onclick = function () { setColour(role, b.getAttribute('data-hex')); state.openPalette = null; renderColours(); };
    });
    $('customColour').oninput = function (e) { setColour(role, e.target.value.toUpperCase()); };
    $('customColour').onchange = function () { state.openPalette = null; renderColours(); };
  }
  function setColour(role, hex) {
    state.colors[role] = hex;
    store.set('colors', state.colors);
    renderColoursLight();
    recolourAll();
    renderLegend();
  }
  function renderColoursLight() {
    var rows = $('colours').querySelectorAll('.crow');
    ['base', 'letter'].forEach(function (r, i) {
      if (!rows[i]) return;
      rows[i].querySelector('.swatch').style.background = state.colors[r];
      rows[i].querySelector('.cname').textContent = colourName(state.colors[r]);
    });
  }

  // ---------------------------------------------------------------- models
  function cleanName(name) {
    return name.replace(/\.stl$/i, '').replace(/\s*\(\d+\)$/, '').trim() || 'model';
  }
  function addFiles(list) {
    var files = Array.prototype.slice.call(list || []);
    var bad = files.filter(function (f) { return !/\.stl$/i.test(f.name); });
    files = files.filter(function (f) { return /\.stl$/i.test(f.name); });
    if (bad.length) showStatus('Only STL files can be added (skipped ' + bad.map(function (f) { return f.name; }).join(', ') + ').', true);
    if (!files.length) return;
    $('busy').classList.add('on');
    var i = 0;
    (function next() {
      if (i >= files.length) { $('busy').classList.remove('on'); refresh(true); return; }
      var f = files[i++];
      $('busy').textContent = 'Reading ' + f.name + '…';
      f.arrayBuffer().then(function (buf) {
        return new Promise(function (res) { setTimeout(function () { res(buf); }, 20); });
      }).then(function (buf) {
        var prep = C.prepareModel(C.buildMesh(C.parseSTL(buf)));
        var an = prep.analysis, nf = prep.mesh.F.length / 3;
        var owner = new Int32Array(nf).fill(-1);
        an.regions.forEach(function (r) { r.walls.forEach(function (fi) { owner[fi] = r.id; }); });
        var b = C.bbox(prep.mesh.V);
        var m = {
          id: nextId++, file: f.name, name: cleanName(f.name), mesh: prep.mesh, an: an, owner: owner,
          mode: an.kind, size: [b[3] - b[0], b[4] - b[1], b[5] - b[2]]
        };
        state.models.push(m);
        state.group = m.mode; state.plate = 0; state.selected = m.id;
        next();
      }).catch(function (e) {
        showStatus('Could not read ' + f.name + ': ' + e.message, true);
        next();
      });
    })();
  }
  function letterCount(m) { return m.an.regions.filter(function (r) { return r.paint; }).length; }
  function modelNotes(m) {
    if (m.mode !== 'nameplate') return '';
    var n = letterCount(m);
    if (!n) return '<div class="note warn">No letter tops coloured. Click the letters in the preview.</div>';
    var hs = {};
    m.an.regions.forEach(function (r) { if (r.paint) hs[r.z.toFixed(1)] = 1; });
    var odd = Object.keys(hs).filter(function (z) { return Math.abs(+z - 6) > 0.05; });
    if (odd.length) return '<div class="note warn">Letter tops at ' + odd.join(', ') + ' mm (template is 6 mm). Check the preview.</div>';
    return '';
  }
  function renderModels() {
    var box = $('models');
    box.innerHTML = '';
    state.models.forEach(function (m) {
      var d = document.createElement('div');
      d.className = 'model' + (m.id === state.selected ? ' sel' : '');
      var n = letterCount(m);
      var meta = m.size.map(function (v) { return Math.round(v); }).join(' × ') + ' mm';
      if (m.mode === 'nameplate') meta = n + ' letter part' + (n === 1 ? '' : 's') + ' · ' + meta;
      d.innerHTML = '<div class="mhead"><span class="mname" title="' + m.file + '">' + m.file + '</span>' +
        '<button class="xbtn" type="button" title="Remove" aria-label="Remove ' + m.file + '">×</button></div>' +
        '<div class="mrow"><span class="seg"><button type="button" data-mode="nameplate" aria-pressed="' + (m.mode === 'nameplate') + '">2 colours</button>' +
        '<button type="button" data-mode="single" aria-pressed="' + (m.mode === 'single') + '">1 colour</button></span>' +
        '<span class="mmeta">' + meta + '</span></div>' + modelNotes(m);
      d.querySelector('.xbtn').onclick = function () {
        state.models = state.models.filter(function (x) { return x !== m; });
        state.plate = 0; refresh(true);
      };
      d.querySelectorAll('.seg button').forEach(function (b) {
        b.onclick = function () {
          m.mode = b.getAttribute('data-mode'); state.group = m.mode; state.plate = 0; state.selected = m.id; refresh(true);
        };
      });
      d.onclick = function (e) {
        if (e.target.closest('button')) return;
        state.selected = m.id;
        if (state.group !== m.mode) { state.group = m.mode; state.plate = 0; refresh(true); } else renderModels();
      };
      box.appendChild(d);
    });
    $('mcount').textContent = state.models.length ? state.models.length : '';
    $('dropBtn').hidden = state.models.length > 0;
    $('addMore').hidden = state.models.length === 0;
  }

  function groupModels(g) { return state.models.filter(function (m) { return m.mode === g; }); }

  // ---------------------------------------------------------------- layout + preview
  var scene = { plates: [], placed: {}, unplaced: [] };
  function computeLayout() {
    var p = P(), ms = groupModels(state.group);
    var placed = ms.map(function (m) { return C.placeable(m.mesh, p); });
    var lay = C.layout(placed.map(function (pl) { return { w: pl.w, d: pl.d }; }), p, { tower: state.group === 'nameplate' });
    scene = { models: ms, placed: placed, plates: lay.plates, unplaced: lay.unplaced.map(function (i) { return ms[i]; }) };
    if (state.plate >= scene.plates.length) state.plate = Math.max(0, scene.plates.length - 1);
  }
  function rgb(hex) { var c = hex.replace('#', ''); return [parseInt(c.substr(0, 2), 16) / 255, parseInt(c.substr(2, 2), 16) / 255, parseInt(c.substr(4, 2), 16) / 255]; }
  function faceColours(m) {
    var nf = m.mesh.F.length / 3, out = new Float32Array(nf * 3);
    var base = rgb(m.mode === 'single' && state.singleSlot === 'letter' ? state.colors.letter : state.colors.base);
    var letter = rgb(state.colors.letter);
    var flags = m.mode === 'nameplate' ? C.paintFlags(m.mesh, m.an) : null;
    var hoverRegion = state.hover && state.hover.model === m.id ? state.hover.region : -1;
    for (var f = 0; f < nf; f++) {
      var c = flags && flags[f] ? letter : base;
      var r = m.an.regionOf[f] >= 0 ? m.an.regionOf[f] : m.owner[f];
      if (hoverRegion >= 0 && r === hoverRegion) {
        out[f * 3] = c[0] * 0.6 + 0.4 * 1.0; out[f * 3 + 1] = c[1] * 0.6 + 0.4 * 0.62; out[f * 3 + 2] = c[2] * 0.6 + 0.4 * 0.3;
      } else { out[f * 3] = c[0]; out[f * 3 + 1] = c[1]; out[f * 3 + 2] = c[2]; }
    }
    return out;
  }
  function renderScene() {
    var p = P();
    if (!viewer) return;
    var plate = scene.plates[state.plate];
    var items = [], boxes = [];
    if (plate) {
      plate.items.forEach(function (it) {
        var m = scene.models[it.index], pl = scene.placed[it.index];
        var V = new Float64Array(pl.V.length);
        for (var i = 0; i < V.length; i += 3) { V[i] = pl.V[i] + it.x; V[i + 1] = pl.V[i + 1] + it.y; V[i + 2] = pl.V[i + 2] + pl.h / 2; }
        items.push({ key: m.id, V: V, F: pl.F, colors: faceColours(m) });
      });
      if (plate.tower && state.group === 'nameplate') {
        var tw = p.primeTowerWidth * 0.6, h = Math.max.apply(null, plate.items.map(function (it) { return scene.placed[it.index].h; }).concat([6]));
        var x0 = plate.tower[0] + 5, y0 = plate.tower[1] + 5;
        boxes.push({ x0: x0, y0: y0, x1: x0 + tw, y1: y0 + tw * 0.75, h: Math.min(h, 6.5), color: [0.45, 0.48, 0.53] });
      }
    }
    viewer.setItems(items, boxes);
    if (state.frameNext) {
      state.frameNext = false;
      var fb = [Infinity, Infinity, -Infinity, -Infinity, 0];
      items.forEach(function (it) {
        for (var i = 0; i < it.V.length; i += 3) {
          fb[0] = Math.min(fb[0], it.V[i]); fb[2] = Math.max(fb[2], it.V[i]);
          fb[1] = Math.min(fb[1], it.V[i + 1]); fb[3] = Math.max(fb[3], it.V[i + 1]);
          fb[4] = Math.max(fb[4], it.V[i + 2]);
        }
      });
      boxes.forEach(function (b) { fb[0] = Math.min(fb[0], b.x0); fb[1] = Math.min(fb[1], b.y0); fb[2] = Math.max(fb[2], b.x1); fb[3] = Math.max(fb[3], b.y1); });
      if (items.length) { fb[0] -= 10; fb[1] -= 10; fb[2] += 10; fb[3] += 10; viewer.frame(fb); } else viewer.frame(null);
    }
    $('empty').hidden = state.models.length > 0;
  }
  function recolour(m) { if (viewer) viewer.setColors(m.id, faceColours(m)); }
  function recolourAll() { groupModels(state.group).forEach(recolour); }

  function onHover(hit) {
    var next = null;
    if (hit) {
      var m = state.models.find(function (x) { return x.id === hit.key; });
      if (m && m.mode === 'nameplate') {
        var r = m.an.regionOf[hit.face] >= 0 ? m.an.regionOf[hit.face] : m.owner[hit.face];
        if (r >= 0 && r !== m.an.backing) next = { model: m.id, region: r };
      }
    }
    var prev = state.hover;
    if ((prev && next && prev.model === next.model && prev.region === next.region) || (!prev && !next)) return;
    state.hover = next;
    $('view').style.cursor = next ? 'pointer' : '';
    [prev, next].forEach(function (h) {
      if (!h) return;
      var m = state.models.find(function (x) { return x.id === h.model; });
      if (m) recolour(m);
    });
  }
  function onPick(hit) {
    if (!hit) return;
    var m = state.models.find(function (x) { return x.id === hit.key; });
    if (!m) return;
    state.selected = m.id;
    if (m.mode !== 'nameplate') { renderModels(); showStatus('This model is set to 1 colour. Switch it to "2 colours" to colour its letters.'); return; }
    var r = m.an.regionOf[hit.face] >= 0 ? m.an.regionOf[hit.face] : m.owner[hit.face];
    if (r < 0) { showStatus('Click the top of a letter to switch its colour.'); return; }
    if (r === m.an.backing) { showStatus('That is the backing plate, it always stays colour 1. Click a letter instead.'); return; }
    var reg = m.an.regions[r];
    reg.paint = !reg.paint;
    recolour(m);
    renderModels();
    renderExport();
  }

  function renderTabs() {
    var ng = groupModels('nameplate').length, ns = groupModels('single').length;
    var tabs = $('tabs');
    if (ng && ns) {
      tabs.hidden = false;
      tabs.innerHTML = '<button type="button" data-g="nameplate" aria-pressed="' + (state.group === 'nameplate') + '">2 colours (' + ng + ')</button>' +
        '<button type="button" data-g="single" aria-pressed="' + (state.group === 'single') + '">1 colour (' + ns + ')</button>';
      tabs.querySelectorAll('button').forEach(function (b) {
        b.onclick = function () { state.group = b.getAttribute('data-g'); state.plate = 0; state.frameNext = true; refresh(false); };
      });
    } else {
      tabs.hidden = true;
      if (ng) state.group = 'nameplate'; else if (ns) state.group = 'single';
    }
    var np = scene.plates.length;
    $('pnav').hidden = np < 2;
    $('plabel').textContent = 'Plate ' + (state.plate + 1) + ' of ' + np;
    $('pprev').disabled = state.plate <= 0;
    $('pnext').disabled = state.plate >= np - 1;
  }
  function renderLegend() {
    var p = P(), lg = $('legend');
    if (!state.models.length) { lg.hidden = true; return; }
    lg.hidden = false;
    if (state.group === 'single') {
      var slot = state.singleSlot === 'letter' ? p.slots.letter : p.slots.base;
      lg.innerHTML = '<span><i style="background:' + (state.singleSlot === 'letter' ? state.colors.letter : state.colors.base) + '"></i>Whole model · AMS slot ' + slot + '</span>';
    } else {
      lg.innerHTML = '<span><i style="background:' + state.colors.base + '"></i>Base · slot ' + p.slots.base + '</span>' +
        '<span><i style="background:' + state.colors.letter + '"></i>Letters · slot ' + p.slots.letter + '</span>';
    }
  }

  // ---------------------------------------------------------------- export
  function renderExport() {
    var p = P(), box = $('export');
    box.innerHTML = '';
    var groups = [['nameplate', groupModels('nameplate')], ['single', groupModels('single')]];
    groups.forEach(function (g) {
      if (!g[1].length) return;
      var isNP = g[0] === 'nameplate';
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'dl' + (groups[0][1].length && !isNP ? ' secondary' : '');
      var count = g[1].length > 1 ? ' (' + g[1].length + ')' : '';
      var slots = isNP ? 'base slot ' + p.slots.base + ', letters slot ' + p.slots.letter
        : 'slot ' + (state.singleSlot === 'letter' ? p.slots.letter : p.slots.base);
      b.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/></svg>' +
        '<span><b>Download ' + (isNP ? 'name plate' : '1-colour') + ' project' + count + '</b>' +
        '<small>' + p.label + ' · ' + (isNP ? p.namePlateProcess : '0.20mm Standard') + ' · ' + slots + '</small></span>';
      b.onclick = function () { doExport(g[0], b); };
      box.appendChild(b);
      if (!isNP) {
        var sel = document.createElement('div');
        sel.className = 'mrow';
        sel.innerHTML = '<span class="mmeta">1-colour models print in</span><span class="seg">' +
          '<button type="button" data-s="base" aria-pressed="' + (state.singleSlot === 'base') + '">colour 1 (slot ' + p.slots.base + ')</button>' +
          '<button type="button" data-s="letter" aria-pressed="' + (state.singleSlot === 'letter') + '">colour 2 (slot ' + p.slots.letter + ')</button></span>';
        sel.querySelectorAll('button').forEach(function (sb) {
          sb.onclick = function () { state.singleSlot = sb.getAttribute('data-s'); store.set('singleSlot', state.singleSlot); renderExport(); renderLegend(); recolourAll(); };
        });
        box.appendChild(sel);
      }
    });
    if (scene.unplaced && scene.unplaced.length) {
      var w = document.createElement('div');
      w.className = 'note warn';
      w.textContent = scene.unplaced.map(function (m) { return m.file; }).join(', ') + ' will not fit on the ' + p.label + ' bed and is left out.';
      box.appendChild(w);
    }
  }

  function deflateRaw(data) {
    if (typeof CompressionStream === 'undefined') return null;
    var cs = new CompressionStream('deflate-raw');
    var stream = new Blob([data]).stream().pipeThrough(cs);
    return new Response(stream).arrayBuffer().then(function (b) { return new Uint8Array(b); });
  }
  function safe(s) { return s.replace(/[<>:"\/\\|?*\u0000-\u001F]/g, '').trim(); }
  function doExport(group, btn) {
    var p = P(), ms = groupModels(group);
    if (!ms.length) return;
    if (group === 'nameplate' && ms.every(function (m) { return !letterCount(m); })) {
      showStatus('No letters are coloured yet. Click the letter tops in the preview first.', true);
      return;
    }
    btn.disabled = true;
    var names = ms.map(function (m) { return m.name; });
    var title = names.length === 1 ? names[0] : names.length + (group === 'nameplate' ? ' name plates' : ' models');
    var fname = safe(title + ' - ' + p.label + (group === 'single' ? ' - 1 colour' : '')) + '.3mf';
    var job = {
      printer: p, meta: T, mode: group, title: title,
      colors: { base: state.colors.base, letter: state.colors.letter },
      singleSlot: state.singleSlot, bedType: 'Textured PEI Plate',
      objects: ms.map(function (m) {
        return { name: m.file, mesh: m.mesh, paint: group === 'nameplate' ? C.paintFlags(m.mesh, m.an) : null };
      })
    };
    C.build3MF(job, typeof CompressionStream !== 'undefined' ? deflateRaw : null).then(function (r) {
      var blob = new Blob([r.zip], { type: 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = fname;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 30000);
      var plates = r.plates.length;
      showStatus('Saved "' + fname + '"' + (plates > 1 ? ' with ' + plates + ' plates' : '') + '. Open it to load it in Bambu Studio.');
    }).catch(function (e) {
      showStatus('Could not build the project: ' + e.message, true);
    }).then(function () { btn.disabled = false; });
  }

  var statusTimer = 0;
  function showStatus(msg, err) {
    var s = $('status');
    s.hidden = false; s.textContent = msg; s.className = 'status' + (err ? ' err' : '');
    clearTimeout(statusTimer);
    statusTimer = setTimeout(function () { s.hidden = true; }, err ? 9000 : 12000);
  }

  // ---------------------------------------------------------------- refresh
  function refresh(resetCamera) {
    var p = P();
    renderPrinters();
    renderColours();
    renderTabs();
    computeLayout();
    renderTabs();
    renderModels();
    renderExport();
    renderLegend();
    if (viewer) {
      if (resetCamera || viewer._bedKey !== p.key) { viewer.setBed(p.bedSize, p.bed, p.exclude); viewer._bedKey = p.key; state.frameNext = true; }
      renderScene();
    }
  }

  // ---------------------------------------------------------------- wiring
  $('dropBtn').onclick = $('addMore').onclick = function () { $('fileInput').click(); };
  $('fileInput').onchange = function (e) { addFiles(e.target.files); e.target.value = ''; };
  $('vReset').onclick = function () { viewer && viewer.resetView(); };
  $('vTop').onclick = function () { viewer && viewer.topView(); };
  $('pprev').onclick = function () { if (state.plate > 0) { state.plate--; state.frameNext = true; renderTabs(); renderScene(); } };
  $('pnext').onclick = function () { if (state.plate < scene.plates.length - 1) { state.plate++; state.frameNext = true; renderTabs(); renderScene(); } };
  // ---------------------------------------------------------------- freshness, install, offline
  var BUILD = window.FORGECRAFT_BUILD || { checked: T.generated };
  $('tplinfo').textContent = 'Printer settings from Bambu Studio ' + (T.bambuStudio || '?') + ', built ' + T.generated +
    ', last checked ' + BUILD.checked + '.';
  (function staleCheck() {
    var checked = new Date(BUILD.checked + 'T00:00:00');
    var days = Math.floor((Date.now() - checked.getTime()) / 86400000);
    var box = $('stale'), msg = '';
    if (location.protocol === 'file:' && BUILD.site) {
      msg = 'This is an offline copy. The always-up-to-date version is at <b>' + BUILD.site.replace(/^https?:\/\//, '') + '</b>.';
    }
    if (days > 35) {
      msg = 'Printer settings were last checked <b>' + days + ' days ago</b> (' + BUILD.checked + '). Files still work, ' +
        'but please tell the Forgecraft admin so they can check the automatic update on GitHub.' + (msg ? ' ' + msg : '');
    }
    if (msg) { box.innerHTML = msg; box.hidden = false; }
  })();
  var installEvt = null;
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); installEvt = e; $('installBtn').hidden = false; });
  window.addEventListener('appinstalled', function () { $('installBtn').hidden = true; installEvt = null; });
  $('installBtn').onclick = function () {
    if (!installEvt) return;
    installEvt.prompt();
    installEvt.userChoice.then(function () { installEvt = null; $('installBtn').hidden = true; });
  };
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('sw.js').catch(function () { });
  }
  var dz = $('dropzone'), dragDepth = 0;
  window.addEventListener('dragenter', function (e) { e.preventDefault(); dragDepth++; dz.classList.add('on'); });
  window.addEventListener('dragleave', function () { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dz.classList.remove('on'); });
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) {
    e.preventDefault(); dragDepth = 0; dz.classList.remove('on');
    if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && state.openPalette) { state.openPalette = null; renderColours(); }
  });

  window.ForgecraftApp = { state: state, addFiles: addFiles, refresh: refresh, viewer: viewer, scene: function () { return scene; } };
  refresh(true);
})();
