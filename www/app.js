/* 대짬철갤러리 — 폰 사진 폴더 정리 (폴더 위계는 폰 저장소 그대로) */
(function () {
  "use strict";
  var $ = function (s, e) { return (e || document).querySelector(s); };
  var esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var native = !!(window.Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform());
  var FS0;
  try { FS0 = native ? Capacitor.registerPlugin("PhotoFs") : MockFS(); } catch (e) { window.__diag && window.__diag("플러그인 준비 실패: " + e.message); throw e; }

  /* ---------- 작업 중 표시: 0.25초 넘게 걸리면 스피너·경과 시간(옮기기 등은 퍼센트)을 보여 줌 ---------- */
  var BZ = { n: 0, label: "", pct: null, t0: 0, timer: null, wait: null };
  function busyPaint() {
    var el = document.getElementById("busy"); if (!el) return;
    var sec = Math.floor((Date.now() - BZ.t0) / 1000);
    document.getElementById("busyT").textContent = BZ.label + (BZ.pct != null ? " " + Math.round(BZ.pct * 100) + "%" : sec >= 3 ? " · " + sec + "초" : "…");
    el.classList.toggle("det", BZ.pct != null);
    if (BZ.pct != null) document.getElementById("busyBar").style.setProperty("--w", Math.round(BZ.pct * 100) + "%");
  }
  function busyStart(label) {
    BZ.n++;
    if (BZ.n === 1) { BZ.label = label; BZ.pct = null; BZ.t0 = Date.now(); BZ.wait = setTimeout(function () { var el = document.getElementById("busy"); if (el) { el.classList.add("show"); busyPaint(); BZ.timer = setInterval(busyPaint, 400); } }, 250); }
  }
  function busyEnd() {
    BZ.n = Math.max(0, BZ.n - 1);
    if (BZ.n === 0) { clearTimeout(BZ.wait); clearInterval(BZ.timer); var el = document.getElementById("busy"); if (el) el.classList.remove("show"); }
  }
  function busyPct(p, label) { BZ.pct = p; if (label) BZ.label = label; busyPaint(); }
  /* 사진이 많으면 한 번에 하지 않고 20개씩 나눠 보내며 진행률을 보여 줌 */
  function chunked(a, key, size, call, merge, label) {
    var list = a[key], N = list.length;
    if (N <= size) return call(a);
    var out = {}, i = 0; busyPct(0, label);
    function step() {
      if (i >= N) return Promise.resolve(out);
      var part = {}; Object.keys(a).forEach(function (k) { part[k] = a[k]; }); part[key] = list.slice(i, i + size);
      return call(part).then(function (r) { merge(out, r); i += size; busyPct(Math.min(1, i / N)); return step(); }, function (e) { merge(out, { failed: list.slice(i).map(function (p) { return { path: p, error: (e && e.message) || "실패" }; }) }); return out; });
    }
    return step();
  }
  var FS = {};
  var BUSY_LABEL = {
    list: "폴더 읽는 중", tree: "폴더 목록 읽는 중", search: "검색 중", unsorted: "미분류 사진 찾는 중", stat: "태그 사진 불러오는 중",
    move: "사진 옮기는 중", trash: "휴지통으로 보내는 중", restore: "복원하는 중", purge: "지우는 중", renameMany: "이름 바꾸는 중",
    mkdir: "폴더 만드는 중", rename: "이름 바꾸는 중", listTrash: "휴지통 읽는 중"
  };
  ["hasAccess", "requestAccess", "roots", "list", "tree", "thumb", "move", "mkdir", "rename", "renameMany", "trash", "listTrash", "restore", "purge", "openExternal", "search", "stat", "unsorted"].forEach(function (m) {
    FS[m] = function (a) {
      var lab = BUSY_LABEL[m];
      if (!lab || (a && a.quiet)) return FS0[m](a);
      busyStart(lab);
      var p;
      if (m === "move") p = chunked(a, "paths", 20, FS0.move, function (o, r) { o.moved = (o.moved || []).concat(r.moved || []); o.failed = (o.failed || []).concat(r.failed || []); }, lab);
      else if (m === "trash") p = chunked(a, "paths", 20, FS0.trash, function (o, r) { o.ids = (o.ids || []).concat(r.ids || []); o.failed = (o.failed || []).concat(r.failed || []); }, lab);
      else if (m === "restore") p = chunked(a, "ids", 20, FS0.restore, function (o, r) { o.restored = (o.restored || []).concat(r.restored || []); o.failed = (o.failed || []).concat(r.failed || []); }, lab);
      else p = FS0[m](a);
      return Promise.resolve(p).then(function (r) { busyEnd(); return r; }, function (e) { busyEnd(); throw e; });
    };
  });
  var AppPlug = null;
  try { if (native) AppPlug = Capacitor.registerPlugin("App"); } catch (e) { AppPlug = null; }
  var store = {
    get: function (k, d) { try { var v = localStorage.getItem("jp-" + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem("jp-" + k, JSON.stringify(v)); } catch (e) {} }
  };

  function diag(msg) { if (window.__diag) window.__diag(msg); }


  /* ---------- 테마(대표 색 바꾸기) ---------- */
  var THEMES = [["파랑", "#3d8bfd"], ["남색", "#5b5bd6"], ["보라", "#a35cf0"], ["분홍", "#f0589a"], ["빨강", "#ec5448"], ["주황", "#f08a1c"], ["초록", "#2fb35a"], ["청록", "#17aaa3"], ["하늘", "#1aa3dc"], ["회색", "#6b7280"]];
  function hexToHsl(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex || ""); if (!m) return null;
    var n = parseInt(m[1], 16), r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn, h = 0, sat = 0;
    if (d) { sat = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn); h = mx === r ? ((g - b) / d + (g < b ? 6 : 0)) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; }
    return { h: h, s: sat, l: l };
  }
  function hsl(h, sat, l, a) { return "hsl(" + Math.round(h) + " " + Math.round(Math.max(0, Math.min(1, sat)) * 100) + "% " + Math.round(Math.max(0, Math.min(1, l)) * 100) + "%" + (a != null ? " / " + a : "") + ")"; }
  var THEME_KEYS = ["--accent", "--accent-bg", "--ac1", "--ac2", "--acbd", "--fsh", "--lite", "--folder"];
  function applyTheme(hex) {
    var root = document.documentElement, f0 = document.getElementById("fg0"), f1 = document.getElementById("fg1");
    var c = hex ? hexToHsl(hex) : null;
    if (!c) { THEME_KEYS.forEach(function (k) { root.style.removeProperty(k); }); if (f0) { f0.setAttribute("stop-color", "#a9c8ff"); f1.setAttribute("stop-color", "#6f9bea"); } return; }
    var dark = !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    var lf = Math.min(c.l, 0.55) + (dark ? 0.03 : 0), lm = dark ? Math.min(0.74, Math.min(c.l, 0.6) + 0.12) : Math.min(c.l, 0.55), sat = Math.max(0.35, c.s);
    var set = function (k, v) { root.style.setProperty(k, v); };
    set("--accent", hsl(c.h, sat, lm)); set("--accent-bg", hsl(c.h, sat, lm, dark ? 0.24 : 0.14));
    set("--ac1", hsl(c.h, sat, lf + 0.08)); set("--ac2", hsl(c.h, sat, lf - 0.05)); set("--acbd", hsl(c.h, sat, lf - 0.22, 0.7));
    set("--fsh", "hsla(" + Math.round(c.h) + ",45%,28%,.35)"); set("--lite", hsl(c.h, sat, Math.min(0.86, lm + 0.2))); set("--folder", hsl(c.h, 0.55, 0.68));
    if (f0) { f0.setAttribute("stop-color", hsl(c.h, 0.8, 0.82)); f1.setAttribute("stop-color", hsl(c.h, 0.62, 0.64)); }
  }
  var THEME = store.get("theme", null);
  applyTheme(THEME);
  if (window.matchMedia) { try { window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () { applyTheme(THEME); }); } catch (e) {} }
  function openThemeSheet() {
    function html() {
      return '<h3>테마 색</h3><div class="body"><div class="swatches">' + THEMES.map(function (t) { return '<button style="background:' + t[1] + '" data-c="' + t[1] + '" aria-label="' + t[0] + '" class="' + (THEME === t[1] || (!THEME && t[1] === "#3d8bfd") ? "on" : "") + '"></button>'; }).join("") + '</div>' +
        '<div class="themecust"><label>직접 고르기</label><input type="color" id="thC" value="' + (THEME || "#3d8bfd") + '"><button class="thr" id="thReset">기본(파랑)으로</button></div></div><div class="btns"><button class="pri" data-done="1">완료</button></div>';
    }
    return sheet(html(), function (el, close) {
      function bind() {
        el.querySelectorAll(".swatches [data-c]").forEach(function (b) { b.onclick = function () { THEME = b.dataset.c; store.set("theme", THEME); applyTheme(THEME); el.innerHTML = html(); bind(); }; });
        el.querySelector("#thC").oninput = function () { THEME = this.value; store.set("theme", THEME); applyTheme(THEME); el.querySelectorAll(".swatches .on").forEach(function (x) { x.classList.remove("on"); }); };
        el.querySelector("#thReset").onclick = function () { THEME = null; store.set("theme", null); applyTheme(null); el.innerHTML = html(); bind(); };
        el.querySelector("[data-done]").onclick = function () { close(); };
      }
      bind();
    });
  }

  var S = {
    home: "", roots: [], cwd: null, folders: [], files: [],
    sort: store.get("sort", { k: "date", d: -1 }), cols: store.get("cols", 3), names: store.get("names", true),
    sel: new Set(), selOn: false, range: false, anchor: null, last: null,
    trashView: false, trash: [], viewer: null, hideEmpty: store.get("hideEmpty", true), tagView: null, unsorted: false, unsCount: null, album: store.get("album", null), autoMax: store.get("autoMax", 4), fresh: new Set(store.get("fresh", [])), card: store.get("card", false), ci: 0
  };

  /* ---------- 알림 / 창 ---------- */
  var tt;
  function toast(msg, label, fn) {
    var t = $("#toast"); t.innerHTML = esc(msg) + (fn ? '<button type="button">' + esc(label || "되돌리기") + "</button>" : "");
    t.classList.add("show"); clearTimeout(tt);
    if (fn) $("button", t).onclick = function () { t.classList.remove("show"); fn(); };
    tt = setTimeout(function () { t.classList.remove("show"); }, fn ? 7000 : 2400);
  }
  /* 직전 작업 되돌리기 (최근 20개) */
  var UNDO = [];
  function paintUndo() { var b = $("#btnUndo"), l = UNDO[UNDO.length - 1]; if (b) { b.hidden = !l; if (l) b.title = "되돌리기: " + l.label; } }
  function pushUndo(label, fn) { var u = { label: label, fn: fn, done: false }; UNDO.push(u); if (UNDO.length > 20) UNDO.shift(); paintUndo(); return u; }
  function runUndo(u) { if (!u || u.done) return Promise.resolve(); u.done = true; UNDO = UNDO.filter(function (x) { return x !== u; }); paintUndo(); return Promise.resolve(u.fn()).catch(err); }
  var sheetClose = null;
  function sheet(html, onOpen) {
    return new Promise(function (res) {
      var w = $("#sheetWrap"); $("#sheet").innerHTML = html; w.hidden = false;
      function close(v) { w.hidden = true; $("#sheet").innerHTML = ""; sheetClose = null; w.onclick = null; res(v); }
      sheetClose = function () { close(undefined); };
      w.onclick = function (e) { if (e.target === w) close(undefined); };
      onOpen && onOpen($("#sheet"), close);
    });
  }
  function askText(title, def, ok) {
    return sheet("<h3>" + esc(title) + '</h3><input type="text" id="aIn" value="' + esc(def || "") + '"><div class="btns"><button data-v="">취소</button><button class="pri" data-v="1">' + esc(ok || "확인") + "</button></div>", function (el, close) {
      var inp = $("#aIn", el); setTimeout(function () { inp.focus(); inp.select(); }, 60);
      inp.onkeydown = function (e) { if (e.key === "Enter") close(inp.value.trim()); };
      el.querySelectorAll("button").forEach(function (b) { b.onclick = function () { close(b.dataset.v ? inp.value.trim() : undefined); }; });
    });
  }
  function confirmBox(title, msg, ok, danger) {
    return sheet("<h3>" + esc(title) + "</h3><p style='margin:0 4px 6px;color:var(--mute)'>" + esc(msg || "") + '</p><div class="btns"><button data-v="">취소</button><button class="pri" ' + (danger ? 'style="background:var(--danger)"' : "") + ' data-v="1">' + esc(ok) + "</button></div>", function (el, close) {
      el.querySelectorAll("button").forEach(function (b) { b.onclick = function () { close(b.dataset.v ? true : undefined); }; });
    });
  }
  function err(e) { toast((e && e.message) || String(e) || "문제가 생겼어요"); }

  /* ---------- 경로 도우미 ---------- */
  function nameOf(p) { return p.slice(p.lastIndexOf("/") + 1); }
  function parentOf(p) { return p.slice(0, p.lastIndexOf("/")); }
  function rootOf(p) { for (var i = 0; i < S.roots.length; i++) if (p === S.roots[i].path || p.indexOf(S.roots[i].path + "/") === 0) return S.roots[i]; return null; }
  function fmtSize(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + "MB" : Math.max(1, Math.round(n / 1024)) + "KB"; }

  /* ---------- 목록 ---------- */
  function sortList() {
    var k = S.sort.k, d = S.sort.d, cmpName = function (a, b) { return a.name.localeCompare(b.name, "ko", { numeric: true }); };
    S.folders.sort(function (a, b) { return k === "date" ? (a.mtime - b.mtime) * d || cmpName(a, b) : cmpName(a, b) * (k === "name" ? d : 1); });
    S.files.sort(function (a, b) {
      var r = k === "name" ? cmpName(a, b) : k === "size" ? a.size - b.size : a.mtime - b.mtime;
      return r * d || cmpName(a, b);
    });
  }
  function saveFresh() { store.set("fresh", Array.from(S.fresh).slice(-800)); }
  function keep(p) { S.fresh.add(p); saveFresh(); }
  function remapFresh(oldP, newP) {
    var out = [], ch = false;
    S.fresh.forEach(function (k) { if (k === oldP || k.indexOf(oldP + "/") === 0) { out.push(newP + k.slice(oldP.length)); ch = true; } else out.push(k); });
    if (ch) { S.fresh = new Set(out); saveFresh(); }
  }
  /* 사진 없는 폴더 숨기기: 사진이 없고 하위 폴더도 없는 빈 폴더만 숨김(하위 폴더를 가진 폴더, 내가 만들거나 이름 바꾼 폴더는 항상 보임) */
  function vis(f) { return !S.hideEmpty || f.has !== false || (f.sub || 0) > 0 || (f.kids && f.kids.length > 0) || S.fresh.has(f.path); }
  function pruneCopy(n) { var c = {}; Object.keys(n).forEach(function (k) { c[k] = n[k]; }); c.kids = (n.kids || []).filter(vis).map(pruneCopy); return c; }
  function prune2(n) { n.kids = (n.kids || []).filter(vis).map(prune2); return n; }
  function order() { return S.folders.concat(S.files); }

  function go(path, keepSel) {
    S.tagView = null; S.unsorted = false; S.trashView = false; document.body.classList.remove("trashv");
    if (!keepSel) clearSel();
    if (path == null) {
      S.cwd = null; S.folders = S.roots.map(function (r) { return { name: r.name, path: r.path, mtime: 0, media: 0, sub: 0, root: true }; }); S.files = [];
      draw(); return Promise.resolve();
    }
    return FS.list({ path: path }).then(function (r) {
      if (S.cwd !== path) S.ci = 0;
      S.cwd = path; S.folders = r.folders.filter(vis); S.files = r.files; sortList(); store.set("cwd", path); draw(); $("#scroll").scrollTop = 0;
    }).catch(function (e) { err(e); if (S.cwd !== path) go(null); });
  }
  function reload() { B.flat = null; if (S.tagView) return loadTagView(); if (S.unsorted) return loadUnsorted(); return S.cwd == null ? go(null, true) : FS.list({ path: S.cwd }).then(function (r) { S.folders = r.folders.filter(vis); S.files = r.files; sortList(); prune(); draw(); }); }
  function prune() { var ok = new Set(order().map(function (x) { return x.path; })); S.sel.forEach(function (p) { if (!ok.has(p)) S.sel.delete(p); }); if (!S.sel.size) S.selOn = false, S.range = false; }

  /* ---------- 그리기 ---------- */
  var COLORS = store.get("fcolor", {});
  var PALETTE = [["빨강", "#ff5f57"], ["주황", "#ff9f0a"], ["노랑", "#f5c400"], ["초록", "#34c759"], ["청록", "#2cb9d6"], ["파랑", "#0a84ff"], ["보라", "#af52de"], ["분홍", "#ff6fa8"], ["회색", "#8e8e93"]];
  function colorOf(p) { return COLORS[p] || null; }
  function colAttr(p) { var c = colorOf(p); return c ? ' style="--fc:' + c + '"' : ""; }
  function saveColors() { store.set("fcolor", COLORS); }
  function remapColors(oldP, newP) {
    remapFresh(oldP, newP); remapPins(oldP, newP);
    var out = {}, ch = false;
    Object.keys(COLORS).forEach(function (k) {
      if (k === oldP || k.indexOf(oldP + "/") === 0) { out[newP + k.slice(oldP.length)] = COLORS[k]; ch = true; } else out[k] = COLORS[k];
    });
    if (ch) { COLORS = out; saveColors(); }
  }
  var FP = "M3 6.5A2.5 2.5 0 0 1 5.5 4H9l2 2.2h7.5A2.5 2.5 0 0 1 21 8.7v8.8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z";
  var FOLDER_SVG = '<svg viewBox="0 0 24 24"><path class="f1" d="' + FP + '"/><path class="f2" d="' + FP + '"/></svg>';
  var io = null, thumbQ = [], active = 0;
  function pump() {
    while (active < 6 && thumbQ.length) {
      var img = thumbQ.shift(); if (!img.isConnected || img.dataset.state !== "q") continue;
      active++; img.dataset.state = "l";
      (function (im) {
        FS.thumb({ path: im.dataset.p, size: 256 }).then(function (r) { if (im.dataset.state === "l") { im.src = r.data; im.classList.add("ok"); im.dataset.state = "d"; } })
          .catch(function () { im.dataset.state = "x"; }).then(function () { active--; pump(); });
      })(img);
    }
  }
  function ioCallback(es) {
    es.forEach(function (e) {
      var im = e.target.querySelector("img"); if (!im) return;
      if (e.isIntersecting) { if (im.dataset.state === "" || im.dataset.state === "x") { im.dataset.state = "q"; thumbQ.push(im); } }
      else if (im.dataset.state === "d") { im.removeAttribute("src"); im.classList.remove("ok"); im.dataset.state = ""; }
      else if (im.dataset.state === "q") im.dataset.state = "";
    });
    pump();
  }
  function setupIO() {
    if (io) io.disconnect();
    thumbQ = [];
    io = new IntersectionObserver(ioCallback, { root: $("#scroll"), rootMargin: "700px 0px" });
  }
  function itemHtml(x, isFolder) {
    var on = S.sel.has(x.path) ? " on" : "", anc = S.anchor === x.path ? " anchor" : "";
    if (isFolder) {
      var meta = x.root ? "" : (x.media ? x.media + "장" : "") + (x.media && x.sub ? " · " : "") + (x.sub ? "폴더 " + x.sub : "") || "비었어요";
      return '<div class="it folder' + (colorOf(x.path) ? " col" : "") + on + anc + '"' + colAttr(x.path) + ' data-p="' + esc(x.path) + '" data-f="1"><div class="th"><span class="ck"></span>' + FOLDER_SVG + '</div><div class="lb">' + esc(x.name) + (meta ? "<small>" + esc(meta) + "</small>" : "") + "</div></div>";
    }
    return '<div class="it' + on + anc + '" data-p="' + esc(x.path) + '"><div class="th"><img data-p="' + esc(x.path) + '" data-state="" alt=""><span class="ck"></span>' + (tagsOf(x.path).length ? '<span class="tgb">#' + tagsOf(x.path).length + "</span>" : "") + (x.video ? '<span class="vid">영상</span>' : "") + '</div><div class="lb">' + esc(x.name) + "</div></div>";
  }
  function draw() {
    document.body.classList.toggle("selecting", S.selOn);
    document.body.classList.toggle("hasSel", S.sel.size > 0);
    document.body.classList.toggle("names", S.names);
    document.body.classList.toggle("card", cardOn()); paintModes();
    document.documentElement.style.setProperty("--cols", S.cols);
    // 위쪽 길 표시
    var c = $("#crumb"), html = '<button data-go="">홈</button>';
    $("#btnUp").classList.toggle("dim", upTarget() == null);
    $("#ttl").textContent = S.trashView ? "휴지통" : S.unsorted ? "미분류" : S.tagView ? S.tagView.tags.map(function (t) { return "#" + t; }).join(" ") : S.cwd == null ? "홈" : nameOf(S.cwd);
    if (S.tagView) html = '<button>' + (S.tagView.mode === "and" ? "모두 있는" : "하나라도") + ' · ' + S.files.length + '장</button><i>·</i><button data-exittag="1" style="color:var(--accent)">폴더로 돌아가기</button>';
    else if (S.unsorted) html = '<button>앨범 밖 사진 · ' + S.files.length + '장</button><i>·</i><button data-exittag="1" style="color:var(--accent)">폴더로 돌아가기</button>';
    else if (S.trashView) html += "<i>›</i><button>휴지통</button>";
    else if (S.cwd != null) {
      var r = rootOf(S.cwd);
      if (r) {
        html += "<i>›</i><button data-go=\"" + esc(r.path) + '">' + esc(r.name) + "</button>";
        var rest = S.cwd.slice(r.path.length + 1), acc = r.path;
        if (rest) rest.split("/").forEach(function (seg) { acc += "/" + seg; html += "<i>›</i><button data-go=\"" + esc(acc) + '">' + esc(seg) + "</button>"; });
      }
    }
    c.innerHTML = html;
    var last = c.lastElementChild; if (last && last.scrollIntoView) c.scrollLeft = c.scrollWidth;
    // 선택 막대
    $("#selN").textContent = S.sel.size + "개 선택";
    $("#btnRange").classList.toggle("on", S.range);
    $("#hint").classList.toggle("show", S.range);
    $("#hint").textContent = S.range ? (S.anchor ? "끝 사진을 눌러 주세요" : "시작 사진을 눌러 주세요") : "";
    actionsPaint();
    // 목록
    var g = $("#grid"); g.classList.toggle("trash", S.trashView);
    var list = S.trashView ? S.trash : null, h = "";
    if (S.trashView) {
      list.forEach(function (t) { h += t.dir ? itemHtml({ name: t.name, path: t.id, media: 0, sub: 0 }, true) : itemHtml({ name: t.name, path: t.id, video: t.video, _tp: t.path }, false); });
      g.innerHTML = h;
      // 휴지통 썸네일은 실제 위치로
      g.querySelectorAll("img").forEach(function (im) { var t = S.trash.filter(function (x) { return x.id === im.dataset.p; })[0]; if (t) im.dataset.p = t.path; });
    } else {
      S.folders.forEach(function (f) { h += itemHtml(f, true); });
      S.files.forEach(function (f) { h += itemHtml(f, false); });
      g.innerHTML = h;
    }
    setupIO(); g.querySelectorAll(".it").forEach(function (n) { io.observe(n); });
    var em = $("#empty"), n = S.trashView ? S.trash.length : S.folders.length + S.files.length;
    if (cardOn()) drawCard();
    em.hidden = n > 0; em.textContent = S.trashView ? "휴지통이 비었어요 (30일 지나면 자동으로 지워져요)" : S.unsorted ? "앨범 밖에 남은 사진이 없어요. 모두 정리했어요!" : S.tagView ? "이 태그가 붙은 사진이 없어요" : "이 폴더에는 사진이 없어요";
  }
  function paintSel() {
    document.body.classList.toggle("selecting", S.selOn);
    document.body.classList.toggle("hasSel", S.sel.size > 0);
    $("#selN").textContent = S.sel.size + "개 선택";
    $("#btnRange").classList.toggle("on", S.range);
    $("#hint").classList.toggle("show", S.range);
    $("#hint").textContent = S.range ? (S.anchor ? "끝 사진을 눌러 주세요" : "시작 사진을 눌러 주세요") : "";
    actionsPaint();
    document.querySelectorAll("#grid .it").forEach(function (n) {
      n.classList.toggle("on", S.sel.has(n.dataset.p));
      n.classList.toggle("anchor", S.anchor === n.dataset.p);
    });
  }
  function clearSel() { S.sel.clear(); S.selOn = false; S.range = false; S.anchor = null; S.last = null; }

  /* ---------- 고르기 ---------- */
  function ids() { return S.trashView ? S.trash.map(function (t) { return t.id; }) : order().map(function (x) { return x.path; }); }
  function toggle(p) {
    if (S.range) {
      if (!S.anchor) { S.anchor = p; S.sel.add(p); S.last = p; paintSel(); return; }
      var v = ids(), a = v.indexOf(S.anchor), b = v.indexOf(p);
      if (a > -1 && b > -1) v.slice(Math.min(a, b), Math.max(a, b) + 1).forEach(function (x) { S.sel.add(x); });
      S.range = false; S.anchor = null; S.last = p; paintSel(); return;
    }
    if (S.sel.has(p)) S.sel.delete(p); else S.sel.add(p);
    S.last = p;
    if (!S.sel.size) { S.selOn = false; }
    paintSel();
  }
  function startSel(p) { S.selOn = true; S.sel.add(p); S.last = p; if (navigator.vibrate) try { navigator.vibrate(12); } catch (e) {} paintSel(); }

  /* 누르기 / 꾹 누르기 / 끌어서 폴더에 놓기 */
  var press = null, suppress = false, drag = null, auto = 0, autoEl = null, raf = 0;
  var grid = $("#grid"), ghost = $("#ghost");
  grid.addEventListener("pointerdown", function (e) {
    var it = e.target.closest(".it"); if (!it) return;
    press = { it: it, x: e.clientX, y: e.clientY, t: setTimeout(function () {
      if (!press) return; suppress = true;
      var p = it.dataset.p, px = press.x, py = press.y;
      if (!S.selOn) startSel(p); else if (!S.sel.has(p)) toggle(p);
      if (!S.trashView && S.sel.size) drag = { x: px, y: py, on: false, target: null };
      press = null;
    }, 380) };
  });
  grid.addEventListener("pointermove", function (e) { if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 9) { clearTimeout(press.t); press = null; } });
  ["pointerup", "pointercancel", "pointerleave"].forEach(function (ev) { grid.addEventListener(ev, function () { if (press) { clearTimeout(press.t); press = null; } }); });
  function dropAt(x, y) {
    var el = document.elementFromPoint(x, y); if (!el) return null;
    var t = el.closest(".it.folder");
    if (t && t.dataset.p && !S.sel.has(t.dataset.p)) return { el: t, path: t.dataset.p };
    var c = el.closest("#crumb [data-go], #crumbB [data-go]");
    if (c && c.dataset.go) return { el: c, path: c.dataset.go };
    var bs = el.closest("#bscroll");
    if (bs && S.split && S.cwd2 != null) return { el: bs, path: S.cwd2 };
    return null;
  }
  function autoLoop() { if (!drag || !drag.on) { raf = 0; return; } if (auto && autoEl) autoEl.scrollTop += auto; raf = requestAnimationFrame(autoLoop); }
  function dragEnd(drop) {
    var d = drag; drag = null; auto = 0; ghost.style.display = "none"; document.body.classList.remove("dragging");
    document.querySelectorAll(".drop").forEach(function (n) { n.classList.remove("drop"); });
    if (suppress) setTimeout(function () { suppress = false; }, 350);
    if (d && d.on && drop && d.target) { if (d.card) cardMove(d.target.path); else moveInto(selPaths(), d.target.path); }
  }
  window.addEventListener("pointermove", function (e) {
    if (!drag) return;
    if (!drag.on) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 10) return;
      drag.on = true; document.body.classList.add("dragging");
      var first = drag.card ? $("#cImg") : (S.sel.size ? document.querySelector('#grid .it.on img.ok') : null);
      ghost.innerHTML = drag.card ? "" : "<b>" + S.sel.size + "</b>";
      ghost.style.backgroundImage = first && first.src ? 'url("' + first.src + '")' : "none";
      ghost.style.display = "block";
      if (navigator.vibrate) try { navigator.vibrate(10); } catch (x) {}
      if (!raf) raf = requestAnimationFrame(autoLoop);
    }
    ghost.style.left = e.clientX + "px"; ghost.style.top = e.clientY + "px";
    var t = dropAt(e.clientX, e.clientY);
    document.querySelectorAll(".drop").forEach(function (n) { if (!t || n !== t.el) n.classList.remove("drop"); });
    if (t) t.el.classList.add("drop");
    drag.target = t;
    var el = document.elementFromPoint(e.clientX, e.clientY), sc = el && el.closest("#scroll, #bscroll");
    auto = 0; autoEl = sc;
    if (sc) {
      var r = sc.getBoundingClientRect(), Zn = 90, mx = S.autoMax;
      if (e.clientY < r.top + Zn) auto = -Math.max(0.6, mx * Math.min(1, (r.top + Zn - e.clientY) / Zn));
      else if (e.clientY > r.bottom - Zn) auto = Math.max(0.6, mx * Math.min(1, (e.clientY - (r.bottom - Zn)) / Zn));
    }
  });
  window.addEventListener("pointerup", function () { if (drag) dragEnd(true); });
  window.addEventListener("pointercancel", function () { if (drag) dragEnd(false); });
  document.addEventListener("touchmove", function (e) { if (drag) e.preventDefault(); }, { passive: false });
  grid.addEventListener("contextmenu", function (e) { e.preventDefault(); });
  grid.addEventListener("click", function (e) {
    var it = e.target.closest(".it"); if (!it) return;
    if (suppress) { suppress = false; return; }
    var p = it.dataset.p;
    if (S.selOn) { toggle(p); return; }
    if (S.trashView) { startSel(p); return; }
    if (it.dataset.f) { go(p); return; }
    openViewer(p);
  });

  /* ---------- 위쪽 버튼 ---------- */
  $("#crumb").addEventListener("click", function (e) {
    if (e.target.closest("[data-exittag]")) { go(S.cwd); return; }
    var b = e.target.closest("[data-go]"); if (!b) return; go(b.dataset.go || null);
  });
  function upTarget() {
    if (S.tagView || S.unsorted || S.trashView) return "exit";
    if (S.cwd == null) return null;
    var r = rootOf(S.cwd); return r && r.path === S.cwd ? "home" : parentOf(S.cwd);
  }
  $("#btnUp").onclick = function () {
    var t = upTarget(); if (t == null) { toast("이미 맨 위예요"); return; }
    if (t === "exit") go(S.cwd); else if (t === "home") go(null); else go(t);
  };
  $("#btnClear").onclick = function () { clearSel(); paintSel(); };
  $("#btnAll").onclick = function () { var v = ids(); if (S.sel.size === v.length) { clearSel(); } else { v.forEach(function (x) { S.sel.add(x); }); S.selOn = true; } paintSel(); };
  $("#btnRange").onclick = function () { S.range = !S.range; S.anchor = null; paintSel(); };
  $("#btnSort").onclick = openSort;
  /* 위에서 펼쳐지는 작은 메뉴 */
  function closePop() { $("#pop").hidden = true; $("#pop").innerHTML = ""; $("#popScrim").hidden = true; }
  function popMenu(anchor, html, bind) {
    var pop = $("#pop"); pop.innerHTML = html; pop.hidden = false; $("#popScrim").hidden = false;
    var r = anchor.getBoundingClientRect();
    pop.style.left = "auto"; pop.style.top = (r.bottom + 6) + "px"; pop.style.right = Math.max(8, window.innerWidth - r.right) + "px";
    bind && bind(pop);
  }
  function popAt(x, y, html, bind) {
    var pop = $("#pop"); pop.innerHTML = html; pop.hidden = false; $("#popScrim").hidden = false;
    pop.style.right = "auto"; pop.style.left = "0px"; pop.style.top = "0px";
    var w = pop.offsetWidth, h = pop.offsetHeight;
    pop.style.left = Math.max(8, Math.min(x, window.innerWidth - w - 8)) + "px"; pop.style.top = Math.max(8, Math.min(y, window.innerHeight - h - 8)) + "px";
    bind && bind(pop);
  }
  function longPress(el, ms, pick, fire) {
    var t = null, sx = 0, sy = 0;
    el.addEventListener("pointerdown", function (e) {
      var c = pick(e); if (!c) return; sx = e.clientX; sy = e.clientY; clearTimeout(t);
      t = setTimeout(function () { t = null; fire(sx, sy, c); }, ms);
    });
    el.addEventListener("pointermove", function (e) { if (t && Math.hypot(e.clientX - sx, e.clientY - sy) > 9) { clearTimeout(t); t = null; } });
    ["pointerup", "pointercancel", "pointerleave"].forEach(function (ev) { el.addEventListener(ev, function () { if (t) { clearTimeout(t); t = null; } }); });
  }
  $("#popScrim").onclick = closePop;
  if ($("#btnUndo")) $("#btnUndo").onclick = function () { var u = UNDO[UNDO.length - 1]; if (u) runUndo(u); };
  $("#btnMore").onclick = function () {
    var ul = UNDO[UNDO.length - 1];
    popMenu(this, '<button class="mi"' + (ul ? "" : " disabled") + ' data-m="undo">↶ 되돌리기' + (ul ? " · " + esc(ul.label) : "") + '</button><div class="msep"></div><button class="mi" data-m="mk">＋ 새 폴더 만들기</button><button class="mi" data-m="trash">휴지통 보기</button><div class="msep"></div><button class="mi' + (S.hideEmpty ? " on" : "") + '" data-m="empty">사진 없는 폴더 숨기기</button><div class="msep"></div><button class="mi" data-m="album">정리 폴더 지정 (지금: ' + esc(nameOf(albumPath()) || "없음") + ')</button><button class="mi" data-m="theme">테마 색…</button><button class="mi" data-m="re">새로고침</button><button class="mi" data-m="perm">파일 접근 권한 확인</button>', function (el) {
      el.querySelectorAll("[data-m]").forEach(function (b) {
        b.onclick = function () {
          var m = b.dataset.m; closePop();
          if (m === "undo") { var u0 = UNDO[UNDO.length - 1]; if (u0) runUndo(u0); }
          else if (m === "mk") { if (S.tagView || S.unsorted) toast("폴더 안에서 만들어 주세요"); else newFolder(S.cwd); }
          else if (m === "album") pickLoop("‘미분류’ 기준이 될 정리 폴더를 골라 주세요", function () { return false; }).then(function (d) { if (!d) return; S.album = d; store.set("album", d); S.unsCount = null; paintUns(); toast("정리 폴더: " + nameOf(d)); countUns(); if (S.unsorted) loadUnsorted(); }).catch(err);
          else if (m === "trash") openTrash();
          else if (m === "empty") { S.hideEmpty = !S.hideEmpty; store.set("hideEmpty", S.hideEmpty); treeCache = null; B.flat = null; Promise.all([reload(), refreshB()]).then(function () { toast(S.hideEmpty ? "사진 없는 폴더를 숨겼어요" : "사진 없는 폴더도 보여요"); }); }
          else if (m === "theme") openThemeSheet();
          else if (m === "re") reload().then(refreshB);
          else if (m === "perm") checkAccess(true);
        };
      });
    });
  };

  function openSort() {
    function draw2() {
      var o = function (grp, val, label) { return '<button data-g="' + grp + '" data-v="' + val + '" class="' + (S.sort[grp] === val ? "on" : "") + '">' + label + "</button>"; };
      return '<div class="opt"><span class="lbl">정렬 기준</span>' + o("k", "name", "이름") + o("k", "date", "날짜") + o("k", "size", "크기") +
        '</div><div class="opt"><span class="lbl">방향</span><button data-g="d" data-v="1" class="' + (S.sort.d === 1 ? "on" : "") + '">오름차순</button><button data-g="d" data-v="-1" class="' + (S.sort.d === -1 ? "on" : "") + '">내림차순</button></div>' +
        '<div class="opt"><span class="lbl">한 줄 칸 수</span>' + [2, 3, 4, 5, 6].map(function (n) { return '<button data-g="c" data-v="' + n + '" class="' + (S.cols === n ? "on" : "") + '">' + n + "</button>"; }).join("") +
        '</div><div class="opt"><span class="lbl">파일 이름</span><button data-g="n" data-v="1" class="' + (S.names ? "on" : "") + '">보이기</button><button data-g="n" data-v="0" class="' + (!S.names ? "on" : "") + '">숨기기</button></div>' +
        '<div class="opt" style="margin-bottom:0"><span class="lbl">끌 때 가장자리 스크롤 속도 <b id="amv">' + S.autoMax + '</b></span><input type="range" id="amr" min="1" max="14" step="1" value="' + S.autoMax + '" style="width:100%"></div>';
    }
    popMenu($("#btnSort"), draw2(), function (el) {
      function bind() {
        el.querySelectorAll("[data-g]").forEach(function (b) {
          b.onclick = function () {
            var g = b.dataset.g, v = b.dataset.v;
            if (g === "k") S.sort.k = v; else if (g === "d") S.sort.d = +v; else if (g === "c") S.cols = +v; else if (g === "n") S.names = v === "1";
            store.set("sort", S.sort); store.set("cols", S.cols); store.set("names", S.names);
            sortList(); draw(); el.innerHTML = draw2(); bind();
          };
        });
        var rg = el.querySelector("#amr");
        if (rg) rg.oninput = function () { S.autoMax = +rg.value; store.set("autoMax", S.autoMax); el.querySelector("#amv").textContent = rg.value; };
      }
      bind();
    });
  }
  $("#btnSort").onclick = openSort;

  /* ---------- 폴더 트리 (왼쪽 메뉴 / 이동할 곳 고르기): 캐시해 두고 바로 보여 준 뒤 뒤에서 새로 읽음 ---------- */
  var treeCache = null, treePromise = null, treeStamp = 0, treeStruct = false, dOpen = {};
  function loadTrees(force, quiet) {
    if (treeCache && !force) return Promise.resolve(treeCache);
    if (treePromise) return treePromise;
    treePromise = Promise.all(S.roots.map(function (r) { return FS.tree({ path: r.path, depth: 8, quiet: quiet }).then(function (x) { x.tree.name = r.name; return x.tree; }); }))
      .then(function (t) { treeCache = t; treeStamp = Date.now(); treeStruct = false; treePromise = null; return t; }, function (e) { treePromise = null; throw e; });
    return treePromise;
  }
  function treeHtml(nodes, opts, depth) {
    return nodes.map(function (n) {
      var has = n.kids && n.kids.length, dis = opts.disabled && opts.disabled(n.path), open = opts.open[n.path], c = colorOf(n.path);
      return '<div class="tk" style="' + (depth ? "" : "margin-left:0") + '"><div class="tn' + (dis ? " dis" : "") + (opts.cur === n.path ? " cur" : "") + '" data-p="' + esc(n.path) + '" data-k="' + (has ? 1 : 0) + '">' +
        '<span class="fi' + (has ? " kids" : "") + (open ? " open" : "") + (c ? " col" : "") + '"' + (c ? ' style="--fc:' + c + '"' : "") + ' data-t="1">' + FOLDER_SVG + '</span>' +
        '<span class="tl"><span class="nm">' + esc(n.name) + '</span></span>' + (n.media ? '<span class="tc">' + n.media + "</span>" : "") + "</div>" +
        (has && open ? treeHtml(n.kids, opts, depth + 1) : "") + "</div>";
    }).join("");
  }
  function bindTree(el, opts, onPick, redraw) {
    el.onclick = function (e) {
      var tn = e.target.closest(".tn"); if (!tn) return;
      var p = tn.dataset.p;
      if (e.target.closest("[data-t]") && tn.dataset.k === "1") { opts.open[p] = !opts.open[p]; redraw(); return; }
      onPick(p);
    };
  }
  function openPathOf(trees, opts) {
    trees.forEach(function (t) { if (S.cwd && (S.cwd === t.path || S.cwd.indexOf(t.path + "/") === 0)) { var acc = t.path; opts.open[acc] = true; S.cwd.slice(t.path.length + 1).split("/").forEach(function (x) { if (x) { acc += "/" + x; opts.open[acc] = true; } }); } });
  }
  function openDrawer() {
    var el = $("#drawerTree"), opts = { open: dOpen, cur: S.cwd };
    $("#drawer").classList.add("show"); $("#scrim").classList.add("show");
    function render(raw) { var trees = S.hideEmpty ? raw.map(pruneCopy) : raw; openPathOf(trees, opts); el.innerHTML = treeHtml(trees, opts, 0); bindTree(el, opts, function (p) { closeDrawer(); go(p); }, function () { render(raw); }); }
    if (treeCache) {
      render(treeCache);
      if (treeStruct || Date.now() - treeStamp > 20000) loadTrees(true, true).then(function (t) { if ($("#drawer").classList.contains("show") && $("#dq").value.trim() === "") render(t); }).catch(function () {});
    } else {
      el.innerHTML = '<div class="rempty">폴더를 불러오는 중…</div>';
      loadTrees(true).then(render).catch(err);
    }
  }
  function closeDrawer() { $("#drawer").classList.remove("show"); $("#scrim").classList.remove("show"); }
  $("#btnTree").onclick = openDrawer; $("#scrim").onclick = closeDrawer; document.querySelector("[data-close=drawer]").onclick = closeDrawer;

  /* ---------- 태그 (이 앱 안에 저장) ---------- */
  var TAGS = store.get("tags", {});
  function tagHue(t) { var n = 0; for (var i = 0; i < t.length; i++) n = (n * 31 + t.charCodeAt(i)) % 360; return n; }
  function saveTags() { store.set("tags", TAGS); }
  function tagsOf(p) { return TAGS[p] || []; }
  function allTags() { var m = {}; Object.keys(TAGS).forEach(function (p) { TAGS[p].forEach(function (t) { m[t] = (m[t] || 0) + 1; }); }); return m; }
  function cleanTag(x) { return String(x).replace(/^#+/, "").trim().replace(/\s+/g, "_").replace(/[^\p{L}\p{N}_\-]/gu, "").slice(0, 24); }
  function remapTags(oldP, newP) {
    var out = {}, ch = false;
    Object.keys(TAGS).forEach(function (k) {
      if (k === oldP || k.indexOf(oldP + "/") === 0) { out[newP + k.slice(oldP.length)] = TAGS[k]; ch = true; } else out[k] = TAGS[k];
    });
    if (ch) { TAGS = out; saveTags(); }
  }
  function openTagSheet(paths) {
    var snap = {}, changed = false;
    paths.forEach(function (p) { snap[p] = tagsOf(p).slice(); });
    function state(t) { var n = paths.filter(function (p) { return tagsOf(p).indexOf(t) >= 0; }).length; return n === paths.length ? "all" : n ? "some" : "none"; }
    function put(p, t, on) { var a = tagsOf(p).slice(), i = a.indexOf(t); if (on && i < 0) a.push(t); if (!on && i >= 0) a.splice(i, 1); if (a.length) TAGS[p] = a; else delete TAGS[p]; }
    function html() {
      var at = allTags(), names = Object.keys(at).sort(function (a, b) { return at[b] - at[a] || a.localeCompare(b, "ko"); });
      return "<h3>" + (paths.length > 1 ? paths.length + "장에 태그" : "태그") + '</h3><div class="body"><div class="tagpick">' +
        (names.length ? names.map(function (t) { return '<button class="' + state(t) + '" style="--th:' + tagHue(t) + '" data-t="' + esc(t) + '"><i class="tdot"></i>' + esc(t) + "<small>" + at[t] + "</small></button>"; }).join("") : '<span style="color:var(--mute);font-size:13px">아직 태그가 없어요. 아래에 적어서 만들어 보세요.</span>') +
        '</div><input type="text" id="tgIn" placeholder="새 태그 적고 엔터 (쉼표로 여러 개)"></div><div class="btns"><button class="pri" data-done="1">완료</button></div>';
    }
    return sheet(html(), function (el, close) {
      function bind() {
        el.querySelectorAll(".tagpick [data-t]").forEach(function (b) {
          b.onclick = function () { var t = b.dataset.t, on = state(t) !== "all"; paths.forEach(function (p) { put(p, t, on); }); changed = true; saveTags(); el.innerHTML = html(); bind(); };
        });
        var inp = el.querySelector("#tgIn");
        inp.onkeydown = function (e) {
          if (e.key !== "Enter") return;
          var list = inp.value.split(/[,，\n]/).map(cleanTag).filter(Boolean); if (!list.length) return;
          list.forEach(function (t) { paths.forEach(function (p) { put(p, t, true); }); }); changed = true; saveTags(); el.innerHTML = html(); bind(); el.querySelector("#tgIn").focus();
        };
        el.querySelector("[data-done]").onclick = function () { close(); };
      }
      bind();
    }).then(function () {
      if (!changed) return;
      pushUndo("태그 변경 " + paths.length + "장", function () { paths.forEach(function (p) { if (snap[p].length) TAGS[p] = snap[p]; else delete TAGS[p]; }); saveTags(); draw(); });
      draw();
    });
  }

  /* ---------- 미분류: 정리 폴더(앨범) 밖에 있는 모든 사진 ---------- */
  function albumPath() {
    if (S.album) return S.album;
    var pr = S.roots.filter(function (r) { return r.name === "Pictures"; })[0];
    return pr ? pr.path + "/앨범" : "";
  }
  function unsPath() { var a = albumPath(); return a ? a + "/미분류" : ""; }
  function paintUns() { var t = S.unsCount == null ? "" : String(S.unsCount); $("#dUnsC").textContent = t; $("#tpUnsC").textContent = t; }
  function countUns() { return FS.unsorted({ include: unsPath(), countOnly: true, quiet: true }).then(function (r) { S.unsCount = r.exists ? r.total : null; paintUns(); }).catch(function () {}); }
  function loadUnsorted() {
    return FS.unsorted({ exclude: albumPath() }).then(function (r) {
      S.folders = []; S.files = r.files; S.unsCount = r.total; paintUns(); sortList(); prune();
      function done() { if (r.total > r.files.length) toast("최신 " + r.files.length + "장만 보여요 (전체 " + r.total + "장)"); }
      if (r.files.length > 800) {
        busyStart("목록 그리는 중 (" + r.files.length + "장)");
        return new Promise(function (ok) { setTimeout(function () { try { draw(); $("#scroll").scrollTop = 0; } finally { busyEnd(); done(); ok(); } }, 40); });
      }
      draw(); $("#scroll").scrollTop = 0; done();
    });
  }
  /* 미분류 = 정리 폴더(앨범) 안의 ‘미분류’ 폴더. 없으면 만들어 줌 */
  function openUnsorted() {
    var p = unsPath(); if (!p) { toast("정리 폴더를 먼저 지정해 주세요 (⋯ 메뉴)"); return Promise.resolve(); }
    function enter() {
      if (S.split) { var a = albumPath(); if (a && !(S.cwd2 && (S.cwd2 === a || S.cwd2.indexOf(a + "/") === 0))) goB(a); }
      return go(p);
    }
    return FS.unsorted({ include: p, countOnly: true }).then(function (r) {
      if (r.exists) return enter();
      return confirmBox("‘미분류’ 폴더가 없어요", "‘" + nameOf(albumPath()) + "’ 안에 ‘미분류’ 폴더를 만들까요? 아직 정리 못 한 사진을 여기에 모아 두고 캐릭터 폴더로 옮기는 용도예요.", "만들기").then(function (ok) {
        if (!ok) return;
        return FS.mkdir({ parent: albumPath(), name: "미분류" }).then(function (m) { keep(m.path); treeStruct = true; S.unsCount = 0; paintUns(); return enter(); });
      });
    }).catch(err);
  }
  $("#dUns").onclick = function () { closeDrawer(); openUnsorted(); };
  $("#tpUns").onclick = function () { closeTagPanel(); openUnsorted(); };

  /* ---------- 왼쪽 도구: 태그 모아 보기 ---------- */
  var TP = { sel: [], mode: "or", q: "" };
  function loadTagView() {
    var tv = S.tagView; if (!tv) return Promise.resolve();
    var paths = Object.keys(TAGS).filter(function (p) {
      var t = TAGS[p];
      return tv.mode === "and" ? tv.tags.every(function (x) { return t.indexOf(x) >= 0; }) : tv.tags.some(function (x) { return t.indexOf(x) >= 0; });
    });
    return FS.stat({ paths: paths }).then(function (r) {
      S.folders = []; S.files = r.files; sortList(); prune(); draw(); $("#scroll").scrollTop = 0;
    });
  }
  function openTagView(tags, mode) {
    clearSel(); S.trashView = false; document.body.classList.remove("trashv");
    S.tagView = { tags: tags.slice(), mode: mode }; S.ci = 0;
    return loadTagView().catch(err);
  }
  function drawTagList() {
    var at = allTags(), q = TP.q.trim(), jamo = /^[ㄱ-ㅎ]+$/.test(q);
    var names = Object.keys(at).filter(function (t) { return !q || (jamo ? cho(t).indexOf(q) >= 0 : t.toLowerCase().indexOf(q.toLowerCase()) >= 0); }).sort(function (a, b) { return at[b] - at[a] || a.localeCompare(b, "ko"); });
    $("#tagList").innerHTML = names.length ? names.map(function (t) {
      return '<div class="tgrow' + (TP.sel.indexOf(t) >= 0 ? " on" : "") + '" data-t="' + esc(t) + '" style="--th:' + tagHue(t) + '"><span class="tgd"></span><span class="tgn">' + esc(t) + '</span><span class="tgk">' + at[t] + '</span><span class="tgc"></span></div>';
    }).join("") : '<div class="tp-empty"><svg viewBox="0 0 24 24"><path d="M3.5 12.2V4.5a1 1 0 0 1 1-1h7.7a1 1 0 0 1 .7.3l7.6 7.6a1 1 0 0 1 0 1.4l-7.7 7.7a1 1 0 0 1-1.4 0L3.8 12.9a1 1 0 0 1-.3-.7z"/><circle cx="8.3" cy="8.3" r="1.3"/></svg>' + (Object.keys(at).length ? "맞는 태그가 없어요" : "아직 태그가 없어요<br><small>사진을 길게 눌러 고른 뒤<br>아래 ‘태그’ 버튼으로 만들어 보세요</small>") + "</div>";
    $("#tpCount").textContent = Object.keys(at).length ? Object.keys(at).length + "개" : "";
    document.querySelectorAll("#tagPanel [data-tm]").forEach(function (b) { b.classList.toggle("on", b.dataset.tm === TP.mode); });
    $("#tpShow").textContent = TP.sel.length ? "모아 보기 · " + TP.sel.length + "개 선택" : "모아 보기"; $("#tpShow").classList.toggle("dim", !TP.sel.length); $("#tpClear").style.visibility = TP.sel.length ? "visible" : "hidden";
  }
  function openTagPanel() {
    var at = allTags(); TP.sel = TP.sel.filter(function (t) { return at[t]; }); TP.q = ""; $("#tq").value = "";
    drawTagList(); $("#tagPanel").classList.add("show"); $("#scrim").classList.add("show");
  }
  function closeTagPanel() { $("#tagPanel").classList.remove("show"); if (!$("#drawer").classList.contains("show")) $("#scrim").classList.remove("show"); }
  $("#btnTags").onclick = openTagPanel;
  document.querySelector("[data-close=tagpanel]").onclick = closeTagPanel;
  $("#scrim").onclick = function () { closeDrawer(); closeTagPanel(); };
  $("#tq").addEventListener("input", function () { TP.q = this.value; drawTagList(); });
  $("#tagList").addEventListener("click", function (e) {
    var r = e.target.closest(".tgrow"); if (!r) return; var t = r.dataset.t, i = TP.sel.indexOf(t);
    if (i >= 0) TP.sel.splice(i, 1); else TP.sel.push(t); drawTagList();
  });
  document.querySelectorAll("#tagPanel [data-tm]").forEach(function (b) { b.onclick = function () { TP.mode = b.dataset.tm; drawTagList(); }; });
  $("#tpClear").onclick = function () { TP.sel = []; drawTagList(); };
  $("#tpShow").onclick = function () {
    if (!TP.sel.length) { toast("보고 싶은 태그를 골라 주세요"); return; }
    closeTagPanel(); openTagView(TP.sel, TP.mode);
  };

  /* ---------- 왼쪽 메뉴 검색: 폴더·사진 이름(초성 가능)·태그 ---------- */
  var dTok = 0, dTimer = null, ioD = null;
  function relPath(p) { var r = rootOf(p); return (r ? r.name + p.slice(r.path.length) : p).split("/").join(" › "); }
  function rowHtml(kind, x) {
    var c = kind === "folder" ? colorOf(x.path) : null;
    var th = kind === "folder" ? '<span class="fi' + (c ? " col" : "") + '"' + (c ? ' style="--fc:' + c + '"' : "") + ">" + FOLDER_SVG + "</span>" : '<img data-p="' + esc(x.path) + '" data-state="" alt="">';
    var tg = kind === "file" ? tagsOf(x.path).map(function (t) { return "#" + t; }).join(" ") : "";
    return '<div class="rrow" data-k="' + kind + '" data-p="' + esc(x.path) + '"><div class="rt">' + th + '</div><div class="rx"><div class="rn">' + esc(x.name) + '</div><div class="rp">' + esc(x.parent || "") + (tg ? " · " + esc(tg) : "") + "</div></div></div>";
  }
  function showSearch(html) {
    $("#drawerTree").hidden = true; var r = $("#dres"); r.hidden = false; r.innerHTML = html;
    if (ioD) ioD.disconnect();
    ioD = new IntersectionObserver(ioCallback, { root: r, rootMargin: "300px 0px" });
    r.querySelectorAll(".rrow").forEach(function (n) { ioD.observe(n); });
  }
  function matchTag(t, q) { var l = q.toLowerCase(), jamo = /^[ㄱ-ㅎ]+$/.test(q); return jamo ? cho(t).indexOf(q) >= 0 : t.toLowerCase().indexOf(l) >= 0; }
  function runSearch(q) {
    var tok = ++dTok, tagOnly = q.charAt(0) === "#", tq = tagOnly ? q.slice(1) : q;
    var at = allTags(), names = Object.keys(at).filter(function (t) { return !tq || matchTag(t, tq); }).sort(function (a, b) { return at[b] - at[a]; });
    var tagged = [];
    if (tagOnly || names.length) Object.keys(TAGS).forEach(function (p) { if (TAGS[p].some(function (t) { return names.indexOf(t) >= 0; }) && (tagOnly || true)) tagged.push({ name: nameOf(p), path: p, parent: relPath(parentOf(p)) }); });
    return (tagOnly || !q ? Promise.resolve({ folders: [], files: [] }) : FS.search({ q: q })).then(function (r) {
      if (tok !== dTok) return;
      var seen = {}, files = [];
      tagged.slice(0, 200).concat(r.files).forEach(function (f) { if (!seen[f.path]) { seen[f.path] = 1; files.push(f); } });
      var html = "";
      if (names.length) html += '<div class="rsec">태그</div><div style="padding:0 6px">' + names.slice(0, 20).map(function (t) { return '<button class="tagchip" style="--th:' + tagHue(t) + '" data-tag="' + esc(t) + '">#' + esc(t) + " " + at[t] + "</button>"; }).join("") + "</div>";
      if (r.folders.length) html += '<div class="rsec">폴더 ' + r.folders.length + "</div>" + r.folders.map(function (x) { return rowHtml("folder", x); }).join("");
      if (files.length) html += '<div class="rsec">사진 ' + files.length + (files.length >= 400 ? "+" : "") + "</div>" + files.map(function (x) { return rowHtml("file", x); }).join("");
      if (!html) html = '<div class="rempty">찾는 결과가 없어요</div>';
      showSearch(html);
    }).catch(err);
  }
  $("#dq").addEventListener("input", function () {
    clearTimeout(dTimer); var q = this.value.trim();
    $("#dUns").hidden = !!q;
    if (!q) { dTok++; $("#dres").hidden = true; $("#drawerTree").hidden = false; return; }
    dTimer = setTimeout(function () { runSearch(q); }, 230);
  });
  $("#dres").addEventListener("click", function (e) {
    var tg = e.target.closest("[data-tag]"); if (tg) { $("#dq").value = "#" + tg.dataset.tag; runSearch("#" + tg.dataset.tag); return; }
    var row = e.target.closest(".rrow"); if (!row) return;
    var p = row.dataset.p; closeDrawer();
    if (row.dataset.k === "folder") { go(p); return; }
    go(parentOf(p)).then(function () {
      if (cardOn()) { var i = cardList().findIndex(function (f) { return f.path === p; }); if (i >= 0) { S.ci = i; drawCard(); } }
      else openViewer(p);
    });
  });

  function pickFolder(title, disabledFn) {
    return loadTrees(treeStruct).then(function (trees) {
      return sheet("<h3>" + esc(title) + '</h3><div class="body" id="pkTree"></div><div class="btns"><button data-x="c">취소</button><button data-x="mk">＋ 새 폴더</button><button class="pri" data-x="ok" disabled style="opacity:.4">여기로 이동</button></div>', function (el, close) {
        var opts = { open: {}, cur: null, disabled: disabledFn }, box = $("#pkTree", el), okb = $("[data-x=ok]", el);
        if (S.cwd) trees.forEach(function (t) { if (S.cwd === t.path || S.cwd.indexOf(t.path + "/") === 0) { var acc = t.path; opts.open[acc] = true; S.cwd.slice(t.path.length + 1).split("/").forEach(function (s) { if (s) { acc += "/" + s; opts.open[acc] = true; } }); } });
        function redraw() { box.innerHTML = treeHtml(trees, opts, 0); }
        redraw();
        bindTree(box, opts, function (p) { opts.cur = p; okb.disabled = false; okb.style.opacity = 1; redraw(); }, redraw);
        el.querySelector("[data-x=c]").onclick = function () { close(); };
        okb.onclick = function () { if (opts.cur) close(opts.cur); };
        el.querySelector("[data-x=mk]").onclick = function () {
          if (!opts.cur) { toast("먼저 만들 위치의 폴더를 눌러 주세요"); return; }
          close({ mk: opts.cur });
        };
      });
    });
  }
  /* 이동할 곳 고르기 — 새 폴더를 만들면 같은 창을 다시 열어 이어서 고름 */
  function pickLoop(title, dis) {
    return pickFolder(title, dis).then(function (r) {
      if (r && r.mk) {
        return askText("새 폴더 이름", "", "만들기").then(function (n) {
          return (n ? FS.mkdir({ parent: r.mk, name: n }).then(function (m) { keep(m.path); }) : Promise.resolve()).then(function () { return pickLoop(title, dis); });
        });
      }
      return r;
    });
  }

  /* ---------- 동작: 이동 / 삭제 / 이름 / 새 폴더 ---------- */
  function selHasFile() { return !S.trashView && S.files.some(function (f) { return S.sel.has(f.path); }); }
  function actionsPaint() {
    var rn = $("#actions [data-a=rename]"); rn.style.display = S.sel.size >= 1 && !S.trashView ? "" : "none"; rn.textContent = S.sel.size > 1 ? "이름 일괄" : "이름 바꾸기";
    $("#actions [data-a=color]").style.display = selHasFolder() ? "" : "none";
    $("#actions [data-a=tag]").style.display = selHasFile() ? "" : "none";
  }
  function selHasFolder() { return !S.trashView && S.folders.some(function (f) { return S.sel.has(f.path); }); }
  function pickColor(paths) {
    var cur = paths.length === 1 ? colorOf(paths[0]) : null;
    return sheet('<h3>폴더 색</h3><div class="swatches">' + PALETTE.map(function (c) { return '<button style="background:' + c[1] + '" data-c="' + c[1] + '" aria-label="' + c[0] + '" class="' + (cur === c[1] ? "on" : "") + '"></button>'; }).join("") + '<button class="none" data-c="">기본</button></div>', function (el, close) {
      el.querySelectorAll("[data-c]").forEach(function (b) { b.onclick = function () { close({ c: b.dataset.c }); }; });
    }).then(function (r) {
      if (!r) return;
      paths.forEach(function (p) { if (r.c) COLORS[p] = r.c; else delete COLORS[p]; });
      saveColors(); draw(); drawB(); clearSel(); paintSel(); toast(r.c ? "폴더 색을 바꿨어요" : "기본 색으로 돌렸어요");
    });
  }
  function doTag() { var ps = selPaths().filter(function (p) { return S.files.some(function (f) { return f.path === p; }); }); if (ps.length) openTagSheet(ps); }
  function doColor() { var ps = selPaths().filter(function (p) { return S.folders.some(function (f) { return f.path === p; }); }); if (ps.length) pickColor(ps); }
  function selPaths() { return Array.from(S.sel); }
  function noteRecent(dest) {
    B.recent = [dest].concat(B.recent.filter(function (p) { return p !== dest; })).slice(0, 24); store.set("recent", B.recent);
  }
  function moveInto(paths, dest) {
    if (!paths.length) return Promise.resolve();
    return FS.move({ paths: paths, dest: dest }).then(function (r) {
      clearSel(); noteRecent(dest); r.moved.forEach(function (m) { remapColors(m.from, m.to); remapTags(m.from, m.to); if (S.folders.some(function (f) { return f.path === m.from; })) treeStruct = true; });
      return Promise.all([reload(), refreshB()]).then(function () {
        var n = r.moved.length, bad = r.failed.length;
        var u = n ? pushUndo(n + "개를 ‘" + nameOf(dest) + "’(으)로 이동", function () { return undoMove(r.moved); }) : null;
        toast(n ? n + "개를 ‘" + nameOf(dest) + "’(으)로 옮겼어요" + (bad ? " (실패 " + bad + ")" : "") : (bad ? r.failed[0].error : "이미 그 폴더에 있어요"), "되돌리기", u ? function () { runUndo(u); } : null);
      });
    }).catch(err);
  }
  function doMove() {
    var paths = selPaths(); if (!paths.length) return;
    var folders = paths.filter(function (p) { return S.folders.some(function (f) { return f.path === p; }); });
    pickLoop(paths.length + "개를 어디로 옮길까요?", function (p) {
      if (p === S.cwd) return true;
      return folders.some(function (f) { return p === f || p.indexOf(f + "/") === 0; });
    }).then(function (dest) { if (dest) return moveInto(paths, dest); }).catch(err);
  }
  function undoMove(moved) {
    moved.forEach(function (m) { remapColors(m.to, m.from); remapTags(m.to, m.from); });
    var by = {}; moved.forEach(function (m) { var d = parentOf(m.from); (by[d] = by[d] || []).push(m.to); });
    return Promise.all(Object.keys(by).map(function (d) { return FS.move({ paths: by[d], dest: d }); })).then(function () { return Promise.all([reload(), refreshB()]); }).then(function () { toast("되돌렸어요"); }).catch(err);
  }
  function restoreIds(ids) { treeStruct = true; return FS.restore({ ids: ids }).then(function () { return Promise.all([reload(), refreshB()]); }).then(function () { toast("복원했어요"); }); }
  function doTrash() {
    var paths = selPaths(); if (!paths.length) return;
    var hasF = paths.some(function (p) { return S.folders.some(function (f) { return f.path === p; }); });
    (hasF ? confirmBox("폴더가 들어 있어요", "고른 폴더와 그 안의 사진이 모두 휴지통으로 가요.", "휴지통으로", true) : Promise.resolve(true)).then(function (ok) {
      if (!ok) return;
      if (hasF) treeStruct = true;
      return FS.trash({ paths: paths }).then(function (r) {
        clearSel(); return reload().then(function () {
          var u = r.ids.length ? pushUndo(r.ids.length + "개 삭제", function () { return restoreIds(r.ids); }) : null;
          toast(r.ids.length + "개를 휴지통으로 보냈어요" + (r.failed.length ? " (실패 " + r.failed.length + ")" : ""), "되돌리기", u ? function () { runUndo(u); } : null);
        });
      });
    }).catch(err);
  }
  function remap(oldP, newP) {
    function f(p) { return p === oldP ? newP : (p && p.indexOf(oldP + "/") === 0 ? newP + p.slice(oldP.length) : p); }
    S.cwd = f(S.cwd); S.cwd2 = f(S.cwd2); store.set("cwd", S.cwd); store.set("cwd2", S.cwd2);
    B.recent = B.recent.map(f); store.set("recent", B.recent);
  }
  function renameItem(p) {
    var wasFolder = S.folders.some(function (f) { return f.path === p; });
    return askText("이름 바꾸기", nameOf(p), "바꾸기").then(function (n) {
      if (!n || n === nameOf(p)) return;
      var old = nameOf(p);
      return FS.rename({ path: p, name: n }).then(function (r) {
        remap(p, r.path); remapColors(p, r.path); remapTags(p, r.path); if (wasFolder) keep(r.path); treeStruct = true; clearSel();
        pushUndo("이름 ‘" + old + "’ → ‘" + n + "’", function () { return FS.rename({ path: r.path, name: old }).then(function (r2) { remap(r.path, r2.path); remapColors(r.path, r2.path); remapTags(r.path, r2.path); treeStruct = true; return Promise.all([reload(), refreshB()]); }).then(function () { toast("이름을 되돌렸어요"); }); });
        return Promise.all([reload(), refreshB()]);
      }).then(function () { toast("이름을 바꿨어요"); });
    }).catch(err);
  }
  /* ---------- 이름 일괄 바꾸기 (폴더·사진 여러 개) ---------- */
  function openBatchRename() {
    var items = order().filter(function (x) { return S.sel.has(x.path); });
    if (items.length < 2) return;
    var isDir = function (p) { return S.folders.some(function (f) { return f.path === p; }); };
    var inUse = {}; S.folders.concat(S.files).forEach(function (x) { if (!S.sel.has(x.path)) inUse[x.name.toLowerCase()] = 1; });
    var plan = [];
    function field(id, label, ph, val, type) { return "<div><label>" + label + '</label><input id="' + id + '" type="' + (type || "text") + '" placeholder="' + esc(ph || "") + '" value="' + esc(val == null ? "" : val) + '"></div>'; }
    var html = "<h3>이름 일괄 바꾸기 · " + items.length + "개</h3><div class=\"body\">" +
      '<div class="brprev" id="brPrev" style="position:sticky;top:0;z-index:2;margin-bottom:8px"></div>' +
      '<div class="brh">① 앞·뒤 지우기</div><div class="brf">' + field("brCut", "이 글자(기호) 앞까지 지우기", "예: _  또는  -") +
      '<div><label>그 글자도 같이 지우기</label><select id="brKeep"><option value="1">예</option><option value="0">아니요</option></select></div>' +
      field("brFront", "앞에서 N글자 지우기", "0", "", "number") + field("brBack", "뒤에서 N글자 지우기", "0", "", "number") + "</div>" +
      '<div class="brh">② 글자 바꾸기</div><div class="brf">' + field("brFind", "찾을 글자", "") + field("brRep", "바꿀 글자", "비우면 지워요") + "</div>" +
      '<div class="brh">③ 번호 붙이기</div><div class="brf">' +
      '<div><label>번호</label><select id="brNum"><option value="0">안 붙임</option><option value="1">붙임</option></select></div>' +
      '<div><label>자리</label><select id="brPos"><option value="front">이름 앞</option><option value="back">이름 뒤</option></select></div>' +
      field("brStart", "시작 번호", "1", "1", "number") + '<div><label>자릿수</label><select id="brDig"><option value="1">1 (1,2,3)</option><option value="2">2 (01,02)</option><option value="3">3 (001)</option><option value="4">4 (0001)</option></select></div>' +
      field("brSep", "번호와 이름 사이", "예: _", "_") + "</div>" +
      '<div class="brh">④ 앞·뒤에 말 붙이기</div><div class="brf">' + field("brPre", "앞에 붙일 말", "") + field("brSuf", "뒤에 붙일 말", "") + "</div>" +
      '</div>' +
      '<div class="btns"><button data-v="">취소</button><button class="pri" id="brGo" data-v="1">바꾸기</button></div>';
    return sheet(html, function (el, close) {
      var F = function (id) { return $("#" + id, el).value; };
      function calc() {
        var cut = F("brCut"), keep = F("brKeep") === "1", fr = parseInt(F("brFront"), 10) || 0, bk = parseInt(F("brBack"), 10) || 0, find = F("brFind"), rep = F("brRep");
        var numOn = F("brNum") === "1", pos = F("brPos"), st = parseInt(F("brStart"), 10); if (isNaN(st)) st = 1;
        var dg = parseInt(F("brDig"), 10) || 1, sep = F("brSep"), pre = F("brPre"), suf = F("brSuf");
        var seen = {}; plan = items.map(function (x, i) {
          var dir = isDir(x.path), ext = "", n = x.name;
          if (!dir) { var d = n.lastIndexOf("."); if (d > 0) { ext = n.slice(d); n = n.slice(0, d); } }
          if (cut) { var ix = n.indexOf(cut); if (ix >= 0) n = n.slice(ix + (keep ? cut.length : 0)); }
          if (fr > 0) n = n.slice(fr);
          if (bk > 0) n = n.slice(0, Math.max(0, n.length - bk));
          if (find) n = n.split(find).join(rep);
          if (numOn) { var num = String(st + i); while (num.length < dg) num = "0" + num; n = pos === "front" ? num + sep + n : n + sep + num; }
          n = (pre + n + suf).trim();
          var nw = n + ext, low = nw.toLowerCase(), bad = !n || /[\/]/.test(n) || !!inUse[low] || !!seen[low];
          seen[low] = 1;
          return { path: x.path, old: x.name, nw: nw, bad: bad, same: nw === x.name };
        });
        var changed = plan.filter(function (r) { return !r.same; }), bads = plan.filter(function (r) { return r.bad && !r.same; });
        var list = plan.slice(0, 40).map(function (r) { return '<div class="' + (r.bad && !r.same ? "bad" : "") + '"><span class="old">' + esc(r.old) + "</span> → " + (r.same ? '<span class="old">그대로</span>' : esc(r.nw || "(비어 있음)") + (r.bad ? " ⚠ 겹치거나 쓸 수 없어요" : "")) + "</div>"; }).join("");
        $("#brPrev", el).innerHTML = (plan.length > 40 ? '<div class="old">앞 40개만 보여요</div>' : "") + list;
        var go = $("#brGo", el); go.disabled = !changed.length || !!bads.length; go.style.opacity = go.disabled ? 0.4 : 1;
        go.textContent = changed.length ? changed.length + "개 바꾸기" : "바꾸기";
      }
      el.querySelectorAll("input,select").forEach(function (n) { n.addEventListener("input", calc); n.addEventListener("change", calc); });
      calc();
      el.querySelectorAll(".btns button").forEach(function (b) { b.onclick = function () { if (b.disabled) return; close(b.dataset.v ? plan.slice() : undefined); }; });
    }).then(function (rows) {
      if (!rows) return;
      var todo = rows.filter(function (r) { return !r.same; });
      var wasF = {}; todo.forEach(function (r) { wasF[r.path] = S.folders.some(function (f) { return f.path === r.path; }); });
      return FS.renameMany({ items: todo.map(function (r) { return { path: r.path, name: r.nw }; }) }).then(function (res) {
        res.renamed.forEach(function (m) { remap(m.from, m.to); remapColors(m.from, m.to); remapTags(m.from, m.to); if (wasF[m.from]) keep(m.to); });
        treeStruct = true; clearSel();
        pushUndo("이름 " + res.renamed.length + "개 일괄 변경", function () {
          return FS.renameMany({ items: res.renamed.map(function (m) { return { path: m.to, name: nameOf(m.from) }; }) }).then(function (r2) {
            r2.renamed.forEach(function (m) { remap(m.from, m.to); remapColors(m.from, m.to); remapTags(m.from, m.to); });
            return Promise.all([reload(), refreshB()]);
          }).then(function () { toast("이름을 되돌렸어요"); });
        });
        return Promise.all([reload(), refreshB()]).then(function () { toast(res.renamed.length + "개의 이름을 바꿨어요"); });
      });
    }).catch(err);
  }
  function doRename() { var ps = selPaths(); if (ps.length > 1) openBatchRename(); else if (ps[0]) renameItem(ps[0]); }
  function newFolder(parent) {
    if (parent == null) { toast("폴더 안으로 들어가서 만들어 주세요"); return Promise.resolve(); }
    return askText("새 폴더 이름", "", "만들기").then(function (n) {
      if (!n) return;
      return FS.mkdir({ parent: parent, name: n }).then(function (m) { keep(m.path); treeStruct = true; return Promise.all([reload(), refreshB()]); }).then(function () { toast("폴더를 만들었어요"); });
    }).catch(err);
  }
  $("#actions").addEventListener("click", function (e) {
    var b = e.target.closest("[data-a]"); if (!b) return;
    ({ move: doMove, trash: doTrash, rename: doRename, color: doColor, tag: doTag })[b.dataset.a]();
  });

  /* ---------- 휴지통 ---------- */
  function openTrash() {
    FS.listTrash().then(function (r) {
      clearSel(); S.trashView = true; S.trash = r.items.sort(function (a, b) { return b.at - a.at; });
      document.body.classList.add("trashv"); draw();
      toast("휴지통 · " + r.keepDays + "일 뒤 자동 삭제");
    }).catch(err);
  }
  $("#tactions").addEventListener("click", function (e) {
    var b = e.target.closest("[data-a]"); if (!b) return;
    var idl = selPaths();
    if (b.dataset.a === "restore") FS.restore({ ids: idl }).then(function (r) { toast(r.restored.length + "개를 제자리로 돌렸어요"); clearSel(); openTrash(); }).catch(err);
    else confirmBox("영구 삭제", idl.length + "개를 완전히 지워요. 되돌릴 수 없어요.", "지우기", true).then(function (ok) { if (ok) return FS.purge({ ids: idl }).then(function () { clearSel(); openTrash(); }); }).catch(err);
  });

  /* ---------- 크게 보기 (더블탭·핀치 확대, 옆으로 넘기기) ---------- */
  var vList = [], vTok = 0, Z = { s: 1, x: 0, y: 0, hi: false };
  function zApply(anim) {
    var im = $("#vImg"); im.classList.toggle("anim", !!anim);
    im.style.transform = "translate3d(" + Z.x + "px," + Z.y + "px,0) scale(" + Z.s + ")";
  }
  function zReset() { Z.s = 1; Z.x = 0; Z.y = 0; Z.hi = false; zApply(false); }
  function zClamp() {
    var im = $("#vImg"), mx = Math.max(0, (im.clientWidth * Z.s - window.innerWidth) / 2), my = Math.max(0, (im.clientHeight * Z.s - window.innerHeight) / 2);
    Z.x = Math.max(-mx, Math.min(mx, Z.x)); Z.y = Math.max(-my, Math.min(my, Z.y));
    if (Z.s <= 1.001) { Z.x = 0; Z.y = 0; }
  }
  function zHi() {
    if (Z.hi || Z.s <= 1.2) return; Z.hi = true;
    var f = vList[S.viewer], tok = vTok; if (!f) return;
    FS.thumb({ path: f.path, size: 3000 }).then(function (r) { if (tok === vTok && r && r.data) $("#vImg").src = r.data; }).catch(function () {});
  }
  function zToggle(cx, cy) {
    if (Z.s > 1.05) { Z.s = 1; Z.x = 0; Z.y = 0; }
    else { var px = cx - window.innerWidth / 2, py = cy - window.innerHeight / 2; Z.s = 2.6; Z.x = -(Z.s - 1) * px; Z.y = -(Z.s - 1) * py; zClamp(); zHi(); }
    zApply(true);
  }
  function openViewer(p) {
    vList = S.files.filter(function (f) { return !f.video; }); var i = vList.findIndex(function (f) { return f.path === p; });
    if (i < 0) { FS.openExternal({ path: p }).catch(err); return; }
    S.viewer = i; $("#viewer").hidden = false; showV();
  }
  function showV() {
    var f = vList[S.viewer]; if (!f) return;
    zReset();
    $("#vName").textContent = f.name; $("#vPos").textContent = (S.viewer + 1) + " / " + vList.length;
    var tok = ++vTok, im = $("#vImg"); im.style.opacity = 0.4;
    FS.thumb({ path: f.path, size: 1600 }).then(function (r) { if (tok === vTok) { im.src = r.data; im.style.opacity = 1; } }).catch(err);
  }
  function stepV(d) { var n = S.viewer + d; if (n < 0 || n >= vList.length) return; S.viewer = n; showV(); }
  function closeV() { $("#viewer").hidden = true; S.viewer = null; $("#vImg").removeAttribute("src"); zReset(); }
  $("#vOpen").onclick = function () { var f = vList[S.viewer]; if (f) FS.openExternal({ path: f.path }).catch(err); };
  $("#vClose").onclick = closeV; $("#vPrev").onclick = function () { stepV(-1); }; $("#vNext").onclick = function () { stepV(1); };
  (function () {
    var st = null, lastTap = 0, lastX = 0, lastY = 0, v = $("#viewer");
    function dist(t) { return Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY); }
    v.addEventListener("touchstart", function (e) {
      if (e.target.closest(".vtop, .vnav")) return;
      if (e.touches.length === 2) { st = { mode: "pinch", d: dist(e.touches), s: Z.s }; return; }
      if (e.touches.length === 1) st = { mode: "one", x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now(), px: Z.x, py: Z.y, moved: false };
    }, { passive: true });
    v.addEventListener("touchmove", function (e) {
      if (!st) return;
      if (st.mode === "pinch" && e.touches.length === 2) {
        Z.s = Math.max(1, Math.min(6, st.s * dist(e.touches) / st.d)); zClamp(); zApply(false); return;
      }
      if (st.mode === "one" && e.touches.length === 1) {
        var dx = e.touches[0].clientX - st.x, dy = e.touches[0].clientY - st.y;
        if (Math.hypot(dx, dy) > 8) st.moved = true;
        if (Z.s > 1.05) { Z.x = st.px + dx; Z.y = st.py + dy; zClamp(); zApply(false); }
      }
    }, { passive: true });
    v.addEventListener("touchend", function (e) {
      if (!st) return;
      var s0 = st; if (e.touches.length) { if (s0.mode === "pinch") st = null; return; }
      st = null;
      if (s0.mode === "pinch") { zHi(); if (Z.s < 1.05) zReset(); return; }
      var t = e.changedTouches[0], dx = t.clientX - s0.x, dy = t.clientY - s0.y, now = Date.now();
      if (!s0.moved && now - s0.t < 350) {
        if (now - lastTap < 320 && Math.hypot(t.clientX - lastX, t.clientY - lastY) < 40) { lastTap = 0; zToggle(t.clientX, t.clientY); }
        else { lastTap = now; lastX = t.clientX; lastY = t.clientY; }
        return;
      }
      if (Z.s <= 1.05 && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) stepV(dx < 0 ? 1 : -1);
      else if (Z.s > 1.05) zHi();
    });
    v.addEventListener("dblclick", function (e) { if (!e.target.closest(".vtop, .vnav")) zToggle(e.clientX, e.clientY); });
  })();

  /* ---------- 분할 화면: 위 = 정리할 사진, 아래 = 갈 곳(폴더) ---------- */
  var B = { list: [], q: "", mode: store.get("bmode", "name"), recent: store.get("recent", []), flat: null };
  S.split = store.get("split", false); S.ratio = store.get("ratio", 0.5); S.cwd2 = store.get("cwd2", null);
  var CHO = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
  function cho(str) { return Array.from(str).map(function (c) { var k = c.charCodeAt(0) - 0xAC00; return k >= 0 && k < 11172 ? CHO[Math.floor(k / 588)] : c.toLowerCase(); }).join(""); }
  function byName(a, b) { return a.name.localeCompare(b.name, "ko", { numeric: true }); }
  var ioB = null;
  function paintModes() {
    $("#btnGrid").classList.toggle("on", !S.split && !cardOn());
    $("#btnSplit").classList.toggle("on", S.split);
    $("#btnCard").classList.toggle("on", cardOn());
  }
  $("#btnGrid").onclick = function () {
    S.split = false; S.card = false; store.set("split", false); store.set("card", false); clearSel(); applySplit(); paintSel();
  };
  function applySplit() {
    document.body.classList.toggle("split", S.split);
    $("#scroll").style.flexGrow = S.split ? S.ratio : 1;
    $("#card").style.flexGrow = S.split ? S.ratio : 1;
    $("#paneB").style.flexGrow = 1 - S.ratio;
    document.body.classList.toggle("card", cardOn()); paintModes();
    if (S.split) {
      var start = S.cwd2 != null ? S.cwd2 : (S.cwd != null && rootOf(S.cwd) && rootOf(S.cwd).path !== S.cwd ? parentOf(S.cwd) : null);
      if (S.unsorted) { var al = albumPath(); if (al && !(start && (start === al || start.indexOf(al + "/") === 0))) start = al; }
      goB(start);
    }
  }
  function goB(path, keep) {
    if (!keep) { B.q = ""; $("#bQ").value = ""; $(".bh").classList.remove("search"); }
    if (path == null) { S.cwd2 = null; store.set("cwd2", null); B.list = S.roots.map(function (r) { return { name: r.name, path: r.path, root: true, media: 0, sub: 0 }; }); drawB(); return Promise.resolve(); }
    return FS.list({ path: path, foldersOnly: true }).then(function (r) {
      S.cwd2 = path; store.set("cwd2", path); B.list = r.folders.sort(byName); drawB();
      if (!keep) $("#bscroll").scrollTop = 0;
    }).catch(function (e) { err(e); if (S.cwd2 !== path) goB(null); });
  }
  function refreshB() { return S.split ? goB(S.cwd2, true) : Promise.resolve(); }
  function ensureFlat() {
    if (B.flat) return Promise.resolve(B.flat);
    return loadTrees(false).then(function (trees) {
      var out = [];
      function w(n, rel) { out.push({ name: n.name, path: n.path, parent: rel, media: -1, sub: 0 }); (n.kids || []).forEach(function (k) { w(k, rel ? rel + " › " + n.name : n.name); }); }
      trees.forEach(function (t) { w(t, ""); });
      B.flat = out.filter(function (x) { return x.parent !== ""; }); return B.flat;
    });
  }
  function searchList(q) {
    var l = q.toLowerCase(), jamo = /^[ㄱ-ㅎ]+$/.test(q);
    var hit = (B.flat || []).filter(function (x) { return jamo ? cho(x.name).indexOf(q) >= 0 : x.name.toLowerCase().indexOf(l) >= 0 || cho(x.name).indexOf(l) === 0 && /^[ㄱ-ㅎ]/.test(l); });
    hit.sort(function (a, b) { var as = a.name.toLowerCase().indexOf(l) === 0 ? 0 : 1, bs = b.name.toLowerCase().indexOf(l) === 0 ? 0 : 1; return as - bs || byName(a, b); });
    return hit.slice(0, 80);
  }
  function btHtml(x) {
    var meta = x.parent != null ? x.parent : (x.root ? "" : (x.media > 0 ? x.media + "장" : "") + (x.media > 0 && x.sub ? " · " : "") + (x.sub ? "폴더 " + x.sub : "") || "비어 있음");
    return '<div class="it folder bt' + (x.cover ? " hascover" : "") + (colorOf(x.path) ? " col" : "") + '"' + colAttr(x.path) + ' data-p="' + esc(x.path) + '" data-f="1"><div class="th">' + (x.cover ? '<img data-p="' + esc(x.cover) + '" data-state="" alt="">' : "") + FOLDER_SVG +
      '</div><div class="lb">' + esc(x.name) + (meta ? "<small>" + esc(meta) + "</small>" : "") + "</div></div>";
  }
  function bHint() {
    var h = $("#bHint");
    if (cardOn()) { h.textContent = "위 사진을 꾹 눌러 폴더 위로 끌어다 놓으면 옮겨져요"; h.classList.add("show"); }
    else if (S.sel.size) { h.textContent = "고른 " + S.sel.size + "장을 폴더 위로 끌어다 놓으면 옮겨져요"; h.classList.add("show"); }
    else if (B.label) { h.textContent = B.label; h.classList.add("show"); }
    else h.classList.remove("show");
  }
  function drawB() {
    if (!S.split) return;
    var html = '<button data-go="">홈</button>';
    if (S.cwd2 != null) {
      var r = rootOf(S.cwd2);
      if (r) {
        html += '<i>›</i><button data-go="' + esc(r.path) + '">' + esc(r.name) + "</button>";
        var rest = S.cwd2.slice(r.path.length + 1), acc = r.path;
        if (rest) rest.split("/").forEach(function (seg) { acc += "/" + seg; html += '<i>›</i><button data-go="' + esc(acc) + '">' + esc(seg) + "</button>"; });
      }
    }
    $("#bUp").classList.toggle("dim", S.cwd2 == null);
    var cb = $("#crumbB"); cb.innerHTML = html; cb.scrollLeft = cb.scrollWidth;
    var q = B.q.trim(), items, label = "";
    if (q) { items = searchList(q); label = "검색 결과"; }
    else if (B.mode === "recent") { items = B.recent.map(function (p) { return { name: nameOf(p), path: p, parent: relPath(parentOf(p)) }; }); label = "최근에 옮긴 폴더"; }
    else items = B.list;
    $("#bSort").textContent = B.mode === "recent" ? "최근" : "이름순";
    $("#bgrid").innerHTML = items.map(btHtml).join("");
    $("#bempty").textContent = items.length ? "" : (q ? "맞는 폴더가 없어요" : B.mode === "recent" ? "아직 옮긴 폴더가 없어요" : "하위 폴더가 없어요");
    B.label = label; bHint();
    if (ioB) ioB.disconnect();
    ioB = new IntersectionObserver(ioCallback, { root: $("#bscroll"), rootMargin: "500px 0px" });
    $("#bgrid").querySelectorAll(".it").forEach(function (n) { ioB.observe(n); });
  }
  $("#btnSplit").onclick = function () { S.split = !S.split; store.set("split", S.split); applySplit(); };
  $("#crumbB").addEventListener("click", function (e) { var b = e.target.closest("[data-go]"); if (b) goB(b.dataset.go || null); });
  $("#bgrid").addEventListener("click", function (e) {
    var it = e.target.closest(".it"); if (!it) return; var p = it.dataset.p;
    if (bSup) { bSup = false; return; }
    if (bSup) { bSup = false; return; }
    B.mode = "name"; store.set("bmode", "name"); goB(p);
  });
  $("#bSort").onclick = function () { B.mode = B.mode === "recent" ? "name" : "recent"; store.set("bmode", B.mode); B.q = ""; $("#bQ").value = ""; $(".bh").classList.remove("search"); drawB(); };
  function closeSearch() { B.q = ""; $("#bQ").value = ""; $(".bh").classList.remove("search"); drawB(); }
  $("#bUp").onclick = function () {
    if (S.cwd2 == null) { toast("이미 맨 위예요"); return; }
    var r = rootOf(S.cwd2); goB(r && r.path === S.cwd2 ? null : parentOf(S.cwd2));
  };
  $("#bAdd").onclick = function () { newFolder(S.cwd2); };
  var bSup = false;
  function addMenu(x, y, parent) {
    popAt(x, y, '<button class="mi" data-m="mk">＋ 여기에 새 폴더 만들기</button>', function (el) { el.querySelector("[data-m]").onclick = function () { closePop(); newFolder(parent); }; });
  }
  longPress($("#scroll"), 520, function (e) { return e.target.closest(".it") || S.trashView ? null : true; }, function (x, y) { if (S.cwd == null || S.tagView || S.unsorted) { toast("폴더 안으로 들어가서 만들어 주세요"); return; } if (navigator.vibrate) try { navigator.vibrate(10); } catch (e) {} addMenu(x, y, S.cwd); });
  longPress($("#bscroll"), 520, function (e) { var it = e.target.closest(".it"); return it ? it : true; }, function (x, y, c) {
    if (navigator.vibrate) try { navigator.vibrate(10); } catch (e) {}
    if (c === true) { if (S.cwd2 == null) { toast("폴더 안으로 들어가서 만들어 주세요"); return; } addMenu(x, y, S.cwd2); return; }
    var p = c.dataset.p, isRoot = S.roots.some(function (r) { return r.path === p; }); bSup = true; setTimeout(function () { bSup = false; }, 700);
    popAt(x, y, '<button class="mi" data-m="open">폴더 열기</button><div class="msep"></div>' + (isRoot ? "" : '<button class="mi" data-m="rn">이름 바꾸기</button>') + '<button class="mi" data-m="col">폴더 색</button><button class="mi" data-m="mk">＋ 이 안에 새 폴더</button>' + (isRoot ? "" : '<div class="msep"></div><button class="mi" data-m="del" style="color:var(--danger)">휴지통으로</button>'), function (el) {
      el.querySelectorAll("[data-m]").forEach(function (b) {
        b.onclick = function () {
          var m = b.dataset.m; closePop();
          if (m === "open") { B.mode = "name"; store.set("bmode", "name"); goB(p); }
          else if (m === "rn") renameItem(p);
          else if (m === "col") pickColor([p]);
          else if (m === "mk") newFolder(p);
          else confirmBox("‘" + nameOf(p) + "’ 폴더를 지울까요?", "안의 사진까지 모두 휴지통으로 가요. 30일 안에는 복원할 수 있어요.", "휴지통으로", true).then(function (ok) {
            if (!ok) return;
            treeStruct = true;
            return FS.trash({ paths: [p] }).then(function (r) {
              return Promise.all([reload(), refreshB()]).then(function () {
                var u = r.ids.length ? pushUndo("폴더 ‘" + nameOf(p) + "’ 삭제", function () { return restoreIds(r.ids); }) : null;
                toast("폴더를 휴지통으로 보냈어요", "되돌리기", u ? function () { runUndo(u); } : null);
              });
            });
          }).catch(err);
        };
      });
    });
  });
  $("#bFind").onclick = function () {
    var bh = $(".bh");
    if (bh.classList.contains("search")) { closeSearch(); return; }
    bh.classList.add("search"); ensureFlat().then(function () { drawB(); }).catch(err); setTimeout(function () { $("#bQ").focus(); }, 30);
  };
  $("#bQ").addEventListener("input", function () { B.q = this.value; ensureFlat().then(drawB).catch(err); });
  $("#bQ").addEventListener("keydown", function (e) { if (e.key === "Enter") this.blur(); });
  (function () {
    var on = false, g = $("#grip");
    g.addEventListener("pointerdown", function (e) { on = true; g.setPointerCapture(e.pointerId); e.preventDefault(); });
    g.addEventListener("pointermove", function (e) {
      if (!on) return; var r = $("#panes").getBoundingClientRect();
      var v = (e.clientY - r.top - 23) / Math.max(1, r.height - 46); S.ratio = Math.max(0.2, Math.min(0.8, v));
      $("#scroll").style.flexGrow = S.ratio; $("#card").style.flexGrow = S.ratio; $("#paneB").style.flexGrow = 1 - S.ratio;
    });
    ["pointerup", "pointercancel"].forEach(function (ev) { g.addEventListener(ev, function () { if (on) { on = false; store.set("ratio", S.ratio); } }); });
  })();
  var _paint = paintSel;
  paintSel = function () { _paint(); if (S.split) bHint(); };

  /* ---------- 정리 모드 아래 폴더 칩: 내가 정하고 고치고 지우는 목록 ---------- */
  var PINS = store.get("pins", []), PIN_RECENT = store.get("pinRecent", true);
  function savePins() { store.set("pins", PINS); store.set("pinRecent", PIN_RECENT); }
  function remapPins(oldP, newP) {
    var ch = false;
    PINS.forEach(function (x) { if (x.path === oldP || x.path.indexOf(oldP + "/") === 0) { x.path = newP + x.path.slice(oldP.length); ch = true; } });
    if (ch) savePins();
  }
  function chipList() {
    var out = PINS.map(function (x) { return { path: x.path, label: x.label || nameOf(x.path), pin: true }; });
    if (PIN_RECENT || !PINS.length) {
      var seen = {}; out.forEach(function (c) { seen[c.path] = 1; });
      B.recent.filter(function (p) { return p !== S.cwd && !seen[p]; }).slice(0, PINS.length ? 6 : 10).forEach(function (p) { out.push({ path: p, label: nameOf(p), pin: false }); });
    }
    return out.filter(function (c) { return c.path !== S.cwd; });
  }
  function openPinSheet() {
    function html() {
      var rows = PINS.length ? PINS.map(function (x, i) {
        return '<div class="pnrow" data-i="' + i + '"><div class="pnbtns"><button data-a="up"' + (i === 0 ? " disabled" : "") + '>▲</button><button data-a="dn"' + (i === PINS.length - 1 ? " disabled" : "") + '>▼</button></div>' +
          '<div class="pnx"><input type="text" class="pnlbl" value="' + esc(x.label || nameOf(x.path)) + '" aria-label="칩 이름"><div class="pnp">' + esc(relPath(x.path)) + '</div></div><button class="pndel" data-a="del" aria-label="지우기">✕</button></div>';
      }).join("") : '<div class="rempty" style="padding:18px 8px">아직 고정한 폴더가 없어요.<br>아래 ‘폴더 추가’로 자주 쓰는 폴더를 넣어 두세요.</div>';
      return '<h3>정리 모드 폴더 칩</h3><div class="body">' + rows +
        '<button class="mi" data-a="add" style="margin-top:6px">＋ 폴더 추가</button>' +
        '<div class="pnsw"><span>최근에 옮긴 폴더도 뒤에 보이기</span><button data-a="rec" class="' + (PIN_RECENT ? "on" : "") + '">' + (PIN_RECENT ? "켜짐" : "꺼짐") + '</button></div></div><div class="btns"><button class="pri" data-done="1">완료</button></div>';
    }
    return sheet(html(), function (el, close) {
      function bind() {
        el.querySelectorAll(".pnlbl").forEach(function (inp) { inp.onchange = function () { var i = +inp.closest(".pnrow").dataset.i; PINS[i].label = inp.value.trim() === nameOf(PINS[i].path) ? "" : inp.value.trim(); savePins(); }; });
        el.querySelectorAll("[data-a]").forEach(function (b) {
          b.onclick = function () {
            var a = b.dataset.a, row = b.closest(".pnrow"), i = row ? +row.dataset.i : -1;
            if (a === "up" && i > 0) { var t = PINS[i]; PINS[i] = PINS[i - 1]; PINS[i - 1] = t; }
            else if (a === "dn" && i < PINS.length - 1) { var t2 = PINS[i]; PINS[i] = PINS[i + 1]; PINS[i + 1] = t2; }
            else if (a === "del") PINS.splice(i, 1);
            else if (a === "rec") PIN_RECENT = !PIN_RECENT;
            else if (a === "add") { close("add"); return; }
            savePins(); el.innerHTML = html(); bind();
          };
        });
        el.querySelector("[data-done]").onclick = function () { close(); };
      }
      bind();
    }).then(function (r) {
      if (r === "add") {
        return pickLoop("칩으로 고정할 폴더를 골라 주세요", function () { return false; }).then(function (d) {
          if (d && !PINS.some(function (x) { return x.path === d; })) { PINS.push({ path: d, label: "" }); savePins(); }
          return openPinSheet();
        });
      }
      drawCard();
    });
  }

  /* ---------- 카드 모드: 사진 한 장씩, 위로 쓸면 삭제, 아래 폴더를 누르면 이동 ---------- */
  function cardOn() { return !!(S.card && !S.trashView && (S.cwd != null || S.tagView || S.unsorted)); }
  function cardList() { return S.files.filter(function (f) { return !f.video; }); }
  var cardTok = 0, cardCache = {};
  function cardData(path) {
    if (cardCache[path]) return Promise.resolve(cardCache[path]);
    return FS.thumb({ path: path, size: 1400 }).then(function (r) {
      var k = Object.keys(cardCache); if (k.length > 5) delete cardCache[k[0]];
      cardCache[path] = r.data; return r.data;
    });
  }
  function drawCard() {
    document.body.classList.toggle("card", cardOn());
    if (!cardOn()) return;
    var l = cardList(), im = $("#cImg"), emp = $("#cEmpty");
    if (S.ci >= l.length) S.ci = Math.max(0, l.length - 1);
    var f = l[S.ci];
    $("#cName").textContent = f ? f.name : "";
    $("#cPos").textContent = f ? (S.ci + 1) + " / " + l.length : "";
    emp.textContent = f ? "" : "이 폴더에는 사진이 없어요";
    im.style.visibility = f ? "visible" : "hidden";
    var tl = f ? tagsOf(f.path) : [];
    $("#cTags").innerHTML = f ? tl.map(function (t) { return '<span class="tagchip" style="--th:' + tagHue(t) + '">#' + esc(t) + "</span>"; }).join("") + '<button data-ct="1">＋ 태그</button>' : "";
    $("#cHint").textContent = S.split ? "위로 쓸면 삭제 · 아래로 쓸면 되돌리기 · 옆으로 넘기면 건너뛰기 · 꾹 눌러 아래 폴더로 끌어 옮기기" : "위로 쓸면 삭제 · 아래로 쓸면 되돌리기 · 옆으로 넘기면 건너뛰기";
    var rc = B.recent.filter(function (p) { return p !== S.cwd; }).slice(0, 10);
    $("#cRecent").innerHTML = chipList().map(function (c) { var col = colorOf(c.path); return '<button data-p="' + esc(c.path) + '"' + (c.pin ? ' class="pin"' : "") + ">" + (col ? '<i class="dot" style="background:' + col + '"></i>' : "") + esc(c.label) + "</button>"; }).join("") + '<button class="chipedit" data-ed="1">' + (PINS.length ? "✎ 편집" : "＋ 폴더 고정") + "</button>";
    ["#cPrev", "#cDel", "#cMove", "#cOpen", "#cNext"].forEach(function (id) { $(id).disabled = !f; });
    if (!f) { im.removeAttribute("src"); return; }
    var tok = ++cardTok;
    im.classList.remove("anim"); im.style.transform = ""; im.style.opacity = 1;
    cardData(f.path).then(function (d) { if (tok === cardTok) im.src = d; }).catch(err);
    var nx = l[S.ci + 1]; if (nx) cardData(nx.path).catch(function () {});
  }
  function cardStep(d) { var n = S.ci + d; if (n < 0 || n >= cardList().length) { toast(d > 0 ? "마지막 사진이에요" : "첫 사진이에요"); return; } S.ci = n; drawCard(); }
  function cardMove(dest) { var f = cardList()[S.ci]; if (f) moveInto([f.path], dest); }
  function cardDelete() {
    var f = cardList()[S.ci]; if (!f) return;
    FS.trash({ paths: [f.path] }).then(function (r) {
      return reload().then(function () {
        var u = r.ids.length ? pushUndo("‘" + f.name + "’ 삭제", function () { return restoreIds(r.ids); }) : null;
        toast("‘" + f.name + "’을(를) 휴지통으로 보냈어요", "되돌리기", u ? function () { runUndo(u); } : null);
      });
    }).catch(err);
  }
  $("#cPrev").onclick = function () { cardStep(-1); }; $("#cNext").onclick = function () { cardStep(1); };
  $("#cDel").onclick = cardDelete;
  $("#cTags").addEventListener("click", function (e) { if (!e.target.closest("[data-ct]")) return; var f = cardList()[S.ci]; if (f) openTagSheet([f.path]).then(drawCard); });
  $("#cMove").onclick = function () {
    var f = cardList()[S.ci]; if (!f) return;
    pickLoop("‘" + f.name + "’을(를) 어디로 옮길까요?", function (p) { return p === S.cwd; }).then(function (dest) { if (dest) return cardMove(dest); }).catch(err);
  };
  $("#cRecent").addEventListener("click", function (e) {
    var b = e.target.closest("button"); if (!b) return;
    if (b.dataset.ed) { openPinSheet(); return; }
    cardMove(b.dataset.p);
  });
  $("#cOpen").onclick = function () { var f = cardList()[S.ci]; if (f) FS.openExternal({ path: f.path }).catch(err); };
  $("#btnCard").onclick = function () {
    if (S.cwd == null && !S.tagView && !S.unsorted) { toast("폴더 안으로 들어가서 써 주세요"); return; }
    S.card = !S.card; if (S.card) { S.ci = 0; } store.set("card", S.card); clearSel(); paintSel(); document.body.classList.toggle("card", cardOn()); paintModes(); if (cardOn()) drawCard(); drawB();
  };
  (function () {
    var st = null, im = $("#cImg"), stage = $("#cStage");
    var lp = null;
    stage.addEventListener("pointerdown", function (e) {
      if (!cardOn() || !cardList()[S.ci]) return;
      st = { x: e.clientX, y: e.clientY, dx: 0, dy: 0 }; stage.setPointerCapture(e.pointerId); im.classList.remove("anim");
      clearTimeout(lp);
      lp = setTimeout(function () {
        if (!st || Math.hypot(st.dx, st.dy) > 9 || !S.split) return;
        drag = { x: st.x, y: st.y, on: false, target: null, card: true }; suppress = true;
        st = null; im.style.transform = ""; im.style.opacity = 1;
        if (navigator.vibrate) try { navigator.vibrate(12); } catch (x) {}
      }, 400);
    });
    stage.addEventListener("pointermove", function (e) {
      if (!st) return; st.dx = e.clientX - st.x; st.dy = e.clientY - st.y;
      if (Math.hypot(st.dx, st.dy) > 9) clearTimeout(lp);
      var vert = Math.abs(st.dy) > Math.abs(st.dx), up = vert && st.dy < 0, down = vert && st.dy > 0;
      im.style.transform = up ? "translate(" + (st.dx * 0.3) + "px," + st.dy + "px) scale(" + Math.max(0.7, 1 + st.dy / 600) + ")" : down ? "translate(" + (st.dx * 0.3) + "px," + (st.dy * 0.5) + "px) scale(" + Math.max(0.9, 1 - st.dy / 1500) + ")" : "translate(" + st.dx + "px,0) rotate(" + (st.dx / 40) + "deg)";
      im.style.opacity = up ? Math.max(0.25, 1 + st.dy / 260) : down ? Math.max(0.5, 1 - st.dy / 500) : Math.max(0.4, 1 - Math.abs(st.dx) / 500);
    });
    function end() {
      if (!st) return; var d = st; st = null; im.classList.add("anim");
      if (d.dy < -90 && Math.abs(d.dy) > Math.abs(d.dx)) { im.style.transform = "translate(0,-" + window.innerHeight + "px) scale(.6)"; im.style.opacity = 0; setTimeout(cardDelete, 180); }
      else if (d.dy > 90 && Math.abs(d.dy) > Math.abs(d.dx)) {
        var u = UNDO[UNDO.length - 1];
        im.style.transform = ""; im.style.opacity = 1;
        if (!u) toast("되돌릴 작업이 없어요");
        else runUndo(u).then(function () { toast("되돌렸어요 · " + u.label); });
      }
      else if (d.dx < -70 && Math.abs(d.dx) > Math.abs(d.dy)) { im.style.transform = "translate(-120%,0)"; im.style.opacity = 0; setTimeout(function () { var n = S.ci + 1; if (n < cardList().length) { S.ci = n; drawCard(); } else { toast("마지막 사진이에요"); drawCard(); } }, 150); }
      else if (d.dx > 70 && Math.abs(d.dx) > Math.abs(d.dy)) { im.style.transform = "translate(120%,0)"; im.style.opacity = 0; setTimeout(function () { var n = S.ci - 1; if (n >= 0) { S.ci = n; drawCard(); } else { toast("첫 사진이에요"); drawCard(); } }, 150); }
      else { im.style.transform = ""; im.style.opacity = 1; }
    }
    stage.addEventListener("pointerup", end); stage.addEventListener("pointercancel", end);
  })();

  /* ---------- 권한 / 시작 ---------- */
  function checkAccess(manual) {
    var timer = setTimeout(function () {
      diag("파일 플러그인이 응답하지 않아요.\n플러그인 등록: " + (window.Capacitor && Capacitor.isPluginAvailable ? Capacitor.isPluginAvailable("PhotoFs") : "?") + "\n네이티브 앱: " + native);
    }, 4000);
    return FS.hasAccess().then(function (r) {
      clearTimeout(timer);
      $("#perm").hidden = !!r.granted;
      if (manual) toast(r.granted ? "권한이 켜져 있어요" : "권한이 꺼져 있어요");
      return r.granted;
    }, function (e) { clearTimeout(timer); diag("권한 확인 실패: " + ((e && e.message) || e)); $("#perm").hidden = false; return false; });
  }
  $("#permBtn").onclick = function () { FS.requestAccess().catch(err); };
  document.addEventListener("visibilitychange", function () { if (!document.hidden && !$("#perm").hidden) checkAccess().then(function (g) { if (g) start(); }); });

  function back() {
    if (!$("#pop").hidden) { closePop(); return true; }
    if (!$("#sheetWrap").hidden) { sheetClose && sheetClose(); return true; }
    if (!$("#viewer").hidden) { closeV(); return true; }
    if ($("#tagPanel").classList.contains("show")) { closeTagPanel(); return true; }
    if ($("#drawer").classList.contains("show")) { closeDrawer(); return true; }
    if ($(".bh").classList.contains("search")) { closeSearch(); return true; }
    if (cardOn()) { S.card = false; store.set("card", false); document.body.classList.remove("card"); paintModes(); return true; }
    if (S.selOn || S.sel.size) { clearSel(); paintSel(); return true; }
    if (S.tagView || S.unsorted) { go(S.cwd); return true; }
    if (S.trashView) { go(S.cwd); return true; }
    if (S.cwd != null) { var r = rootOf(S.cwd); go(r && r.path === S.cwd ? null : parentOf(S.cwd)); return true; }
    return false;
  }
  if (AppPlug && AppPlug.addListener) { try { AppPlug.addListener("backButton", function () { if (!back()) AppPlug.exitApp(); }); } catch (e) {} }
  window.addEventListener("keydown", function (e) { if (e.key === "Escape") back(); });

  var started = false;
  function start() {
    if (started) return; started = true;
    FS.roots().then(function (r) {
      S.home = r.home; S.roots = r.roots;
      var last = store.get("cwd", null);
      setTimeout(function () { loadTrees(false, true).catch(function () {}); }, 900);
      setTimeout(countUns, 1800);
      return go(last && rootOf(last) ? last : null).then(applySplit);
    }).catch(function (e) { diag("시작 실패: " + ((e && e.message) || e)); });
  }
  checkAccess().then(function (g) { if (g) start(); });
  window.__jp = { S: S, go: go, reload: reload, FS: FS };
})();
