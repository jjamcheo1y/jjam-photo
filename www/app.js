/* 대짬철갤러리 — 폰 사진 폴더 정리 (폴더 위계는 폰 저장소 그대로) */
(function () {
  "use strict";
  var $ = function (s, e) { return (e || document).querySelector(s); };
  var esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var native = !!(window.Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform());
  var FS;
  try { FS = native ? Capacitor.registerPlugin("PhotoFs") : MockFS(); } catch (e) { window.__diag && window.__diag("플러그인 준비 실패: " + e.message); throw e; }
  var AppPlug = null;
  try { if (native) AppPlug = Capacitor.registerPlugin("App"); } catch (e) { AppPlug = null; }
  var store = {
    get: function (k, d) { try { var v = localStorage.getItem("jp-" + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem("jp-" + k, JSON.stringify(v)); } catch (e) {} }
  };

  function diag(msg) { if (window.__diag) window.__diag(msg); }

  var S = {
    home: "", roots: [], cwd: null, folders: [], files: [],
    sort: store.get("sort", { k: "date", d: -1 }), cols: store.get("cols", 3), names: store.get("names", true),
    sel: new Set(), selOn: false, range: false, anchor: null, last: null,
    trashView: false, trash: [], viewer: null, hideEmpty: store.get("hideEmpty", true), fresh: new Set(), card: store.get("card", false), ci: 0
  };

  /* ---------- 알림 / 창 ---------- */
  var tt;
  function toast(msg, label, fn) {
    var t = $("#toast"); t.innerHTML = esc(msg) + (fn ? '<button type="button">' + esc(label || "되돌리기") + "</button>" : "");
    t.classList.add("show"); clearTimeout(tt);
    if (fn) $("button", t).onclick = function () { t.classList.remove("show"); fn(); };
    tt = setTimeout(function () { t.classList.remove("show"); }, fn ? 7000 : 2400);
  }
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
  function vis(f) { return !S.hideEmpty || f.has !== false || S.fresh.has(f.path); }
  function prune2(n) { n.kids = (n.kids || []).filter(vis).map(prune2); return n; }
  function order() { return S.folders.concat(S.files); }

  function go(path, keepSel) {
    S.trashView = false; document.body.classList.remove("trashv");
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
  function reload() { treeCache = null; B.flat = null; return S.cwd == null ? go(null, true) : FS.list({ path: S.cwd }).then(function (r) { S.folders = r.folders.filter(vis); S.files = r.files; sortList(); prune(); draw(); }); }
  function prune() { var ok = new Set(order().map(function (x) { return x.path; })); S.sel.forEach(function (p) { if (!ok.has(p)) S.sel.delete(p); }); if (!S.sel.size) S.selOn = false, S.range = false; }

  /* ---------- 그리기 ---------- */
  var FOLDER_SVG = '<svg viewBox="0 0 24 24"><path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H9l2 2.2h7.5A2.5 2.5 0 0 1 21 8.7v8.8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/></svg>';
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
      return '<div class="it folder' + on + anc + '" data-p="' + esc(x.path) + '" data-f="1"><div class="th"><span class="ck"></span>' + FOLDER_SVG + '</div><div class="lb">' + esc(x.name) + (meta ? "<small>" + esc(meta) + "</small>" : "") + "</div></div>";
    }
    return '<div class="it' + on + anc + '" data-p="' + esc(x.path) + '"><div class="th"><img data-p="' + esc(x.path) + '" data-state="" alt=""><span class="ck"></span>' + (x.video ? '<span class="vid">영상</span>' : "") + '</div><div class="lb">' + esc(x.name) + "</div></div>";
  }
  function draw() {
    document.body.classList.toggle("selecting", S.selOn);
    document.body.classList.toggle("hasSel", S.sel.size > 0);
    document.body.classList.toggle("names", S.names);
    document.documentElement.style.setProperty("--cols", S.cols);
    // 위쪽 길 표시
    var c = $("#crumb"), html = '<button data-go="">홈</button>';
    if (S.trashView) html += "<i>›</i><button>휴지통</button>";
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
    var one = S.sel.size === 1 && !S.trashView;
    $('#actions [data-a=rename]').style.display = one ? "" : "none";
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
    em.hidden = n > 0; em.textContent = S.trashView ? "휴지통이 비었어요 (30일 지나면 자동으로 지워져요)" : "이 폴더에는 사진이 없어요";
  }
  function paintSel() {
    document.body.classList.toggle("selecting", S.selOn);
    document.body.classList.toggle("hasSel", S.sel.size > 0);
    $("#selN").textContent = S.sel.size + "개 선택";
    $("#btnRange").classList.toggle("on", S.range);
    $("#hint").classList.toggle("show", S.range);
    $("#hint").textContent = S.range ? (S.anchor ? "끝 사진을 눌러 주세요" : "시작 사진을 눌러 주세요") : "";
    $("#actions [data-a=rename]").style.display = S.sel.size === 1 && !S.trashView ? "" : "none";
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
    return null;
  }
  function autoLoop() { if (!drag || !drag.on) { raf = 0; return; } if (auto && autoEl) autoEl.scrollTop += auto; raf = requestAnimationFrame(autoLoop); }
  function dragEnd(drop) {
    var d = drag; drag = null; auto = 0; ghost.style.display = "none"; document.body.classList.remove("dragging");
    document.querySelectorAll(".drop").forEach(function (n) { n.classList.remove("drop"); });
    if (suppress) setTimeout(function () { suppress = false; }, 350);
    if (d && d.on && drop && d.target) moveInto(selPaths(), d.target.path);
  }
  window.addEventListener("pointermove", function (e) {
    if (!drag) return;
    if (!drag.on) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 10) return;
      drag.on = true; document.body.classList.add("dragging");
      var first = S.sel.size ? document.querySelector('#grid .it.on img.ok') : null;
      ghost.innerHTML = "<b>" + S.sel.size + "</b>";
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
    if (sc) { var r = sc.getBoundingClientRect(); if (e.clientY < r.top + 56) auto = -12; else if (e.clientY > r.bottom - 56) auto = 12; }
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
  $("#crumb").addEventListener("click", function (e) { var b = e.target.closest("[data-go]"); if (!b) return; go(b.dataset.go || null); });
  $("#btnClear").onclick = function () { clearSel(); paintSel(); };
  $("#btnAll").onclick = function () { var v = ids(); if (S.sel.size === v.length) { clearSel(); } else { v.forEach(function (x) { S.sel.add(x); }); S.selOn = true; } paintSel(); };
  $("#btnRange").onclick = function () { S.range = !S.range; S.anchor = null; paintSel(); };
  $("#btnSort").onclick = openSort;
  /* 위에서 펼쳐지는 작은 메뉴 */
  function closePop() { $("#pop").hidden = true; $("#pop").innerHTML = ""; $("#popScrim").hidden = true; }
  function popMenu(anchor, html, bind) {
    var pop = $("#pop"); pop.innerHTML = html; pop.hidden = false; $("#popScrim").hidden = false;
    var r = anchor.getBoundingClientRect();
    pop.style.top = (r.bottom + 6) + "px"; pop.style.right = Math.max(8, window.innerWidth - r.right) + "px";
    bind && bind(pop);
  }
  $("#popScrim").onclick = closePop;
  $("#btnMore").onclick = function () {
    popMenu(this, '<button class="mi" data-m="mk">＋ 새 폴더 만들기</button><button class="mi" data-m="trash">휴지통 보기</button><button class="mi' + (S.hideEmpty ? " on" : "") + '" data-m="empty">사진 없는 폴더 숨기기</button><button class="mi" data-m="re">새로고침</button><button class="mi" data-m="perm">파일 접근 권한 확인</button>', function (el) {
      el.querySelectorAll("[data-m]").forEach(function (b) {
        b.onclick = function () {
          var m = b.dataset.m; closePop();
          if (m === "mk") newFolder(S.cwd);
          else if (m === "trash") openTrash();
          else if (m === "empty") { S.hideEmpty = !S.hideEmpty; store.set("hideEmpty", S.hideEmpty); treeCache = null; B.flat = null; Promise.all([reload(), refreshB()]).then(function () { toast(S.hideEmpty ? "사진 없는 폴더를 숨겼어요" : "사진 없는 폴더도 보여요"); }); }
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
        '</div><div class="opt" style="margin-bottom:0"><span class="lbl">파일 이름</span><button data-g="n" data-v="1" class="' + (S.names ? "on" : "") + '">보이기</button><button data-g="n" data-v="0" class="' + (!S.names ? "on" : "") + '">숨기기</button></div>';
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
      }
      bind();
    });
  }
  $("#btnSort").onclick = openSort;

  /* ---------- 폴더 트리 (서랍 / 이동할 곳 고르기) ---------- */
  var treeCache = null;
  function loadTrees(force) {
    if (treeCache && !force) return Promise.resolve(treeCache);
    return Promise.all(S.roots.map(function (r) { return FS.tree({ path: r.path, depth: 8 }).then(function (x) { x.tree.name = r.name; return S.hideEmpty ? prune2(x.tree) : x.tree; }); })).then(function (t) { treeCache = t; return t; });
  }
  function treeHtml(nodes, opts, depth) {
    return nodes.map(function (n) {
      var has = n.kids && n.kids.length, dis = opts.disabled && opts.disabled(n.path), open = opts.open[n.path];
      return '<div class="tk" style="' + (depth ? "" : "margin-left:0") + '"><div class="tn' + (dis ? " dis" : "") + (opts.cur === n.path ? " cur" : "") + '" data-p="' + esc(n.path) + '"><span class="tg' + (open ? " open" : "") + '" data-t="1">' + (has ? '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>' : "") + '</span><span class="tl">' + esc(n.name) + "</span></div>" + (has && open ? treeHtml(n.kids, opts, depth + 1) : "") + "</div>";
    }).join("");
  }
  function bindTree(el, opts, onPick, redraw) {
    el.onclick = function (e) {
      var tn = e.target.closest(".tn"); if (!tn) return;
      var p = tn.dataset.p;
      if (e.target.closest("[data-t]")) { opts.open[p] = !opts.open[p]; redraw(); return; }
      onPick(p);
    };
  }
  function openDrawer() {
    loadTrees(true).then(function (trees) {
      var opts = { open: {}, cur: S.cwd };
      trees.forEach(function (t) { if (S.cwd && (S.cwd === t.path || S.cwd.indexOf(t.path + "/") === 0)) { var acc = t.path; opts.open[acc] = true; S.cwd.slice(t.path.length + 1).split("/").forEach(function (s) { if (s) { acc += "/" + s; opts.open[acc] = true; } }); } });
      var el = $("#drawerTree");
      function redraw() { el.innerHTML = treeHtml(trees, opts, 0); }
      redraw(); bindTree(el, opts, function (p) { closeDrawer(); go(p); }, redraw);
      $("#drawer").classList.add("show"); $("#scrim").classList.add("show");
    }).catch(err);
  }
  function closeDrawer() { $("#drawer").classList.remove("show"); $("#scrim").classList.remove("show"); }
  $("#btnTree").onclick = openDrawer; $("#scrim").onclick = closeDrawer; document.querySelector("[data-close=drawer]").onclick = closeDrawer;

  function pickFolder(title, disabledFn) {
    return loadTrees(true).then(function (trees) {
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
          return (n ? FS.mkdir({ parent: r.mk, name: n }).then(function (m) { S.fresh.add(m.path); }) : Promise.resolve()).then(function () { return pickLoop(title, dis); });
        });
      }
      return r;
    });
  }

  /* ---------- 동작: 이동 / 삭제 / 이름 / 새 폴더 ---------- */
  function selPaths() { return Array.from(S.sel); }
  function noteRecent(dest) {
    B.recent = [dest].concat(B.recent.filter(function (p) { return p !== dest; })).slice(0, 24); store.set("recent", B.recent);
  }
  function moveInto(paths, dest) {
    if (!paths.length) return Promise.resolve();
    return FS.move({ paths: paths, dest: dest }).then(function (r) {
      clearSel(); noteRecent(dest);
      return Promise.all([reload(), refreshB()]).then(function () {
        var n = r.moved.length, bad = r.failed.length;
        toast(n ? n + "개를 ‘" + nameOf(dest) + "’(으)로 옮겼어요" + (bad ? " (실패 " + bad + ")" : "") : (bad ? r.failed[0].error : "이미 그 폴더에 있어요"), "되돌리기", n ? function () { undoMove(r.moved); } : null);
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
    var by = {}; moved.forEach(function (m) { var d = parentOf(m.from); (by[d] = by[d] || []).push(m.to); });
    Promise.all(Object.keys(by).map(function (d) { return FS.move({ paths: by[d], dest: d }); })).then(function () { return Promise.all([reload(), refreshB()]); }).then(function () { toast("되돌렸어요"); }).catch(err);
  }
  function doTrash() {
    var paths = selPaths(); if (!paths.length) return;
    var hasF = paths.some(function (p) { return S.folders.some(function (f) { return f.path === p; }); });
    (hasF ? confirmBox("폴더가 들어 있어요", "고른 폴더와 그 안의 사진이 모두 휴지통으로 가요.", "휴지통으로", true) : Promise.resolve(true)).then(function (ok) {
      if (!ok) return;
      return FS.trash({ paths: paths }).then(function (r) {
        clearSel(); return reload().then(function () {
          toast(r.ids.length + "개를 휴지통으로 보냈어요" + (r.failed.length ? " (실패 " + r.failed.length + ")" : ""), "되돌리기", r.ids.length ? function () { FS.restore({ ids: r.ids }).then(reload).then(function () { toast("복원했어요"); }).catch(err); } : null);
        });
      });
    }).catch(err);
  }
  function doRename() {
    var p = selPaths()[0]; if (!p) return;
    askText("이름 바꾸기", nameOf(p), "바꾸기").then(function (n) {
      if (!n || n === nameOf(p)) return;
      return FS.rename({ path: p, name: n }).then(function () { clearSel(); return reload(); }).then(function () { toast("이름을 바꿨어요"); });
    }).catch(err);
  }
  function newFolder(parent) {
    if (parent == null) { toast("Pictures 같은 폴더 안으로 들어가서 만들어 주세요"); return; }
    askText("새 폴더 이름", "", "만들기").then(function (n) {
      if (!n) return;
      return FS.mkdir({ parent: parent, name: n }).then(function (m) { S.fresh.add(m.path); return reload(); }).then(function () { return refreshB(); }).then(function () { toast("폴더를 만들었어요"); });
    }).catch(err);
  }
  $("#actions").addEventListener("click", function (e) {
    var b = e.target.closest("[data-a]"); if (!b) return;
    ({ move: doMove, trash: doTrash, rename: doRename })[b.dataset.a]();
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
  function applySplit() {
    document.body.classList.toggle("split", S.split);
    $("#btnSplit").classList.toggle("on", S.split);
    $("#scroll").style.flexGrow = S.split ? S.ratio : 1;
    $("#card").style.flexGrow = S.ratio;
    $("#paneB").style.flexGrow = 1 - S.ratio;
    document.body.classList.toggle("card", cardOn());
    if (S.split) {
      var start = S.cwd2 != null ? S.cwd2 : (S.cwd != null && rootOf(S.cwd) && rootOf(S.cwd).path !== S.cwd ? parentOf(S.cwd) : null);
      goB(start);
    }
  }
  function goB(path, keep) {
    if (!keep) { B.q = ""; $("#bQ").value = ""; $(".bh").classList.remove("search"); }
    if (path == null) { S.cwd2 = null; store.set("cwd2", null); B.list = S.roots.map(function (r) { return { name: r.name, path: r.path, root: true, media: 0, sub: 0 }; }); drawB(); return Promise.resolve(); }
    return FS.list({ path: path, foldersOnly: true }).then(function (r) {
      S.cwd2 = path; store.set("cwd2", path); B.list = r.folders.filter(vis).sort(byName); drawB();
      if (!keep) $("#bscroll").scrollTop = 0;
    }).catch(function (e) { err(e); if (S.cwd2 !== path) goB(null); });
  }
  function refreshB() { return S.split ? goB(S.cwd2, true) : Promise.resolve(); }
  function relPath(p) { var r = rootOf(p); return (r ? r.name + p.slice(r.path.length) : p).split("/").join(" › "); }
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
    var meta = x.parent != null ? x.parent : (x.root ? "" : (x.media > 0 ? x.media + "장" : "") + (x.media > 0 && x.sub ? " · " : "") + (x.sub ? "폴더 " + x.sub : ""));
    return '<div class="it folder bt' + (x.cover ? " hascover" : "") + '" data-p="' + esc(x.path) + '" data-f="1"><div class="th">' + (x.cover ? '<img data-p="' + esc(x.cover) + '" data-state="" alt="">' : "") + FOLDER_SVG +
      '<span class="go" data-go="1">›</span></div><div class="lb">' + esc(x.name) + (meta ? "<small>" + esc(meta) + "</small>" : "") + "</div></div>";
  }
  function bHint() {
    var h = $("#bHint");
    if (cardOn()) { h.textContent = "지금 사진 → 폴더를 누르면 옮겨지고 다음 사진이 나와요"; h.classList.add("show"); }
    else if (S.sel.size) { h.textContent = "사진 " + S.sel.size + "장 · 폴더를 누르거나 끌어다 놓으면 옮겨져요"; h.classList.add("show"); }
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
    if (!e.target.closest(".go") && cardOn()) { cardMove(p); return; }
    if (!e.target.closest(".go") && S.sel.size && !S.trashView) { moveInto(selPaths(), p); return; }
    B.mode = "name"; store.set("bmode", "name"); goB(p);
  });
  $("#bSort").onclick = function () { B.mode = B.mode === "recent" ? "name" : "recent"; store.set("bmode", B.mode); B.q = ""; $("#bQ").value = ""; $(".bh").classList.remove("search"); drawB(); };
  function closeSearch() { B.q = ""; $("#bQ").value = ""; $(".bh").classList.remove("search"); drawB(); }
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

  /* ---------- 카드 모드: 사진 한 장씩, 위로 쓸면 삭제, 아래 폴더를 누르면 이동 ---------- */
  function cardOn() { return !!(S.split && S.card && !S.trashView && S.cwd != null); }
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
    ["#cPrev", "#cDel", "#cOpen", "#cNext"].forEach(function (id) { $(id).disabled = !f; });
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
        toast("‘" + f.name + "’을(를) 휴지통으로 보냈어요", "되돌리기", r.ids.length ? function () { FS.restore({ ids: r.ids }).then(reload).then(function () { toast("복원했어요"); }).catch(err); } : null);
      });
    }).catch(err);
  }
  $("#cPrev").onclick = function () { cardStep(-1); }; $("#cNext").onclick = function () { cardStep(1); };
  $("#cDel").onclick = cardDelete;
  $("#cOpen").onclick = function () { var f = cardList()[S.ci]; if (f) FS.openExternal({ path: f.path }).catch(err); };
  $("#btnCard").onclick = function () {
    if (S.cwd == null) { toast("폴더 안으로 들어가서 써 주세요"); return; }
    S.card = !S.card; store.set("card", S.card); clearSel(); paintSel(); document.body.classList.toggle("card", cardOn()); if (cardOn()) drawCard(); drawB();
  };
  (function () {
    var st = null, im = $("#cImg"), stage = $("#cStage");
    stage.addEventListener("pointerdown", function (e) { if (!cardOn() || !cardList()[S.ci]) return; st = { x: e.clientX, y: e.clientY, dx: 0, dy: 0 }; stage.setPointerCapture(e.pointerId); im.classList.remove("anim"); });
    stage.addEventListener("pointermove", function (e) {
      if (!st) return; st.dx = e.clientX - st.x; st.dy = e.clientY - st.y;
      var up = st.dy < 0 && Math.abs(st.dy) > Math.abs(st.dx);
      im.style.transform = up ? "translate(" + (st.dx * 0.3) + "px," + st.dy + "px) scale(" + Math.max(0.7, 1 + st.dy / 600) + ")" : "translate(" + st.dx + "px,0) rotate(" + (st.dx / 40) + "deg)";
      im.style.opacity = up ? Math.max(0.25, 1 + st.dy / 260) : Math.max(0.4, 1 - Math.abs(st.dx) / 500);
    });
    function end() {
      if (!st) return; var d = st; st = null; im.classList.add("anim");
      if (d.dy < -90 && Math.abs(d.dy) > Math.abs(d.dx)) { im.style.transform = "translate(0,-" + window.innerHeight + "px) scale(.6)"; im.style.opacity = 0; setTimeout(cardDelete, 180); }
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
    if ($("#drawer").classList.contains("show")) { closeDrawer(); return true; }
    if ($(".bh").classList.contains("search")) { closeSearch(); return true; }
    if (S.selOn || S.sel.size) { clearSel(); paintSel(); return true; }
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
      return go(last && rootOf(last) ? last : null).then(applySplit);
    }).catch(function (e) { diag("시작 실패: " + ((e && e.message) || e)); });
  }
  checkAccess().then(function (g) { if (g) start(); });
  window.__jp = { S: S, go: go, reload: reload };
})();
