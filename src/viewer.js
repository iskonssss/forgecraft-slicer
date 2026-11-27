/*
 * Forgecraft Slicer - small WebGL plate viewer (no libraries, works offline).
 * Mouse like Tinkercad: orbit = right-drag, pan = middle (wheel) drag or Shift+right-drag, zoom = wheel.
 * Left click picks a face (left-drag does nothing). Touch: one-finger drag orbits.
 */
var ForgecraftViewer = (function () {
  'use strict';

  var VS = 'attribute vec3 aPos; attribute vec3 aNor; attribute vec3 aCol;' +
    'uniform mat4 uMVP; varying vec3 vNor; varying vec3 vCol;' +
    'void main(){ gl_Position = uMVP * vec4(aPos,1.0); vNor = aNor; vCol = aCol; }';
  var FS = 'precision mediump float; varying vec3 vNor; varying vec3 vCol;' +
    'uniform vec3 uL1; uniform vec3 uL2;' +
    'void main(){ vec3 n = normalize(vNor);' +
    ' float d = 0.42 + 0.48*max(dot(n,uL1),0.0) + 0.22*max(dot(n,uL2),0.0) + 0.08*n.z;' +
    ' gl_FragColor = vec4(vCol*min(d,1.08),1.0); }';
  var LVS = 'attribute vec3 aPos; uniform mat4 uMVP; void main(){ gl_Position = uMVP*vec4(aPos,1.0); }';
  var LFS = 'precision mediump float; uniform vec4 uColor; void main(){ gl_FragColor = uColor; }';

  function compile(gl, vs, fs) {
    function sh(type, src) {
      var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    }
    var p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    return p;
  }
  // --- tiny matrix helpers (column-major)
  function persp(fovy, aspect, near, far) {
    var f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
  }
  function lookAt(e, t, u) {
    var z = norm(sub(e, t)), x = norm(cross(u, z)), y = cross(z, x);
    return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
      -dot(x, e), -dot(y, e), -dot(z, e), 1];
  }
  function mul(a, b) {
    var o = new Array(16);
    for (var i = 0; i < 4; i++) for (var j = 0; j < 4; j++) {
      var s = 0; for (var k = 0; k < 4; k++) s += a[k * 4 + j] * b[i * 4 + k]; o[i * 4 + j] = s;
    }
    return o;
  }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function scale(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function norm(a) { var l = Math.sqrt(dot(a, a)) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }

  function Viewer(canvas, opts) {
    opts = opts || {};
    this.canvas = canvas;
    var gl = canvas.getContext('webgl', { antialias: true, alpha: false }) || canvas.getContext('experimental-webgl');
    if (!gl) throw new Error('WebGL not available');
    this.gl = gl;
    gl.getExtension('OES_element_index_uint');
    this.prog = compile(gl, VS, FS);
    this.lprog = compile(gl, LVS, LFS);
    this.items = [];
    this.bedLines = null;
    this.bed = [0, 0, 256, 256];
    this.yaw = 0; this.pitch = 1.12; this.dist = 420; this.target = [128, 128, 0];
    this.onPick = opts.onPick || null;
    this.onHover = opts.onHover || null;
    this.bg = opts.background || [0.16, 0.17, 0.19];
    this._bind();
    var self = this;
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(function () { self.resize(); }).observe(canvas.parentNode);
    }
    window.addEventListener('resize', function () { self.resize(); });
    this.resize();
  }

  Viewer.prototype.resize = function () {
    var c = this.canvas, dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    this.render();
  };

  Viewer.prototype.setBed = function (bedSize, usable, exclude) {
    var gl = this.gl, W = bedSize[0], D = bedSize[1], pts = [];
    this.bed = [0, 0, W, D];
    for (var x = 0; x <= W + 1e-6; x += 10) pts.push(x, 0, 0, x, D, 0);
    for (var y = 0; y <= D + 1e-6; y += 10) pts.push(0, y, 0, W, y, 0);
    var lines = new Float32Array(pts);
    if (!this.bedLines) this.bedLines = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bedLines);
    gl.bufferData(gl.ARRAY_BUFFER, lines, gl.STATIC_DRAW);
    this.bedLineCount = lines.length / 3;
    var o = [0, 0, 0, W, 0, 0, W, 0, 0, W, D, 0, W, D, 0, 0, D, 0, 0, D, 0, 0, 0, 0];
    var u = usable || [0, 0, W, D];
    var uo = [u[0], u[1], 0.05, u[2], u[1], 0.05, u[2], u[1], 0.05, u[2], u[3], 0.05, u[2], u[3], 0.05, u[0], u[3], 0.05, u[0], u[3], 0.05, u[0], u[1], 0.05];
    (exclude || []).forEach(function (r) {
      uo.push(r[0], r[1], 0.05, r[2], r[1], 0.05, r[2], r[1], 0.05, r[2], r[3], 0.05, r[2], r[3], 0.05, r[0], r[3], 0.05, r[0], r[3], 0.05, r[0], r[1], 0.05);
    });
    if (!this.bedOutline) this.bedOutline = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bedOutline);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(o), gl.STATIC_DRAW);
    if (!this.usableOutline) this.usableOutline = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.usableOutline);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(uo), gl.STATIC_DRAW);
    this.usableCount = uo.length / 3;
    // bed plate surface
    var plate = new Float32Array([0, 0, -0.05, W, 0, -0.05, W, D, -0.05, 0, 0, -0.05, W, D, -0.05, 0, D, -0.05]);
    var pn = new Float32Array(18), pc = new Float32Array(18);
    for (var i = 0; i < 6; i++) { pn[i * 3 + 2] = 1; pc[i * 3] = 0.22; pc[i * 3 + 1] = 0.235; pc[i * 3 + 2] = 0.26; }
    this.plate = this._upload(plate, pn, pc, this.plate);
    this.frameBox = null;
    this.frame();
  };

  Viewer.prototype._upload = function (pos, nor, col, old) {
    var gl = this.gl, b = old || { pos: gl.createBuffer(), nor: gl.createBuffer(), col: gl.createBuffer() };
    gl.bindBuffer(gl.ARRAY_BUFFER, b.pos); gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, b.nor); gl.bufferData(gl.ARRAY_BUFFER, nor, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, b.col); gl.bufferData(gl.ARRAY_BUFFER, col, gl.DYNAMIC_DRAW);
    b.count = pos.length / 3;
    return b;
  };

  /*
   * items: [{key, V (world mm, Float64Array), F (Uint32Array), colors: Float32Array (3 per face)}]
   * boxes: [{x0,y0,x1,y1,h,color:[r,g,b]}] e.g. the prime tower
   */
  Viewer.prototype.setItems = function (items, boxes) {
    var gl = this.gl;
    this.items.forEach(function (it) { ['pos', 'nor', 'col'].forEach(function (k) { gl.deleteBuffer(it.buf[k]); }); });
    var self = this;
    this.items = items.map(function (it) {
      var F = it.F, V = it.V, nf = F.length / 3;
      var pos = new Float32Array(nf * 9), nor = new Float32Array(nf * 9);
      for (var f = 0; f < nf; f++) {
        var a = F[f * 3] * 3, b = F[f * 3 + 1] * 3, c = F[f * 3 + 2] * 3;
        var n = norm(cross(sub([V[b], V[b + 1], V[b + 2]], [V[a], V[a + 1], V[a + 2]]), sub([V[c], V[c + 1], V[c + 2]], [V[a], V[a + 1], V[a + 2]])));
        var vs = [a, b, c];
        for (var k = 0; k < 3; k++) {
          pos[f * 9 + k * 3] = V[vs[k]]; pos[f * 9 + k * 3 + 1] = V[vs[k] + 1]; pos[f * 9 + k * 3 + 2] = V[vs[k] + 2];
          nor[f * 9 + k * 3] = n[0]; nor[f * 9 + k * 3 + 1] = n[1]; nor[f * 9 + k * 3 + 2] = n[2];
        }
      }
      var o = { key: it.key, V: V, F: F, buf: self._upload(pos, nor, self._expand(it.colors, nf)) };
      return o;
    });
    this.boxes = (boxes || []).map(function (bx) { return self._box(bx); });
    this.render();
  };

  Viewer.prototype._expand = function (faceCols, nf) {
    var out = new Float32Array(nf * 9);
    for (var f = 0; f < nf; f++) for (var k = 0; k < 3; k++) {
      out[f * 9 + k * 3] = faceCols[f * 3]; out[f * 9 + k * 3 + 1] = faceCols[f * 3 + 1]; out[f * 9 + k * 3 + 2] = faceCols[f * 3 + 2];
    }
    return out;
  };

  Viewer.prototype.setColors = function (key, faceCols) {
    var gl = this.gl;
    for (var i = 0; i < this.items.length; i++) {
      var it = this.items[i];
      if (it.key !== key) continue;
      gl.bindBuffer(gl.ARRAY_BUFFER, it.buf.col);
      gl.bufferData(gl.ARRAY_BUFFER, this._expand(faceCols, it.F.length / 3), gl.DYNAMIC_DRAW);
    }
    this.render();
  };

  Viewer.prototype._box = function (b) {
    var x0 = b.x0, y0 = b.y0, x1 = b.x1, y1 = b.y1, h = b.h;
    var P = [[x0, y0, 0], [x1, y0, 0], [x1, y1, 0], [x0, y1, 0], [x0, y0, h], [x1, y0, h], [x1, y1, h], [x0, y1, h]];
    var Fs = [[4, 5, 6, 7, [0, 0, 1]], [0, 1, 5, 4, [0, -1, 0]], [1, 2, 6, 5, [1, 0, 0]], [2, 3, 7, 6, [0, 1, 0]], [3, 0, 4, 7, [-1, 0, 0]]];
    var pos = [], nor = [], col = [];
    Fs.forEach(function (q) {
      [[q[0], q[1], q[2]], [q[0], q[2], q[3]]].forEach(function (t) {
        t.forEach(function (vi) { pos.push.apply(pos, P[vi]); nor.push.apply(nor, q[4]); col.push.apply(col, b.color); });
      });
    });
    return this._upload(new Float32Array(pos), new Float32Array(nor), new Float32Array(col));
  };

  Viewer.prototype._camera = function () {
    var cp = Math.cos(this.pitch);
    var dir = [cp * Math.sin(this.yaw), -cp * Math.cos(this.yaw), Math.sin(this.pitch)];
    var eye = add(this.target, scale(dir, this.dist));
    var aspect = this.canvas.width / Math.max(1, this.canvas.height);
    var fov = 32 * Math.PI / 180;
    return { eye: eye, aspect: aspect, fov: fov, view: lookAt(eye, this.target, [0, 0, 1]), proj: persp(fov, aspect, 1, this.dist * 6 + 2000) };
  };

  Viewer.prototype.render = function () {
    if (this._raf) return;
    var self = this;
    this._raf = requestAnimationFrame(function () { self._raf = 0; self._draw(); });
  };

  Viewer.prototype._draw = function () {
    var gl = this.gl, c = this.canvas;
    gl.viewport(0, 0, c.width, c.height);
    gl.clearColor(this.bg[0], this.bg[1], this.bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    var cam = this._camera(), mvp = mul(cam.proj, cam.view);
    // meshes
    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.prog, 'uMVP'), false, new Float32Array(mvp));
    var l1 = norm(add(sub(cam.eye, this.target), [0, 0, this.dist * 0.6]));
    gl.uniform3fv(gl.getUniformLocation(this.prog, 'uL1'), new Float32Array(l1));
    gl.uniform3fv(gl.getUniformLocation(this.prog, 'uL2'), new Float32Array(norm([-0.6, 0.5, 0.4])));
    var aPos = gl.getAttribLocation(this.prog, 'aPos'), aNor = gl.getAttribLocation(this.prog, 'aNor'), aCol = gl.getAttribLocation(this.prog, 'aCol');
    function drawBuf(b) {
      gl.bindBuffer(gl.ARRAY_BUFFER, b.pos); gl.enableVertexAttribArray(aPos); gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, b.nor); gl.enableVertexAttribArray(aNor); gl.vertexAttribPointer(aNor, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, b.col); gl.enableVertexAttribArray(aCol); gl.vertexAttribPointer(aCol, 3, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, b.count);
    }
    if (this.plate) drawBuf(this.plate);
    this.items.forEach(function (it) { drawBuf(it.buf); });
    (this.boxes || []).forEach(drawBuf);
    gl.disableVertexAttribArray(aNor); gl.disableVertexAttribArray(aCol);
    // bed lines
    if (this.bedLines) {
      gl.useProgram(this.lprog);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.lprog, 'uMVP'), false, new Float32Array(mvp));
      var la = gl.getAttribLocation(this.lprog, 'aPos'), uc = gl.getUniformLocation(this.lprog, 'uColor');
      gl.enableVertexAttribArray(la);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.bedLines); gl.vertexAttribPointer(la, 3, gl.FLOAT, false, 0, 0);
      gl.uniform4f(uc, 0.32, 0.34, 0.37, 1); gl.drawArrays(gl.LINES, 0, this.bedLineCount);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.bedOutline); gl.vertexAttribPointer(la, 3, gl.FLOAT, false, 0, 0);
      gl.uniform4f(uc, 0.55, 0.58, 0.62, 1); gl.drawArrays(gl.LINES, 0, 8);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.usableOutline); gl.vertexAttribPointer(la, 3, gl.FLOAT, false, 0, 0);
      gl.uniform4f(uc, 0.91, 0.45, 0.16, 0.9); gl.drawArrays(gl.LINES, 8, Math.max(0, this.usableCount - 8));
    }
  };

  // ray from canvas pixel (CSS px)
  Viewer.prototype._ray = function (px, py) {
    var cam = this._camera(), c = this.canvas;
    var nx = (px / c.clientWidth) * 2 - 1, ny = 1 - (py / c.clientHeight) * 2;
    var fwd = norm(sub(this.target, cam.eye)), right = norm(cross(fwd, [0, 0, 1])), up = cross(right, fwd);
    var t = Math.tan(cam.fov / 2);
    var dir = norm(add(fwd, add(scale(right, nx * t * cam.aspect), scale(up, ny * t))));
    return { o: cam.eye, d: dir };
  };

  Viewer.prototype.pick = function (px, py) {
    var r = this._ray(px, py), best = null;
    for (var i = 0; i < this.items.length; i++) {
      var it = this.items[i], V = it.V, F = it.F;
      for (var f = 0; f < F.length / 3; f++) {
        var a = F[f * 3] * 3, b = F[f * 3 + 1] * 3, c = F[f * 3 + 2] * 3;
        var e1x = V[b] - V[a], e1y = V[b + 1] - V[a + 1], e1z = V[b + 2] - V[a + 2];
        var e2x = V[c] - V[a], e2y = V[c + 1] - V[a + 1], e2z = V[c + 2] - V[a + 2];
        var px_ = r.d[1] * e2z - r.d[2] * e2y, py_ = r.d[2] * e2x - r.d[0] * e2z, pz_ = r.d[0] * e2y - r.d[1] * e2x;
        var det = e1x * px_ + e1y * py_ + e1z * pz_;
        if (Math.abs(det) < 1e-12) continue;
        var inv = 1 / det;
        var tx = r.o[0] - V[a], ty = r.o[1] - V[a + 1], tz = r.o[2] - V[a + 2];
        var u = (tx * px_ + ty * py_ + tz * pz_) * inv;
        if (u < 0 || u > 1) continue;
        var qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
        var v = (r.d[0] * qx + r.d[1] * qy + r.d[2] * qz) * inv;
        if (v < 0 || u + v > 1) continue;
        var t = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (t > 0 && (!best || t < best.t)) best = { t: t, key: it.key, face: f };
      }
    }
    return best;
  };

  Viewer.prototype._bind = function () {
    var self = this, c = this.canvas, drag = null;
    c.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    // stop the browser's middle-click autoscroll so wheel-drag can pan
    c.addEventListener('mousedown', function (e) { if (e.button === 1) e.preventDefault(); });
    c.addEventListener('auxclick', function (e) { if (e.button === 1) e.preventDefault(); });
    c.addEventListener('pointerdown', function (e) {
      var mode = null;
      if (e.pointerType === 'touch' || e.pointerType === 'pen') mode = 'orbit';
      else if (e.button === 1 || (e.button === 2 && e.shiftKey)) mode = 'pan';
      else if (e.button === 2) mode = 'orbit';
      if (e.button === 1) e.preventDefault();
      drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, mode: mode, button: e.button, moved: false };
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', function (e) {
      if (!drag) {
        if (self.onHover) {
          var rect = c.getBoundingClientRect(), mx = e.clientX - rect.left, my = e.clientY - rect.top;
          if (!self._hoverPending) {
            self._hoverPending = true;
            requestAnimationFrame(function () { self._hoverPending = false; self.onHover(self.pick(mx, my)); });
          }
        }
        return;
      }
      var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY;
      if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 4) drag.moved = true;
      if (!drag.mode) return;
      if (drag.mode === 'pan') {
        var k = self.dist / c.clientHeight * 0.6;
        var right = [Math.cos(self.yaw), Math.sin(self.yaw), 0], fwd = [-Math.sin(self.yaw), Math.cos(self.yaw), 0];
        self.target = add(self.target, add(scale(right, -dx * k), scale(fwd, dy * k)));
      } else {
        self.yaw -= dx * 0.008;
        self.pitch = Math.max(0.08, Math.min(1.55, self.pitch + dy * 0.008));
      }
      self.render();
    });
    c.addEventListener('pointerup', function (e) {
      if (drag && !drag.moved && drag.button === 0 && self.onPick) {
        var rect = c.getBoundingClientRect();
        self.onPick(self.pick(e.clientX - rect.left, e.clientY - rect.top));
      }
      drag = null;
    });
    c.addEventListener('pointerleave', function () { if (!drag && self.onHover) self.onHover(null); });
    c.addEventListener('wheel', function (e) {
      e.preventDefault();
      self.dist = Math.max(40, Math.min(2500, self.dist * Math.pow(1.0015, e.deltaY)));
      self.render();
    }, { passive: false });
  };

  // Frame a box [x0, y0, x1, y1, zmax] (defaults to the last one, or the whole bed).
  Viewer.prototype.frame = function (box) {
    if (box) this.frameBox = box;
    var b = this.frameBox || [this.bed[0], this.bed[1], this.bed[2], this.bed[3], 0];
    var w = Math.max(b[2] - b[0], 90), d = Math.max(b[3] - b[1], 90), h = b[4] || 0;
    this.target = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2, h / 3];
    var aspect = (this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight)) || 1.3;
    var tv = Math.tan(16 * Math.PI / 180), th = tv * aspect;
    this.yaw = 0; this.pitch = 1.12;
    this.dist = 1.18 * Math.max(d / 2 / tv, w / 2 / th) + h;
    this.render();
  };
  Viewer.prototype.resetView = function () { this.frame(); };
  Viewer.prototype.topView = function () { this.pitch = 1.55; this.yaw = 0; this.render(); };

  return Viewer;
})();
if (typeof module !== 'undefined') module.exports = ForgecraftViewer;
