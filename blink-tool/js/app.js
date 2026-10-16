/*
 * Blink Jump — an endless runner you play with your eyes (H5 mini tool).
 *
 * Left-eye wink = small hop, right-eye wink (or both) = big jump.
 * Camera mode is opt-in; without a camera the whole game is played by tapping.
 *
 * Blink detection needs no model: the player aligns the eyes with two boxes in
 * the preview. Per box we measure the dark-pixel ratio (pupil area); an open
 * eye sets a slow adaptive baseline, and a sharp drop sustained for two frames
 * is a closed eye. Edges fire once with a cooldown.
 *
 * All platform access goes through window.Platform (js/platform.js).
 */
(function () {
  'use strict';

  // ---------- tuning ----------
  var T = {
    gravity: 2600,
    jumpBig: -900,
    jumpSmall: -680,
    ballR: 17,
    ballXRatio: 0.28,
    speedStart: 250,
    speedPerPoint: 7,
    speedMax: 600,
    pillarW: 26,
    shortH: [56, 72],
    tallH: [108, 136],
    gapSeconds: [0.95, 1.25],
    gapMinPx: 250,
    restartDelayMs: 700,
    blinkCooldownMs: 300,
  };

  var COLORS = {
    bgTop: '#0e1326', bgBottom: '#1d2748',
    ground: '#2a3563', groundLine: '#5b7bff',
    ball: '#ffffff', ballRing: '#5be0ff',
    short: '#4ecdc4', tall: '#ff6b8a',
    ui: '#eef2ff', dim: '#9aa6d8',
  };

  // ---------- dom ----------
  var stage = document.getElementById('stage');
  var ctx = stage.getContext('2d');
  var hudScore = document.getElementById('hud-score');
  var hudBest = document.getElementById('hud-best');
  var panelReady = document.getElementById('panel-ready');
  var panelOver = document.getElementById('panel-over');
  var overScore = document.getElementById('over-score');
  var overBest = document.getElementById('over-best');
  var overRestart = document.getElementById('over-restart');
  var btnCamera = document.getElementById('btn-camera');
  var tipTouch = document.getElementById('tip-touch');
  var tipEyes = document.getElementById('tip-eyes');
  var tipError = document.getElementById('tip-error');
  var camBox = document.getElementById('cam-box');
  var video = document.getElementById('video');

  // ---------- geometry ----------
  var W = 0, H = 0, dpr = 1, groundY = 0;

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    stage.width = Math.round(W * dpr);
    stage.height = Math.round(H * dpr);
    stage.style.width = W + 'px';
    stage.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    groundY = H - 90;
    if (G) G.ball.y = Math.min(G.ball.y, groundY - T.ballR);
  }

  // ---------- state ----------
  var G = null;
  var high = 0;
  var blinkEyes = { l: false, r: false }; // for the ball's face

  function newGame() {
    G = {
      mode: 'ready',
      paused: false,
      score: 0,
      speed: T.speedStart,
      groundY: groundY,
      ball: { x: W * T.ballXRatio, y: groundY - T.ballR, vy: 0, onGround: true, squash: 0 },
      pillars: [],
      distanceToNext: 340,
      overAt: 0,
      lastTs: 0,
    };
  }

  function startGame() {
    G.mode = 'playing';
    G.score = 0;
    G.speed = T.speedStart;
    G.pillars = [];
    G.distanceToNext = 340;
    G.ball.y = groundY - T.ballR;
    G.ball.vy = 0;
    G.ball.onGround = true;
    hudScore.textContent = '0';
    panelReady.hidden = true;
    panelOver.hidden = true;
  }

  // ---------- random ----------
  var seed = (Date.now() >>> 0) || 1;
  function rnd() {
    seed = (seed + 0x6D2B79F5) >>> 0;
    var t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function rand(a, b) { return a + rnd() * (b - a); }

  function spawnPillar() {
    var tallChance = Math.min(0.55, 0.25 + G.score * 0.015);
    var tall = rnd() < tallChance;
    var h = tall ? rand(T.tallH[0], T.tallH[1]) : rand(T.shortH[0], T.shortH[1]);
    G.pillars.push({ x: W + T.pillarW, w: T.pillarW, h: h, tall: tall, passed: false });
  }

  // ---------- verbs ----------
  function doJump(kind) {
    var b = G.ball;
    if (!b.onGround) return;
    b.vy = kind === 'small' ? T.jumpSmall : T.jumpBig;
    b.onGround = false;
  }

  function jumpVerb(kind, now) {
    if (G.mode === 'ready') {
      startGame();
      doJump(kind);
    } else if (G.mode === 'playing') {
      doJump(kind);
    } else if (G.mode === 'over' && now - G.overAt >= T.restartDelayMs) {
      startGame();
      doJump(kind);
    }
  }

  function endGame(now) {
    G.mode = 'over';
    G.overAt = now;
    if (G.score > high) {
      high = G.score;
      hudBest.textContent = String(high);
      Platform.storage.set('blinkjump_high', high);
    }
    overScore.textContent = String(G.score);
    overBest.textContent = String(high);
    panelOver.hidden = false;
  }

  // ---------- update ----------
  function circleRectHit(cx, cy, r, rx, rw, top) {
    var nx = Math.max(rx, Math.min(cx, rx + rw));
    var ny = Math.max(top, Math.min(cy, groundY));
    var dx = cx - nx, dy = cy - ny;
    return dx * dx + dy * dy < r * r;
  }

  function update(dt, now) {
    if (G.mode !== 'playing' || G.paused) return;
    var dtSec = dt / 1000;
    var b = G.ball;

    G.speed = Math.min(T.speedMax, T.speedStart + G.score * T.speedPerPoint);

    b.vy += T.gravity * dtSec;
    b.y += b.vy * dtSec;
    var restY = groundY - T.ballR;
    if (b.y >= restY) {
      if (!b.onGround) b.squash = 1;
      b.y = restY;
      b.vy = 0;
      b.onGround = true;
    }
    if (b.squash > 0) b.squash = Math.max(0, b.squash - dtSec * 4);

    var move = G.speed * dtSec;
    G.distanceToNext -= move;
    if (G.distanceToNext <= 0) {
      spawnPillar();
      var gap = Math.max(T.gapMinPx,
        G.speed * rand(T.gapSeconds[0], T.gapSeconds[1]));
      G.distanceToNext = gap + T.pillarW;
    }

    for (var i = 0; i < G.pillars.length; i++) {
      var p = G.pillars[i];
      p.x -= move;
      if (!p.passed && p.x + p.w < b.x) {
        p.passed = true;
        G.score += 1;
        hudScore.textContent = String(G.score);
      }
      if (circleRectHit(b.x, b.y, T.ballR * 0.92, p.x, p.w, groundY - p.h)) {
        endGame(now);
      }
    }
    G.pillars = G.pillars.filter(function (p) { return p.x + p.w > -20; });
  }

  // ---------- draw ----------
  function rr(c, x, y, w, h, r) {
    var rad = Math.min(r, w / 2, h / 2);
    c.beginPath();
    c.moveTo(x + rad, y);
    c.arcTo(x + w, y, x + w, y + h, rad);
    c.arcTo(x + w, y + h, x, y + h, rad);
    c.arcTo(x, y + h, x, y, rad);
    c.arcTo(x, y, x + w, y, rad);
    c.closePath();
  }

  function draw(now) {
    var g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, COLORS.bgTop);
    g.addColorStop(1, COLORS.bgBottom);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    var off = (now * 0.03) % 40;
    for (var y = 80; y < H - 120; y += 40) {
      for (var x = -off; x < W; x += 40) ctx.fillRect(x, y, 2, 2);
    }

    ctx.fillStyle = COLORS.ground;
    ctx.fillRect(0, groundY, W, H - groundY);
    ctx.fillStyle = COLORS.groundLine;
    ctx.fillRect(0, groundY, W, 3);

    for (var i = 0; i < G.pillars.length; i++) {
      var p = G.pillars[i];
      ctx.fillStyle = p.tall ? COLORS.tall : COLORS.short;
      rr(ctx, p.x, groundY - p.h, p.w, p.h, 7);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      rr(ctx, p.x + 4, groundY - p.h + 6, 4, p.h - 12, 2);
      ctx.fill();
    }

    var b = G.ball;
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.scale(1 + b.squash * 0.18, 1 - b.squash * 0.22);
    ctx.fillStyle = COLORS.ball;
    ctx.beginPath();
    ctx.arc(0, 0, T.ballR, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = COLORS.ballRing;
    ctx.stroke();
    ctx.fillStyle = '#20263f';
    var blinking = blinkControl.state === 'on' && (blinkEyes.l || blinkEyes.r);
    if (!blinking) {
      ctx.beginPath(); ctx.arc(-5, -3, 2.6, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(5, -3, 2.6, 0, Math.PI * 2); ctx.fill();
    } else {
      ctx.fillRect(-8, -4, 6, 1.6);
      ctx.fillRect(2, -4, 6, 1.6);
    }
    ctx.restore();
  }

  // ---------- blink control (camera, no model) ----------

  var inset = document.getElementById('cam');
  var ictx = inset.getContext('2d');
  var chipL = document.getElementById('chip-l');
  var chipR = document.getElementById('chip-r');
  var camHint = document.getElementById('cam-hint');

  // Eye boxes in PLAYER-VIEW fractions of the mirrored camera image.
  var ROI = {
    l: { x0: 0.20, x1: 0.45, y0: 0.33, y1: 0.47 },
    r: { x0: 0.55, x1: 0.80, y0: 0.33, y1: 0.47 },
  };

  function createBlinkControl() {
    var ac = document.createElement('canvas');
    var ax = ac.getContext('2d', { willReadFrequently: true });
    // 3:4 portrait, same aspect as the on-screen inset: the analysis frame and
    // the preview use the same center crop + mirror, so the guide boxes line up
    // exactly with the pixels being sampled.
    var AW = 96, AH = 128;
    ac.width = AW; ac.height = AH;

    var eyes = {
      l: { base: null, closed: false, hold: 0 },
      r: { base: null, closed: false, hold: 0 },
    };
    var stream = null;
    var rafId = 0;
    var frames = 0;
    var lastTick = 0;
    var lastFire = 0;
    var vw = 0, vh = 0;
    var lit = { l: false, r: false };

    var control = { state: 'off' };

    function setHint(text) { camHint.textContent = text; }

    function darkRatio(d, roi) {
      var x0 = Math.round(roi.x0 * AW), x1 = Math.round(roi.x1 * AW);
      var y0 = Math.round(roi.y0 * AH), y1 = Math.round(roi.y1 * AH);
      var sum = 0, n = 0;
      for (var y = y0; y < y1; y++) {
        var row = (y * AW + x0) * 4;
        for (var x = x0; x < x1; x++) {
          var i = row + (x - x0) * 4;
          sum += d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11;
          n++;
        }
      }
      var mean = sum / n;
      var thr = Math.max(34, mean * 0.6);
      var dark = 0;
      for (var yy = y0; yy < y1; yy++) {
        var r2 = (yy * AW + x0) * 4;
        for (var xx = x0; xx < x1; xx++) {
          var j = r2 + (xx - x0) * 4;
          var lu = d[j] * 0.3 + d[j + 1] * 0.59 + d[j + 2] * 0.11;
          if (lu < thr) dark++;
        }
      }
      return { ratio: dark / n, mean: mean };
    }

    function updateEye(key, ratio) {
      var e = eyes[key];
      if (e.base === null) {
        e.base = ratio;
        return false;
      }
      var edge = false;
      if (e.closed) {
        if (ratio > e.base * 0.78) e.closed = false;
      } else if (e.base > 0.02 && ratio < e.base * 0.5) {
        e.hold += 1;
        if (e.hold >= 2) { e.closed = true; e.hold = 0; edge = true; }
      } else {
        e.hold = 0;
        // adapt the "eyes open" baseline very slowly
        if (ratio > e.base * 0.75) e.base = e.base * 0.985 + ratio * 0.015;
      }
      return edge;
    }

    function tick(now) {
      rafId = window.requestAnimationFrame(tick);
      if (control.state !== 'on') return;
      if (now - lastTick < 33) return; // ~30 fps analysis is enough
      if (video.readyState < 2) return;
      lastTick = now;

      if (!vw) {
        vw = video.videoWidth || 320;
        vh = video.videoHeight || 240;
      }

      // center cover crop from the raw frame, drawn mirrored
      var s = Math.max(AW / vw, AH / vh);
      var srcW = AW / s, srcH = AH / s;
      var srcX = (vw - srcW) / 2, srcY = (vh - srcH) / 2;
      ax.save();
      ax.translate(AW, 0);
      ax.scale(-1, 1);
      try { ax.drawImage(video, srcX, srcY, srcW, srcH, 0, 0, AW, AH); }
      catch (e) { ax.restore(); return; }
      ax.restore();

      var data;
      try { data = ax.getImageData(0, 0, AW, AH).data; }
      catch (e) { return; }

      var dl = darkRatio(data, ROI.l);
      var dr = darkRatio(data, ROI.r);
      frames += 1;

      if (frames < 35) {
        // fast calibration while the player keeps both eyes open
        eyes.l.base = eyes.l.base === null ? dl.ratio : eyes.l.base * 0.85 + dl.ratio * 0.15;
        eyes.r.base = eyes.r.base === null ? dr.ratio : eyes.r.base * 0.85 + dr.ratio * 0.15;
        setHint('正对屏幕，保持睁眼…');
      } else if (frames === 35) {
        setHint('L 小跳 · R 大跳');
      }

      var edgeL = updateEye('l', dl.ratio);
      var edgeR = updateEye('r', dr.ratio);
      lit.l = eyes.l.closed;
      lit.r = eyes.r.closed;
      blinkEyes.l = lit.l; blinkEyes.r = lit.r;
      chipL.classList.toggle('is-lit-l', lit.l);
      chipR.classList.toggle('is-lit-r', lit.r);

      // big (right/both) wins over small (left alone); one verb per blink
      if (now - lastFire >= T.blinkCooldownMs) {
        if (edgeR) {
          lastFire = now;
          jumpVerb('big', now);
        } else if (edgeL && !eyes.r.closed && dr.ratio > (eyes.r.base || 0) * 0.85) {
          lastFire = now;
          jumpVerb('small', now);
        }
      }

      drawInset();
    }

    function drawInset() {
      var iw = inset.width, ih = inset.height;
      ictx.fillStyle = '#141a30';
      ictx.fillRect(0, 0, iw, ih);
      if (vw) {
        var s2 = Math.max(iw / vw, ih / vh);
        var sw2 = iw / s2, sh2 = ih / s2;
        var sx2 = (vw - sw2) / 2, sy2 = (vh - sh2) / 2;
        ictx.save();
        ictx.translate(iw, 0);
        ictx.scale(-1, 1);
        ictx.drawImage(video, sx2, sy2, sw2, sh2, 0, 0, iw, ih);
        ictx.restore();
      }

      var live = frames >= 35;
      // alignment oval
      ictx.strokeStyle = 'rgba(255,255,255,0.35)';
      ictx.lineWidth = 1.5;
      ictx.beginPath();
      ictx.ellipse(iw / 2, ih * 0.42, iw * 0.3, ih * 0.4, 0, 0, Math.PI * 2);
      ictx.stroke();

      var keys = ['l', 'r'];
      for (var k = 0; k < 2; k++) {
        var key = keys[k];
        var roi = ROI[key];
        ictx.strokeStyle = lit[key] ? (key === 'l' ? '#5be0ff' : '#ff6b8a')
          : (live ? 'rgba(91,224,255,0.7)' : 'rgba(255,255,255,0.85)');
        ictx.lineWidth = 2;
        ictx.strokeRect(roi.x0 * iw, roi.y0 * ih, (roi.x1 - roi.x0) * iw, (roi.y1 - roi.y0) * ih);
      }
    }

    function failMessage(err) {
      var name = err && (err.name || '');
      if (name === 'NotAllowedError' || name === 'SecurityError') return '摄像头权限被拒绝，点击屏幕也能玩';
      if (name === 'NotFoundError' || name === 'OverconstrainedError') return '未检测到摄像头，点击屏幕也能玩';
      if (name === 'NotReadableError') return '摄像头被占用，点击屏幕也能玩';
      return '摄像头不可用，点击屏幕也能玩';
    }

    function start() {
      if (control.state === 'on' || control.state === 'starting') return Promise.resolve(false);
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        control.state = 'error';
        tipError.hidden = false;
        tipError.textContent = '此环境不支持摄像头，点击屏幕也能玩';
        return Promise.resolve(false);
      }
      control.state = 'starting';
      btnCamera.disabled = true;
      btnCamera.textContent = '正在开启…';
      setHint('正在开启摄像头…');

      return navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 320 }, height: { ideal: 240 } },
        audio: false,
      }).then(function (s) {
        stream = s;
        video.srcObject = s;
        return video.play().then(function () {
          control.state = 'on';
          frames = 0;
          vw = 0; vh = 0;
          eyes.l.base = null; eyes.r.base = null;
          eyes.l.closed = false; eyes.r.closed = false;
          camBox.hidden = false;
          btnCamera.hidden = true;
          tipTouch.hidden = true;
          tipEyes.hidden = false;
          tipError.hidden = true;
          lastTick = 0;
          rafId = window.requestAnimationFrame(tick);
          return true;
        });
      }).catch(function (err) {
        console.info('[blink] camera failed:', err && (err.name || err.message));
        control.state = 'error';
        tipError.hidden = false;
        tipError.textContent = failMessage(err);
        btnCamera.disabled = false;
        btnCamera.textContent = '重新开启摄像头';
        cleanup();
        return false;
      });
    }

    function cleanup() {
      if (rafId) window.cancelAnimationFrame(rafId);
      rafId = 0;
      if (stream) stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
      stream = null;
      video.srcObject = null;
    }

    function stop() {
      cleanup();
      control.state = 'off';
      frames = 0;
      lit.l = lit.r = false;
      blinkEyes.l = blinkEyes.r = false;
      chipL.classList.remove('is-lit-l');
      chipR.classList.remove('is-lit-r');
      camBox.hidden = true;
      btnCamera.hidden = false;
      btnCamera.disabled = false;
      btnCamera.textContent = '开启摄像头 · 眨眼玩';
      tipTouch.hidden = false;
      tipEyes.hidden = true;
    }

    return { start: start, stop: stop, get state() { return control.state; } };
  }

  var blinkControl = createBlinkControl();

  // ---------- input ----------
  btnCamera.addEventListener('click', function (e) {
    e.stopPropagation();
    blinkControl.start();
  });

  function stopCameraInput(e) {
    e.stopPropagation();
    blinkControl.stop();
  }
  camBox.addEventListener('pointerdown', stopCameraInput);
  camBox.addEventListener('mousedown', stopCameraInput);

  // One handler for touch and mouse. Compatibility mouse events after a tap
  // (and automation that only sends mousedown) are collapsed by a short dedupe.
  var lastInputAt = 0;
  function onPress(e) {
    if (e.target.closest && (e.target.closest('.btn') || e.target.closest('.cam'))) return;
    var now = Date.now();
    if (now - lastInputAt < 400) return;
    lastInputAt = now;
    jumpVerb('big', now);
  }
  document.addEventListener('pointerdown', onPress);
  document.addEventListener('mousedown', onPress);

  // ---------- lifecycle ----------
  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', function () {
    if (!G) return;
    if (document.hidden) {
      G.paused = true;
    } else {
      G.paused = false;
      G.lastTs = 0;
    }
  });

  // ---------- main loop ----------
  function frame(now) {
    window.requestAnimationFrame(frame);
    if (!G.lastTs) G.lastTs = now;
    var dt = now - G.lastTs;
    G.lastTs = now;
    if (dt > 100) dt = 100;
    update(dt, now);
    draw(now);
    if (G.mode === 'over' && now - G.overAt >= T.restartDelayMs) {
      overRestart.textContent = blinkControl.state === 'on'
        ? '眨一下眼或点击屏幕重新开始' : '点击屏幕重新开始';
    }
  }

  // ---------- boot ----------
  resize();
  newGame();
  window.requestAnimationFrame(frame);

  Platform.storage.get('blinkjump_high').then(function (v) {
    if (typeof v === 'number' && v > high) {
      high = v;
      hudBest.textContent = String(high);
    }
  });
})();
