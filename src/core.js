/*
 * Forgecraft Slicer - core
 * STL reading, letter detection, plate layout and Bambu Studio 3MF writing.
 * Works in the browser (window.ForgecraftCore) and in Node (require).
 */
var ForgecraftCore = (function () {
  'use strict';

  // ------------------------------------------------------------------ STL
  function parseSTL(buffer) {
    var bytes = new Uint8Array(buffer);
    var dv = new DataView(buffer instanceof ArrayBuffer ? buffer : bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length >= 84) {
      var n = dv.getUint32(80, true);
      if (84 + n * 50 === bytes.length) {
        var pos = new Float32Array(n * 9);
        for (var i = 0; i < n; i++) {
          var o = 84 + i * 50 + 12;
          for (var k = 0; k < 9; k++) pos[i * 9 + k] = dv.getFloat32(o + k * 4, true);
        }
        return pos;
      }
    }
    // ASCII
    var text = '';
    var CH = 1 << 16;
    for (var s = 0; s < bytes.length; s += CH) text += String.fromCharCode.apply(null, bytes.subarray(s, Math.min(bytes.length, s + CH)));
    if (!/facet/i.test(text)) throw new Error('Not an STL file');
    var re = /vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g, m, arr = [];
    while ((m = re.exec(text))) arr.push(+m[1], +m[2], +m[3]);
    if (!arr.length || arr.length % 9) throw new Error('Could not read STL triangles');
    return new Float32Array(arr);
  }

  // weld duplicate vertices, drop degenerate triangles
  function buildMesh(pos) {
    var nt = pos.length / 9, map = new Map(), V = [], F = [];
    var q = 1e4;
    function vid(x, y, z) {
      var key = Math.round(x * q) + ',' + Math.round(y * q) + ',' + Math.round(z * q);
      var id = map.get(key);
      if (id === undefined) { id = V.length / 3; V.push(x, y, z); map.set(key, id); }
      return id;
    }
    for (var t = 0; t < nt; t++) {
      var o = t * 9;
      var a = vid(pos[o], pos[o + 1], pos[o + 2]);
      var b = vid(pos[o + 3], pos[o + 4], pos[o + 5]);
      var c = vid(pos[o + 6], pos[o + 7], pos[o + 8]);
      if (a === b || b === c || a === c) continue;
      F.push(a, b, c);
    }
    return { V: new Float64Array(V), F: new Uint32Array(F) };
  }

  /*
   * Cut every triangle that crosses the horizontal plane z = c, so faces can be
   * painted exactly above that height (like Bambu's "fill by height range").
   * Shared edges get the same new vertex, so the mesh stays watertight.
   */
  function cutMesh(mesh, planes) {
    var V = Array.from(mesh.V), F = Array.from(mesh.F), eps = 1e-5;
    planes.forEach(function (c) {
      var cache = new Map(), nv0 = V.length / 3, out = [];
      function cut(i, j) {
        var k = i < j ? i * 4294967296 + j : j * 4294967296 + i, id = cache.get(k);
        if (id !== undefined) return id;
        var zi = V[i * 3 + 2], zj = V[j * 3 + 2], t = (c - zi) / (zj - zi);
        id = V.length / 3;
        V.push(V[i * 3] + (V[j * 3] - V[i * 3]) * t, V[i * 3 + 1] + (V[j * 3 + 1] - V[i * 3 + 1]) * t, c);
        cache.set(k, id);
        return id;
      }
      for (var f = 0; f < F.length; f += 3) {
        var t = [F[f], F[f + 1], F[f + 2]];
        var s = t.map(function (v) { var z = V[v * 3 + 2]; return z > c + eps ? 1 : z < c - eps ? -1 : 0; });
        var hasAbove = s.indexOf(1) >= 0, hasBelow = s.indexOf(-1) >= 0;
        if (!(hasAbove && hasBelow)) { out.push(t[0], t[1], t[2]); continue; }
        var on = s.indexOf(0);
        if (on >= 0) {
          var v0 = t[on], v1 = t[(on + 1) % 3], v2 = t[(on + 2) % 3], p = cut(v1, v2);
          out.push(v0, v1, p, v0, p, v2);
        } else {
          // the vertex that is alone on its side goes first
          var lone = s[0] === s[1] ? 2 : s[0] === s[2] ? 1 : 0;
          var a = t[lone], b = t[(lone + 1) % 3], d = t[(lone + 2) % 3];
          var pab = cut(a, b), pad = cut(a, d);
          out.push(a, pab, pad, pab, b, d, pab, d, pad);
        }
      }
      F = out;
    });
    return { V: new Float64Array(V), F: new Uint32Array(F) };
  }

  function bbox(V) {
    var b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (var i = 0; i < V.length; i += 3) {
      for (var k = 0; k < 3; k++) {
        if (V[i + k] < b[k]) b[k] = V[i + k];
        if (V[i + k] > b[k + 3]) b[k + 3] = V[i + k];
      }
    }
    return b;
  }

  // ------------------------------------------------------------------ analysis
  /*
   * Finds flat, upward-facing top surfaces and decides which of them are
   * "letters": a top surface whose edges drop down onto another surface
   * (raised text sitting on the base plate). Surfaces whose edges drop all the
   * way to the print bed (keyring loop, plate edge, stand) stay base colour.
   */
  function analyze(mesh, opts) {
    opts = opts || {};
    var band = opts.band || 0.56;             // coloured depth = 2 layers x 0.28 mm
    var letterTop = opts.letterTop || 6.0;    // Forgecraft template letter height
    var V = mesh.V, F = mesh.F, nf = F.length / 3, nv = V.length / 3;
    var N = new Float64Array(nf * 3), A = new Float64Array(nf), Zc = new Float64Array(nf);
    for (var f = 0; f < nf; f++) {
      var a = F[f * 3] * 3, b = F[f * 3 + 1] * 3, c = F[f * 3 + 2] * 3;
      var ux = V[b] - V[a], uy = V[b + 1] - V[a + 1], uz = V[b + 2] - V[a + 2];
      var vx = V[c] - V[a], vy = V[c + 1] - V[a + 1], vz = V[c + 2] - V[a + 2];
      var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      var l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      N[f * 3] = nx / l; N[f * 3 + 1] = ny / l; N[f * 3 + 2] = nz / l;
      A[f] = l / 2;
      Zc[f] = (V[a + 2] + V[b + 2] + V[c + 2]) / 3;
    }
    // edge -> faces
    var edges = new Map();
    function ekey(i, j) { return i < j ? i * nv + j : j * nv + i; }
    for (f = 0; f < nf; f++) {
      for (var e = 0; e < 3; e++) {
        var i = F[f * 3 + e], j = F[f * 3 + (e + 1) % 3], k = ekey(i, j);
        var list = edges.get(k);
        if (list) list.push(f); else edges.set(k, [f]);
      }
    }
    var isUp = new Uint8Array(nf);
    for (f = 0; f < nf; f++) if (N[f * 3 + 2] > 0.9995) isUp[f] = 1;

    // grid of upward-facing faces for "what surface is below this point" queries
    var bb = bbox(V);
    var cell = Math.max(1, Math.max(bb[3] - bb[0], bb[4] - bb[1]) / 96);
    var gw = Math.ceil((bb[3] - bb[0]) / cell) + 1, gh = Math.ceil((bb[4] - bb[1]) / cell) + 1;
    var grid = new Map();
    for (f = 0; f < nf; f++) {
      if (N[f * 3 + 2] < 0.05) continue;
      var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (e = 0; e < 3; e++) {
        var vi = F[f * 3 + e] * 3;
        x0 = Math.min(x0, V[vi]); x1 = Math.max(x1, V[vi]);
        y0 = Math.min(y0, V[vi + 1]); y1 = Math.max(y1, V[vi + 1]);
      }
      var cx0 = Math.floor((x0 - bb[0]) / cell), cx1 = Math.floor((x1 - bb[0]) / cell);
      var cy0 = Math.floor((y0 - bb[1]) / cell), cy1 = Math.floor((y1 - bb[1]) / cell);
      for (var gx = cx0; gx <= cx1; gx++) for (var gy = cy0; gy <= cy1; gy++) {
        var gk = gy * gw + gx, gl = grid.get(gk);
        if (gl) gl.push(f); else grid.set(gk, [f]);
      }
    }
    function surfaceBelow(px, py, zmax) {
      var gx = Math.floor((px - bb[0]) / cell), gy = Math.floor((py - bb[1]) / cell);
      if (gx < 0 || gy < 0 || gx >= gw || gy >= gh) return null;
      var list = grid.get(gy * gw + gx);
      if (!list) return null;
      var best = null;
      for (var t = 0; t < list.length; t++) {
        var f = list[t];
        var a = F[f * 3] * 3, b = F[f * 3 + 1] * 3, c = F[f * 3 + 2] * 3;
        var ax = V[a], ay = V[a + 1], bx = V[b], by = V[b + 1], cx = V[c], cy = V[c + 1];
        var d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
        if (Math.abs(d) < 1e-12) continue;
        var w1 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / d;
        var w2 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / d;
        var w3 = 1 - w1 - w2;
        if (w1 < -1e-6 || w2 < -1e-6 || w3 < -1e-6) continue;
        var z = w1 * V[a + 2] + w2 * V[b + 2] + w3 * V[c + 2];
        if (z < zmax && (best === null || z > best)) best = z;
      }
      return best;
    }

    // grow flat regions
    var regionOf = new Int32Array(nf).fill(-1), regions = [];
    for (f = 0; f < nf; f++) {
      if (!isUp[f] || regionOf[f] >= 0) continue;
      var rid = regions.length, z0 = Zc[f], stack = [f], faces = [];
      regionOf[f] = rid;
      while (stack.length) {
        var g = stack.pop();
        faces.push(g);
        for (e = 0; e < 3; e++) {
          var nb = edges.get(ekey(F[g * 3 + e], F[g * 3 + (e + 1) % 3]));
          for (var q = 0; q < nb.length; q++) {
            var h = nb[q];
            if (h !== g && isUp[h] && regionOf[h] < 0 && Math.abs(Zc[h] - z0) < 0.01) {
              regionOf[h] = rid; stack.push(h);
            }
          }
        }
      }
      regions.push({ id: rid, z: z0, faces: faces, area: 0, supported: 0, cliff: 0, text: false, paint: false });
    }
    // classify region edges
    regions.forEach(function (r) {
      var area = 0, sup = 0, cliff = 0;
      for (var t = 0; t < r.faces.length; t++) {
        var f = r.faces[t];
        area += A[f];
        for (var e = 0; e < 3; e++) {
          var i = F[f * 3 + e], j = F[f * 3 + (e + 1) % 3];
          var nb = edges.get(ekey(i, j)), inside = false, other = -1;
          for (var q = 0; q < nb.length; q++) {
            if (nb[q] === f) continue;
            if (regionOf[nb[q]] === r.id) inside = true; else other = nb[q];
          }
          if (inside) continue;
          var ax = V[i * 3], ay = V[i * 3 + 1], bx = V[j * 3], by = V[j * 3 + 1];
          var len = Math.hypot(bx - ax, by - ay);
          if (len < 1e-6) continue;
          if (other >= 0) {
            // wall going up from this edge -> neutral
            var oa = F[other * 3] * 3, ob = F[other * 3 + 1] * 3, oc = F[other * 3 + 2] * 3;
            if (Math.max(V[oa + 2], V[ob + 2], V[oc + 2]) > r.z + 0.02) continue;
          }
          // outward = right of the directed edge (faces are counter-clockwise from above)
          var ox = (by - ay) / len, oy = -(bx - ax) / len;
          var mx = (ax + bx) / 2 + ox * 0.25, my = (ay + by) / 2 + oy * 0.25;
          var zb = surfaceBelow(mx, my, r.z - 0.05);
          if (zb !== null && zb > 0.15) sup += len; else cliff += len;
        }
      }
      r.area = area; r.supported = sup; r.cliff = cliff;
      r.score = sup + cliff > 0 ? sup / (sup + cliff) : 0;
    });

    // The backing: biggest flat top that is not itself raised text. Letters must sit over it.
    var backing = null;
    regions.forEach(function (r) {
      if (r.score < 0.6 && r.z > 0.3 && (!backing || r.area > backing.area)) backing = r;
    });
    var backBox = null;
    if (backing) {
      backBox = [Infinity, Infinity, -Infinity, -Infinity];
      backing.faces.forEach(function (f) {
        for (var e = 0; e < 3; e++) {
          var vi = F[f * 3 + e] * 3;
          backBox[0] = Math.min(backBox[0], V[vi]); backBox[2] = Math.max(backBox[2], V[vi]);
          backBox[1] = Math.min(backBox[1], V[vi + 1]); backBox[3] = Math.max(backBox[3], V[vi + 1]);
        }
      });
    }
    regions.forEach(function (r) {
      var cx = 0, cy = 0;
      r.faces.forEach(function (f) {
        for (var e = 0; e < 3; e++) { var vi = F[f * 3 + e] * 3; cx += V[vi]; cy += V[vi + 1]; }
      });
      cx /= r.faces.length * 3; cy /= r.faces.length * 3;
      r.center = [cx, cy];
      r.overBacking = !backBox || (cx >= backBox[0] - 1 && cx <= backBox[2] + 1 && cy >= backBox[1] - 1 && cy <= backBox[3] + 1);
      var atLetterHeight = Math.abs(r.z - letterTop) < 0.05;
      var raised = backing ? r.z > backing.z + 0.1 : true;
      r.text = r.area > 0.3 && r.z > 0.3 && raised && r.overBacking && (r.score >= 0.6 || (atLetterHeight && r.score >= 0.3));
      r.paint = r.text;
      r.walls = [];
    });

    // Side walls in the coloured band just under each top (to match the
    // "fill by height range" result). Only faces fully inside the band count.
    regions.forEach(function (r) {
      var zc = r.z - band - 1e-4, zt = r.z + 1e-4, seen = new Set(), stack = [];
      function okWall(f) {
        if (regionOf[f] >= 0 || N[f * 3 + 2] > 0.9995) return false;
        for (var e = 0; e < 3; e++) { var z = V[F[f * 3 + e] * 3 + 2]; if (z < zc || z > zt) return false; }
        return true;
      }
      r.faces.forEach(function (f) {
        for (var e = 0; e < 3; e++) {
          var nb = edges.get(ekey(F[f * 3 + e], F[f * 3 + (e + 1) % 3]));
          for (var q = 0; q < nb.length; q++) {
            var g = nb[q];
            if (!seen.has(g) && okWall(g)) { seen.add(g); stack.push(g); }
          }
        }
      });
      while (stack.length) {
        var g = stack.pop();
        r.walls.push(g);
        for (var e = 0; e < 3; e++) {
          var nb = edges.get(ekey(F[g * 3 + e], F[g * 3 + (e + 1) % 3]));
          for (var q = 0; q < nb.length; q++) {
            var h = nb[q];
            if (!seen.has(h) && okWall(h)) { seen.add(h); stack.push(h); }
          }
        }
      }
    });

    var textArea = 0, heights = {};
    regions.forEach(function (r) { if (r.text) { textArea += r.area; heights[r.z.toFixed(2)] = 1; } });
    return {
      regions: regions,
      regionOf: regionOf,
      normals: N,
      bbox: bb,
      backing: backing ? backing.id : -1,
      textArea: textArea,
      textHeights: Object.keys(heights).map(Number),
      kind: textArea >= 10 ? 'nameplate' : 'single'
    };
  }

  /*
   * Load-time preparation: analyse, cut the side walls at the bottom of the
   * coloured band for every letter height found, then analyse again so each
   * region knows its band walls. Returns {mesh, analysis}.
   */
  function prepareModel(mesh, opts) {
    opts = opts || {};
    var band = opts.band || 0.56;
    var an = analyze(mesh, opts);
    var planes = {};
    an.regions.forEach(function (r) { if (r.z - band > 0.05) planes[(r.z - band).toFixed(4)] = r.z - band; });
    var zs = Object.keys(planes).map(function (k) { return planes[k]; });
    if (zs.length) {
      mesh = cutMesh(mesh, zs);
      an = analyze(mesh, opts);
    }
    return { mesh: mesh, analysis: an };
  }

  // per-face paint flags (1 = letter colour) from the regions marked paint
  function paintFlags(mesh, analysis) {
    var p = new Uint8Array(mesh.F.length / 3);
    analysis.regions.forEach(function (r) {
      if (!r.paint) return;
      r.faces.forEach(function (f) { p[f] = 1; });
      r.walls.forEach(function (f) { p[f] = 1; });
    });
    return p;
  }

  // ------------------------------------------------------------------ colour / flush
  function hexToRgb(h) {
    h = (h || '#ffffff').replace('#', '');
    return [parseInt(h.substr(0, 2), 16) || 0, parseInt(h.substr(2, 2), 16) || 0, parseInt(h.substr(4, 2), 16) || 0];
  }
  function rgb2hsv(r, g, b) {
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, h = 0;
    if (d > 0) {
      if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
      h *= 60; if (h < 0) h += 360;
    }
    return [h, mx === 0 ? 0 : d / mx, mx];
  }
  // Same formula Bambu Studio uses to suggest flushing volumes from colours.
  function flushVolume(fromHex, toHex, minFlush) {
    var s = hexToRgb(fromHex).map(function (x) { return x / 255; });
    var d = hexToRgb(toHex).map(function (x) { return x / 255; });
    var fh = rgb2hsv(s[0], s[1], s[2]), th = rgb2hsv(d[0], d[1], d[2]);
    var r1 = fh[0] * Math.PI / 180, r2 = th[0] * Math.PI / 180;
    var dx = Math.cos(r1) * fh[1] * fh[2] - Math.cos(r2) * th[1] * th[2];
    var dy = Math.sin(r1) * fh[1] * fh[2] - Math.sin(r2) * th[1] * th[2];
    var hs = Math.min(1.2, Math.sqrt(dx * dx + dy * dy));
    var fl = s[0] * 0.3 + s[1] * 0.59 + s[2] * 0.11, tl = d[0] * 0.3 + d[1] * 0.59 + d[2] * 0.11, lf;
    if (tl >= fl) lf = Math.pow(tl - fl, 0.7) * 560;
    else { lf = (fl - tl) * 80; hs = Math.min(0.67 * th[2] + 0.33 * fh[2], hs); }
    var hf = 230 * hs;
    var v = Math.max(60, Math.sqrt(hf * hf + lf * lf + hf * lf));
    return Math.min(800, Math.floor(v + minFlush));
  }

  // MMU paint value for one whole (unsplit) triangle painted with filament `n` (1-based)
  function paintCode(n) {
    if (n <= 0) return '';
    if (n <= 2) return (n << 2).toString(16).toUpperCase();
    return (n - 3).toString(16).toUpperCase() + 'C';
  }

  // ------------------------------------------------------------------ layout
  function rectsOverlap(a, b) {
    return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
  }

  /*
   * items: [{w, d}] footprints (mm). Returns {plates: [{items:[{index,x,y}], tower:[x,y]}], unplaced:[]}
   * x,y are the centres of each footprint in plate coordinates.
   */
  function layout(items, printer, opts) {
    opts = opts || {};
    var gap = opts.gap || 8, margin = 6;
    var bed = printer.bed, needTower = !!opts.tower;
    var tw = printer.primeTowerWidth + 10;
    var obstaclesBase = (printer.exclude || []).map(function (r) { return [r[0] - 2, r[1] - 2, r[2] + 2, r[3] + 2]; });
    var order = items.map(function (it, i) { return i; }).sort(function (a, b) { return items[b].d - items[a].d; });
    var plates = [], unplaced = [];
    var bw = bed[2] - bed[0] - 2 * margin, bd = bed[3] - bed[1] - 2 * margin;

    function towerSpots() {
      var x0 = bed[0] + margin, y0 = bed[1] + margin, x1 = bed[2] - margin - tw, y1 = bed[3] - margin - tw;
      var mx = (bed[0] + bed[2] - tw) / 2, my = (bed[1] + bed[3] - tw) / 2;
      return [[x1, y1], [x0, y1], [mx, y1], [x1, my], [x1, y0], [x0, my], [mx, y0], [x0, y0]];
    }

    if (items.length === 1 && items[0].w <= bw && items[0].d <= bd) {
      var it = items[0];
      var cx = (bed[0] + bed[2]) / 2, cy = (bed[1] + bed[3]) / 2;
      var r = [cx - it.w / 2, cy - it.d / 2, cx + it.w / 2, cy + it.d / 2];
      obstaclesBase.forEach(function (o) {
        if (rectsOverlap(r, o)) { var dx = o[2] - r[0] + 2; r[0] += dx; r[2] += dx; }
      });
      var p = { items: [{ index: 0, x: (r[0] + r[2]) / 2, y: (r[1] + r[3]) / 2 }], tower: null };
      if (needTower) {
        var spots = towerSpots(), grown = [r[0] - gap, r[1] - gap, r[2] + gap, r[3] + gap];
        for (var s = 0; s < spots.length; s++) {
          var t = [spots[s][0], spots[s][1], spots[s][0] + tw, spots[s][1] + tw];
          if (!rectsOverlap(t, grown) && !obstaclesBase.some(function (o) { return rectsOverlap(t, o); })) { p.tower = spots[s]; break; }
        }
        if (!p.tower) p.tower = spots[0];
      }
      return { plates: [p], unplaced: [] };
    }

    function newPlate() {
      var obs = obstaclesBase.slice(), tower = null;
      if (needTower) {
        tower = [bed[2] - margin - tw, bed[3] - margin - tw];
        obs.push([tower[0] - gap / 2, tower[1] - gap / 2, tower[0] + tw + gap / 2, tower[1] + tw + gap / 2]);
      }
      return { items: [], tower: tower, obs: obs, x: bed[0] + margin, y: bed[1] + margin, rowD: 0 };
    }
    function tryPlace(pl, it) {
      for (var guard = 0; guard < 400; guard++) {
        if (pl.x + it.w > bed[2] - margin + 1e-6) {
          pl.x = bed[0] + margin; pl.y += pl.rowD + gap; pl.rowD = 0;
        }
        if (pl.y + it.d > bed[3] - margin + 1e-6) return null;
        var r = [pl.x, pl.y, pl.x + it.w, pl.y + it.d];
        var hit = null;
        for (var o = 0; o < pl.obs.length; o++) if (rectsOverlap(r, pl.obs[o])) { hit = pl.obs[o]; break; }
        if (!hit) {
          pl.x += it.w + gap;
          pl.rowD = Math.max(pl.rowD, it.d);
          return [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2];
        }
        pl.x = Math.max(pl.x + 1, hit[2] + 0.01);
      }
      return null;
    }
    order.forEach(function (idx) {
      var it = items[idx];
      if (it.w > bw || it.d > bd) { unplaced.push(idx); return; }
      for (var p = 0; p < plates.length; p++) {
        var snap = { x: plates[p].x, y: plates[p].y, rowD: plates[p].rowD };
        var pos = tryPlace(plates[p], it);
        if (pos) { plates[p].items.push({ index: idx, x: pos[0], y: pos[1] }); return; }
        plates[p].x = snap.x; plates[p].y = snap.y; plates[p].rowD = snap.rowD;
      }
      var np = newPlate();
      var pos2 = tryPlace(np, it);
      if (pos2) { np.items.push({ index: idx, x: pos2[0], y: pos2[1] }); plates.push(np); }
      else unplaced.push(idx);
    });
    // centre each plate's group on the bed (keeps clear of the tower corner)
    plates.forEach(function (pl) {
      delete pl.obs; delete pl.x; delete pl.y; delete pl.rowD;
    });
    return { plates: plates, unplaced: unplaced };
  }

  // Bambu Studio lays several plates out in a grid in world space.
  function plateOffset(index, count, printer) {
    var v = Math.sqrt(count), rv = Math.round(v), cols = v > rv ? rv + 1 : rv;
    var w = printer.bedSize[0], d = printer.bedSize[1];
    var row = Math.floor(index / cols), col = index % cols;
    return [col * w * 1.2, -row * d * 1.2];
  }

  // ------------------------------------------------------------------ zip
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(buf) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function utf8(s) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s);
    return new Uint8Array(Buffer.from(s, 'utf8'));
  }
  // files: [{name, data(Uint8Array|string)}]; deflate: optional async/sync fn(Uint8Array)->Uint8Array (raw deflate)
  async function makeZip(files, deflate) {
    var parts = [], central = [], offset = 0;
    var now = new Date();
    var dtime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    var ddate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    for (var i = 0; i < files.length; i++) {
      var name = utf8(files[i].name);
      var raw = typeof files[i].data === 'string' ? utf8(files[i].data) : files[i].data;
      var crc = crc32(raw), method = 0, comp = raw;
      if (deflate && raw.length > 256) {
        var c = await deflate(raw);
        if (c && c.length < raw.length) { comp = c; method = 8; }
      }
      var lh = new Uint8Array(30 + name.length), lv = new DataView(lh.buffer);
      lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true);
      lv.setUint16(8, method, true); lv.setUint16(10, dtime, true); lv.setUint16(12, ddate, true);
      lv.setUint32(14, crc, true); lv.setUint32(18, comp.length, true); lv.setUint32(22, raw.length, true);
      lv.setUint16(26, name.length, true); lv.setUint16(28, 0, true);
      lh.set(name, 30);
      var ch = new Uint8Array(46 + name.length), cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true); cv.setUint16(10, method, true); cv.setUint16(12, dtime, true);
      cv.setUint16(14, ddate, true); cv.setUint32(16, crc, true); cv.setUint32(20, comp.length, true);
      cv.setUint32(24, raw.length, true); cv.setUint16(28, name.length, true);
      cv.setUint32(42, offset, true);
      ch.set(name, 46);
      parts.push(lh, comp);
      central.push(ch);
      offset += lh.length + comp.length;
    }
    var csize = central.reduce(function (s, c) { return s + c.length; }, 0);
    var end = new Uint8Array(22), ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
    ev.setUint32(12, csize, true); ev.setUint32(16, offset, true);
    var total = offset + csize + 22, out = new Uint8Array(total), p = 0;
    parts.concat(central, [end]).forEach(function (b) { out.set(b, p); p += b.length; });
    return out;
  }

  // ------------------------------------------------------------------ 3MF
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function num(x) {
    var s = (Math.abs(x) < 1e-9 ? 0 : x).toFixed(5);
    s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s === '-0' ? '0' : s;
  }
  function hex(n, w) { var s = n.toString(16); while (s.length < w) s = '0' + s; return s; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function fill(n, v) { var a = []; for (var i = 0; i < n; i++) a.push(v); return a; }

  var MODEL_NS = 'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p"';

  /*
   * Prepare an object for the plate: drop it to the bed, optionally turn it
   * 90 degrees so it fits, and centre the mesh around its bounding box centre.
   */
  function placeable(mesh, printer) {
    var V = new Float64Array(mesh.V), b = bbox(V);
    var w = b[3] - b[0], d = b[4] - b[1];
    var bw = printer.bed[2] - printer.bed[0] - 12, bd = printer.bed[3] - printer.bed[1] - 12;
    var rotated = false;
    if ((w > bw || d > bd) && d <= bw && w <= bd) {
      for (var i = 0; i < V.length; i += 3) { var x = V[i]; V[i] = -V[i + 1]; V[i + 1] = x; }
      b = bbox(V); rotated = true;
    }
    var cx = (b[0] + b[3]) / 2, cy = (b[1] + b[4]) / 2, h = b[5] - b[2], cz = b[2] + h / 2;
    for (i = 0; i < V.length; i += 3) { V[i] -= cx; V[i + 1] -= cy; V[i + 2] -= cz; }
    return { V: V, F: mesh.F, w: b[3] - b[0], d: b[4] - b[1], h: h, rotated: rotated, srcOffset: [cx, cy, cz] };
  }

  function objectModelXml(id, uuid, pl, paintFaces, paintValue) {
    var out = [];
    out.push('<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" ' + MODEL_NS + '>\n');
    out.push(' <metadata name="BambuStudio:3mfVersion">1</metadata>\n <resources>\n');
    out.push('  <object id="' + id + '" p:UUID="' + uuid + '" type="model">\n   <mesh>\n    <vertices>\n');
    var V = pl.V, F = pl.F, chunk = [];
    for (var i = 0; i < V.length; i += 3) {
      chunk.push('     <vertex x="' + num(V[i]) + '" y="' + num(V[i + 1]) + '" z="' + num(V[i + 2]) + '"/>\n');
      if (chunk.length > 4000) { out.push(chunk.join('')); chunk = []; }
    }
    out.push(chunk.join('')); chunk = [];
    out.push('    </vertices>\n    <triangles>\n');
    for (var f = 0; f < F.length / 3; f++) {
      var s = '     <triangle v1="' + F[f * 3] + '" v2="' + F[f * 3 + 1] + '" v3="' + F[f * 3 + 2] + '"';
      if (paintFaces && paintFaces[f]) s += ' paint_color="' + paintValue + '"';
      chunk.push(s + '/>\n');
      if (chunk.length > 4000) { out.push(chunk.join('')); chunk = []; }
    }
    out.push(chunk.join(''));
    out.push('    </triangles>\n   </mesh>\n  </object>\n </resources>\n <build/>\n</model>\n');
    return out.join('');
  }

  /*
   * job = {
   *   printer: template entry (FORGECRAFT_TEMPLATES.printers[key]),
   *   meta: {bambuStudio},
   *   mode: 'nameplate' | 'single',
   *   colors: {base:'#FFFFFF', letter:'#0000FF', spare:'#C0C0C0'},
   *   singleSlot: 'base' | 'letter',
   *   bedType: 'Textured PEI Plate',
   *   objects: [{name, mesh:{V,F}, paint: Uint8Array per face (1 = letter colour)}]
   * }
   * returns {files:[{name,data}], plates, unplaced}
   */
  function build3MFFiles(job) {
    var P = job.printer, n = P.filaments;
    var baseSlot = P.slots.base, letterSlot = P.slots.letter;
    var mode = job.mode === 'single' ? 'single' : 'nameplate';
    var objSlot = mode === 'single' && job.singleSlot === 'letter' ? letterSlot : baseSlot;
    var colors = [];
    for (var i = 1; i <= n; i++) {
      colors.push(i === baseSlot ? job.colors.base : i === letterSlot ? job.colors.letter : (job.colors.spare || '#C0C0C0'));
    }
    colors = colors.map(function (c) { return c.toUpperCase(); });

    var placed = job.objects.map(function (o) { return placeable(o.mesh, P); });
    var anyPaint = mode === 'nameplate' && job.objects.some(function (o) {
      if (!o.paint) return false; for (var i = 0; i < o.paint.length; i++) if (o.paint[i]) return true; return false;
    });
    var lay = layout(placed.map(function (p) { return { w: p.w, d: p.d }; }), P, { tower: anyPaint });
    var plates = lay.plates;

    // ----- project settings
    var cfg = clone(P.config);
    if (mode === 'nameplate') {
      Object.keys(P.namePlateOverrides).forEach(function (k) { cfg[k] = P.namePlateOverrides[k]; });
      cfg.print_settings_id = P.namePlateProcess;
      cfg.inherits_group[0] = P.namePlateInherits;
      cfg.different_settings_to_system[0] = P.namePlateDiff;
    }
    var ext = String(P.extruder);
    cfg.filament_colour = colors.slice();
    cfg.filament_multi_colour = colors.slice();
    cfg.filament_colour_type = fill(n, '1');
    cfg.default_filament_colour = fill(n, '');
    cfg.filament_map = fill(n, ext);
    cfg.filament_map_mode = P.nozzles > 1 ? 'Manual' : 'Auto For Flush';
    cfg.filament_nozzle_map = fill(n, '0');
    cfg.filament_volume_map = fill(n, '0');
    var matrix = [];
    for (var nz = 0; nz < P.nozzles; nz++) {
      for (var a = 0; a < n; a++) for (var b = 0; b < n; b++) {
        matrix.push(String(a === b ? 0 : flushVolume(colors[a], colors[b], P.minFlush)));
      }
    }
    cfg.flush_volumes_matrix = matrix;
    cfg.flush_volumes_vector = fill(2 * n, '140');
    cfg.flush_multiplier = fill(P.nozzles, '1');
    cfg.curr_bed_type = job.bedType || 'Textured PEI Plate';
    var tx = [], ty = [];
    plates.forEach(function (pl) {
      var t = pl.tower || [P.bed[2] - P.primeTowerWidth - 16, P.bed[3] - P.primeTowerWidth - 16];
      tx.push(num(t[0])); ty.push(num(t[1]));
    });
    if (!tx.length) { tx = [cfg.wipe_tower_x[0]]; ty = [cfg.wipe_tower_y[0]]; }
    cfg.wipe_tower_x = tx; cfg.wipe_tower_y = ty;

    // ----- models
    var files = [], resources = [], items = [], msObjects = [], rels = [];
    var date = new Date().toISOString().slice(0, 10);
    var paintValue = paintCode(letterSlot);
    var plateOf = {};
    plates.forEach(function (pl, pi) { pl.items.forEach(function (it) { plateOf[it.index] = { plate: pi, x: it.x, y: it.y }; }); });

    var objIndex = 0;
    job.objects.forEach(function (o, idx) {
      if (!plateOf.hasOwnProperty(idx)) return;
      objIndex++;
      var pl = placed[idx], where = plateOf[idx];
      var meshId = objIndex * 2 - 1, objId = objIndex * 2;
      var path = '/3D/Objects/object_' + objIndex + '.model';
      var meshUuid = hex(objIndex, 4) + '0000-81cb-4c03-9d28-80fed5dfa1dc';
      var paint = mode === 'nameplate' && o.paint ? o.paint : null;
      files.push({ name: path.slice(1), data: objectModelXml(meshId, meshUuid, pl, paint, paintValue) });
      rels.push(' <Relationship Target="' + path + '" Id="rel-' + objIndex + '" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>');
      resources.push('  <object id="' + objId + '" p:UUID="' + hex(objIndex, 8) + '-61cb-4c03-9d28-80fed5dfa1dc" type="model">\n' +
        '   <components>\n    <component p:path="' + path + '" objectid="' + meshId + '" p:UUID="' + hex(objIndex, 4) +
        '0000-b206-40ff-9872-83e8017abed1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>\n   </components>\n  </object>');
      var off = plateOffset(where.plate, plates.length, P);
      var wx = where.x + off[0], wy = where.y + off[1], wz = pl.h / 2;
      items.push('  <item objectid="' + objId + '" p:UUID="' + hex(objIndex + 1, 8) + '-b1ec-4553-aec9-835e5b724bb4" transform="1 0 0 0 1 0 0 0 1 ' +
        num(wx) + ' ' + num(wy) + ' ' + num(wz) + '" printable="1"/>');
      var nm = esc(o.name);
      msObjects.push({
        plate: where.plate, objId: objId,
        xml: '  <object id="' + objId + '">\n' +
          '    <metadata key="name" value="' + nm + '"/>\n' +
          '    <metadata key="extruder" value="' + objSlot + '"/>\n' +
          '    <metadata face_count="' + (pl.F.length / 3) + '"/>\n' +
          '    <part id="' + meshId + '" subtype="normal_part">\n' +
          '      <metadata key="name" value="' + nm + '"/>\n' +
          '      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>\n' +
          '      <metadata key="source_file" value="' + nm + '"/>\n' +
          '      <metadata key="source_object_id" value="0"/>\n' +
          '      <metadata key="source_volume_id" value="0"/>\n' +
          '      <metadata key="source_offset_x" value="' + num(pl.srcOffset[0]) + '"/>\n' +
          '      <metadata key="source_offset_y" value="' + num(pl.srcOffset[1]) + '"/>\n' +
          '      <metadata key="source_offset_z" value="' + num(pl.srcOffset[2]) + '"/>\n' +
          '      <mesh_stat face_count="' + (pl.F.length / 3) + '" edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>\n' +
          '    </part>\n  </object>\n'
      });
    });

    var app = 'BambuStudio-' + (job.meta && job.meta.bambuStudio || '02.09.01.70');
    var mainModel = '<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" ' + MODEL_NS + '>\n' +
      ' <metadata name="Application">' + app + '</metadata>\n' +
      ' <metadata name="BambuStudio:3mfVersion">1</metadata>\n' +
      ' <metadata name="CreationDate">' + date + '</metadata>\n' +
      ' <metadata name="ModificationDate">' + date + '</metadata>\n' +
      ' <metadata name="Title">' + esc(job.title || '') + '</metadata>\n' +
      ' <resources>\n' + resources.join('\n') + '\n </resources>\n' +
      ' <build p:UUID="2c7c17d8-22b5-4d84-8835-1976022ea369">\n' + items.join('\n') + '\n </build>\n</model>\n';

    var thumbs = job.thumbnails || [];
    var plateXml = plates.map(function (pl, pi) {
      var s = '  <plate>\n' +
        '    <metadata key="plater_id" value="' + (pi + 1) + '"/>\n' +
        '    <metadata key="plater_name" value=""/>\n' +
        '    <metadata key="locked" value="false"/>\n' +
        '    <metadata key="filament_map_mode" value="' + cfg.filament_map_mode + '"/>\n' +
        '    <metadata key="filament_maps" value="' + fill(n, ext).join(' ') + '"/>\n' +
        '    <metadata key="gcode_file" value=""/>\n';
      if (thumbs[pi]) s += '    <metadata key="thumbnail_file" value="Metadata/plate_' + (pi + 1) + '.png"/>\n';
      msObjects.filter(function (m) { return m.plate === pi; }).forEach(function (m, k) {
        s += '    <model_instance>\n      <metadata key="object_id" value="' + m.objId + '"/>\n' +
          '      <metadata key="instance_id" value="0"/>\n      <metadata key="identify_id" value="' + (100 + m.objId) + '"/>\n    </model_instance>\n';
      });
      return s + '  </plate>\n';
    }).join('');
    var modelSettings = '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n' +
      msObjects.map(function (m) { return m.xml; }).join('') + plateXml + '  <assemble>\n  </assemble>\n</config>\n';

    var relsMain = '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n' +
      ' <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n' +
      (thumbs[0] ? ' <Relationship Target="/Metadata/plate_1.png" Id="rel-2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail"/>\n' +
        ' <Relationship Target="/Metadata/plate_1.png" Id="rel-4" Type="http://schemas.bambulab.com/package/2021/cover-thumbnail-middle"/>\n' +
        ' <Relationship Target="/Metadata/plate_1.png" Id="rel-5" Type="http://schemas.bambulab.com/package/2021/cover-thumbnail-small"/>\n' : '') +
      '</Relationships>\n';
    var contentTypes = '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n' +
      ' <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n' +
      ' <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n' +
      ' <Default Extension="png" ContentType="image/png"/>\n' +
      ' <Default Extension="gcode" ContentType="text/x.gcode"/>\n</Types>\n';
    var seq = {};
    plates.forEach(function (pl, pi) { seq['plate_' + (pi + 1)] = { nozzle_sequence: [], optimal_assignment: [], sequence: [] }; });
    var ver = job.meta && job.meta.bambuStudio || '02.09.01.70';

    var out = [
      { name: '[Content_Types].xml', data: contentTypes },
      { name: '_rels/.rels', data: relsMain },
      { name: '3D/3dmodel.model', data: mainModel },
      { name: '3D/_rels/3dmodel.model.rels', data: '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n' + rels.join('\n') + '\n</Relationships>\n' }
    ].concat(files).concat([
      { name: 'Metadata/model_settings.config', data: modelSettings },
      { name: 'Metadata/project_settings.config', data: JSON.stringify(cfg, null, 4) },
      { name: 'Metadata/slice_info.config', data: '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n  <header>\n    <header_item key="X-BBL-Client-Type" value="slicer"/>\n    <header_item key="X-BBL-Client-Version" value="' + ver + '"/>\n  </header>\n</config>\n' },
      { name: 'Metadata/filament_sequence.json', data: JSON.stringify(seq) }
    ]);
    thumbs.forEach(function (png, pi) { if (png) out.push({ name: 'Metadata/plate_' + (pi + 1) + '.png', data: png }); });
    return { files: out, plates: plates, unplaced: lay.unplaced, colors: colors, config: cfg };
  }

  async function build3MF(job, deflate) {
    var r = build3MFFiles(job);
    r.zip = await makeZip(r.files, deflate);
    return r;
  }

  return {
    parseSTL: parseSTL,
    buildMesh: buildMesh,
    bbox: bbox,
    analyze: analyze,
    cutMesh: cutMesh,
    prepareModel: prepareModel,
    paintFlags: paintFlags,
    flushVolume: flushVolume,
    paintCode: paintCode,
    layout: layout,
    placeable: placeable,
    build3MFFiles: build3MFFiles,
    build3MF: build3MF,
    makeZip: makeZip
  };
})();
if (typeof module !== 'undefined') module.exports = ForgecraftCore;
