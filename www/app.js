/* 대짬철갤러리 — 폰 사진 폴더 정리 (폴더 위계는 폰 저장소 그대로) */
(function () {
  "use strict";
  var $ = function (s, e) { return (e || document).querySelector(s); };
  var esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var native = !!(window.Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform());
  var FS = native ? Capacitor.registerPlugin("PhotoFs") : MockFS();
  var AppPlug = native && Capacitor.Plugins ? Capacitor.Plugins.App : null;
  var store = {
    get: function (k, d) { try { var v = localStorage.getItem("jp-" + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem("jp-" + k, JSON.stringify(v)); } catch (e) {} }
  };

  var S = {
    home: "", roots: [], cwd: null, folders: [], files: [],
    sort: store.get("sort", { k: "date", d: -1 }), cols: store.get("cols", 3), names: store.get("names", false),
    sel: new Set(), selOn: false, range: false, anchor: null, last: null,
    trashView: false, trash: [], viewer: null
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
  function order() { return S.folders.concat(S.files); }

  function go(path, keepSel) {
    S.trashView = false; document.body.classList.remove("trashv");
    if (!keepSel) clearSel();
    if (path == null) {
      S.cwd = null; S.folders = S.roots.map(function (r) { return { name: r.name, path: r.path, mtime: 0, media: 0, sub: 0, root: true }; }); S.files = [];
      draw(); return Promise.resolve();
    }
    return FS.list({ path: path }).then(function (r) {
      S.cwd = path; S.folders = r.folders; S.files = r.files; sortList(); store.set("cwd", path); draw(); $("#scroll").scrollTop = 0;
    }).catch(function (e) { err(e); if (S.cwd !== path) go(null); });
  }
  function reload() { return S.cwd == null ? go(null, true) : FS.list({ path: S.cwd }).then(function (r) { S.folders = r.folders; S.files = r.files; sortList(); prune(); draw(); }); }
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
  function setupIO() {
    if (io) io.disconnect();
    thumbQ = [];
    io = new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        var im = e.target.querySelector("img"); if (!im) return;
        if (e.isIntersecting) { if (im.dataset.state === "" || im.dataset.state === "x") { im.dataset.state = "q"; thumbQ.push(im); } }
        else if (im.dataset.state === "d") { im.removeAttribute("src"); im.classList.remove("ok"); im.dataset.state = ""; }
        else if (im.dataset.state === "q") im.dataset.state = "";
      });
      pump();
    }, { root: $("#scroll"), rootMargin: "700px 0px" });
  }
  function itemHtml(x, isFolder) {
    var on = S.sel.has(x.path) ? " on" : "", anc = S.anchor === x.path ? " anchor" : "";
    if (isFolder) {
      var meta = x.root ? "" : (x.media ? x.media + "장" : "") + (x.media && x.sub ? " · " : "") + (x.sub ? "폴더 " + x.sub : "") || "비었어요";
      return '<div class="it folder' + on + anc + '" data-p="' + esc(x.path) + '" data-f="1"><span class="ck"></span>' + FOLDER_SVG + '<span class="fn">' + esc(x.name) + '</span><span class="fc">' + esc(meta) + "</span></div>";
    }
    return '<div class="it' + on + anc + '" data-p="' + esc(x.path) + '"><img data-p="' + esc(x.path) + '" data-state="" alt=""><span class="ck"></span>' + (x.video ? '<span class="vid">영상</span>' : "") + '<span class="nm">' + esc(x.name) + "</span></div>";
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

  /* 누르기 / 꾹 누르기 */
  var press = null, suppress = false;
  var grid = $("#grid");
  grid.addEventListener("pointerdown", function (e) {
    var it = e.target.closest(".it"); if (!it) return;
    press = { it: it, x: e.clientX, y: e.clientY, t: setTimeout(function () {
      if (!press) return; suppress = true;
      var p = it.dataset.p;
      if (!S.selOn) startSel(p); else if (!S.sel.has(p)) toggle(p);
      press = null;
    }, 380) };
  });
  grid.addEventListener("pointermove", function (e) { if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 9) { clearTimeout(press.t); press = null; } });
  ["pointerup", "pointercancel", "pointerleave"].forEach(function (ev) { grid.addEventListener(ev, function () { if (press) { clearTimeout(press.t); press = null; } }); });
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
  $("#btnMore").onclick = function () {
    sheet('<div class="body"><button class="mi" data-m="mk">＋ 새 폴더 만들기</button><button class="mi" data-m="trash">휴지통 보기</button><button class="mi" data-m="re">새로고침</button><button class="mi" data-m="perm">파일 접근 권한 확인</button></div>', function (el, close) {
      el.querySelectorAll("[data-m]").forEach(function (b) { b.onclick = function () { close(b.dataset.m); }; });
    }).then(function (m) {
      if (m === "mk") newFolder(S.cwd);
      else if (m === "trash") openTrash();
      else if (m === "re") reload();
      else if (m === "perm") checkAccess(true);
    });
  };

  function openSort() {
    function draw2() {
      var o = function (grp, key, val, label) { return '<button data-g="' + grp + '" data-v="' + val + '" class="' + (S[grp === "k" ? "sort" : "sort"][grp] === val ? "on" : "") + '">' + label + "</button>"; };
      return '<h3>정렬 · 보기</h3><div class="body"><div class="opt"><span class="lbl">기준</span>' + o("k", "k", "name", "이름") + o("k", "k", "date", "날짜") + o("k", "k", "size", "크기") +
        '</div><div class="opt"><span class="lbl">방향</span><button data-g="d" data-v="1" class="' + (S.sort.d === 1 ? "on" : "") + '">오름차순</button><button data-g="d" data-v="-1" class="' + (S.sort.d === -1 ? "on" : "") + '">내림차순</button></div>' +
        '<div class="opt"><span class="lbl">한 줄 칸 수</span>' + [2, 3, 4, 5, 6].map(function (n) { return '<button data-g="c" data-v="' + n + '" class="' + (S.cols === n ? "on" : "") + '">' + n + "</button>"; }).join("") +
        '</div><div class="opt"><span class="lbl">파일 이름</span><button data-g="n" data-v="1" class="' + (S.names ? "on" : "") + '">보이기</button><button data-g="n" data-v="0" class="' + (!S.names ? "on" : "") + '">숨기기</button></div></div><div class="btns"><button class="pri" data-done="1">닫기</button></div>';
    }
    sheet(draw2(), function (el, close) {
      function bind() {
        el.querySelectorAll("[data-g]").forEach(function (b) {
          b.onclick = function () {
            var g = b.dataset.g, v = b.dataset.v;
            if (g === "k") S.sort.k = v; else if (g === "d") S.sort.d = +v; else if (g === "c") S.cols = +v; else if (g === "n") S.names = v === "1";
            store.set("sort", S.sort); store.set("cols", S.cols); store.set("names", S.names);
            sortList(); draw(); el.innerHTML = draw2(); bind();
          };
        });
        var d = el.querySelector("[data-done]"); if (d) d.onclick = function () { close(); };
      }
      bind();
    });
  }

  /* ---------- 폴더 트리 (서랍 / 이동할 곳 고르기) ---------- */
  var treeCache = null;
  function loadTrees(force) {
    if (treeCache && !force) return Promise.resolve(treeCache);
    return Promise.all(S.roots.map(function (r) { return FS.tree({ path: r.path, depth: 8 }).then(function (x) { x.tree.name = r.name; return x.tree; }); })).then(function (t) { treeCache = t; return t; });
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
          return (n ? FS.mkdir({ parent: r.mk, name: n }) : Promise.resolve()).then(function () { return pickLoop(title, dis); });
        });
      }
      return r;
    });
  }

  /* ---------- 동작: 이동 / 삭제 / 이름 / 새 폴더 ---------- */
  function selPaths() { return Array.from(S.sel); }
  function doMove() {
    var paths = selPaths(); if (!paths.length) return;
    var folders = paths.filter(function (p) { return S.folders.some(function (f) { return f.path === p; }); });
    pickLoop(paths.length + "개를 어디로 옮길까요?", function (p) {
      if (p === S.cwd) return true;
      return folders.some(function (f) { return p === f || p.indexOf(f + "/") === 0; });
    }).then(function (dest) {
      if (!dest) return;
      return FS.move({ paths: paths, dest: dest }).then(function (r) {
        clearSel(); return reload().then(function () {
          var n = r.moved.length, bad = r.failed.length;
          toast(n + "개를 ‘" + nameOf(dest) + "’(으)로 옮겼어요" + (bad ? " (실패 " + bad + ")" : ""), "되돌리기", n ? function () { undoMove(r.moved); } : null);
        });
      });
    }).catch(err);
  }
  function undoMove(moved) {
    var by = {}; moved.forEach(function (m) { var d = parentOf(m.from); (by[d] = by[d] || []).push(m.to); });
    Promise.all(Object.keys(by).map(function (d) { return FS.move({ paths: by[d], dest: d }); })).then(reload).then(function () { toast("되돌렸어요"); }).catch(err);
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
      return FS.mkdir({ parent: parent, name: n }).then(reload).then(function () { toast("폴더를 만들었어요"); });
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

  /* ---------- 크게 보기 ---------- */
  var vList = [], vTok = 0;
  function openViewer(p) {
    vList = S.files.filter(function (f) { return !f.video; }); var i = vList.findIndex(function (f) { return f.path === p; });
    if (i < 0) { toast("영상은 갤러리 앱에서 열어 주세요"); return; }
    S.viewer = i; $("#viewer").hidden = false; showV();
  }
  function showV() {
    var f = vList[S.viewer]; if (!f) return;
    $("#vName").textContent = f.name; $("#vPos").textContent = (S.viewer + 1) + " / " + vList.length;
    var tok = ++vTok, im = $("#vImg"); im.style.opacity = .4;
    FS.thumb({ path: f.path, size: 1600 }).then(function (r) { if (tok === vTok) { im.src = r.data; im.style.opacity = 1; } }).catch(err);
  }
  function stepV(d) { var n = S.viewer + d; if (n < 0 || n >= vList.length) return; S.viewer = n; showV(); }
  function closeV() { $("#viewer").hidden = true; S.viewer = null; $("#vImg").removeAttribute("src"); }
  $("#vClose").onclick = closeV; $("#vPrev").onclick = function () { stepV(-1); }; $("#vNext").onclick = function () { stepV(1); };
  (function () {
    var sx = null; var v = $("#viewer");
    v.addEventListener("touchstart", function (e) { sx = e.touches.length === 1 ? e.touches[0].clientX : null; }, { passive: true });
    v.addEventListener("touchend", function (e) { if (sx == null) return; var dx = e.changedTouches[0].clientX - sx; if (Math.abs(dx) > 60) stepV(dx < 0 ? 1 : -1); sx = null; });
  })();

  /* ---------- 권한 / 시작 ---------- */
  function checkAccess(manual) {
    return FS.hasAccess().then(function (r) {
      $("#perm").hidden = !!r.granted;
      if (manual) toast(r.granted ? "권한이 켜져 있어요" : "권한이 꺼져 있어요");
      return r.granted;
    });
  }
  $("#permBtn").onclick = function () { FS.requestAccess().catch(err); };
  document.addEventListener("visibilitychange", function () { if (!document.hidden && !$("#perm").hidden) checkAccess().then(function (g) { if (g) start(); }); });

  function back() {
    if (!$("#sheetWrap").hidden) { sheetClose && sheetClose(); return true; }
    if (!$("#viewer").hidden) { closeV(); return true; }
    if ($("#drawer").classList.contains("show")) { closeDrawer(); return true; }
    if (S.selOn || S.sel.size) { clearSel(); paintSel(); return true; }
    if (S.trashView) { go(S.cwd); return true; }
    if (S.cwd != null) { var r = rootOf(S.cwd); go(r && r.path === S.cwd ? null : parentOf(S.cwd)); return true; }
    return false;
  }
  if (AppPlug && AppPlug.addListener) AppPlug.addListener("backButton", function () { if (!back()) AppPlug.exitApp(); });
  window.addEventListener("keydown", function (e) { if (e.key === "Escape") back(); });

  var started = false;
  function start() {
    if (started) return; started = true;
    FS.roots().then(function (r) {
      S.home = r.home; S.roots = r.roots;
      var last = store.get("cwd", null);
      return go(last && rootOf(last) ? last : null);
    }).catch(err);
  }
  checkAccess().then(function (g) { if (g) start(); });
  window.__jp = { S: S, go: go, reload: reload };
})();
