/* 브라우저에서 화면만 확인할 때 쓰는 가짜 파일 시스템 (앱 안에서는 안 쓰임) */
function MockFS() {
  var HOME = "/storage/emulated/0";
  var seed = 7;
  function rnd() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }
  function dir(name, kids) { return { name: name, dir: true, mtime: Date.now() - rnd() * 8e9, kids: kids || [] }; }
  function files(n, prefix, vidEvery) {
    var a = [];
    for (var i = 1; i <= n; i++) {
      var v = vidEvery && i % vidEvery === 0;
      a.push({ name: prefix + String(i).padStart(4, "0") + (v ? ".mp4" : ".jpg"), video: !!v, size: Math.floor(200000 + rnd() * 6e6), mtime: Date.now() - rnd() * 3e10, hue: Math.floor(rnd() * 360) });
    }
    return a;
  }
  var tree = dir("", [
    dir("DCIM", [dir("Camera", files(60, "IMG_", 9)), dir("Screenshots", files(25, "Screenshot_"))]),
    dir("Pictures", [dir("여행", [dir("제주", files(30, "jeju_")), dir("부산", files(12, "busan_")), ].concat(files(3, "여행_"))), dir("앨범", files(80, "album_")), dir("빈폴더")]),
    dir("Download", files(10, "dl_")),
  ]);
  var trash = [];
  function node(p) {
    if (p === HOME) return tree;
    var parts = p.slice(HOME.length + 1).split("/"), n = tree;
    for (var i = 0; i < parts.length; i++) { n = (n.kids || []).filter(function (k) { return k.name === parts[i]; })[0]; if (!n) return null; }
    return n;
  }
  function parentOf(p) { return p.slice(0, p.lastIndexOf("/")); }
  function nameOf(p) { return p.slice(p.lastIndexOf("/") + 1); }
  function uniq(par, name) {
    var t = name, i = 1, ex = "", base = name, d = name.lastIndexOf(".");
    if (d > 0) { base = name.slice(0, d); ex = name.slice(d); }
    while (par.kids.some(function (k) { return k.name === t; })) t = base + " (" + i++ + ")" + ex;
    return t;
  }
  function wait(v) { return new Promise(function (r) { setTimeout(function () { r(JSON.parse(JSON.stringify(v))); }, 40); }); }
  function svg(hue, label, size) {
    var s = "<svg xmlns='http://www.w3.org/2000/svg' width='" + size + "' height='" + size + "'><rect width='100%' height='100%' fill='hsl(" + hue + ",42%,62%)'/><circle cx='70%' cy='32%' r='" + size / 8 + "' fill='hsl(" + hue + ",50%,82%)'/><path d='M0 " + size + "L" + size * .4 + " " + size * .5 + "L" + size * .7 + " " + size * .8 + "L" + size * .85 + " " + size * .65 + "L" + size + " " + size + "Z' fill='hsl(" + hue + ",40%,40%)'/><text x='8' y='" + (size - 10) + "' font-size='" + Math.max(12, size / 16) + "' fill='white'>" + label + "</text></svg>";
    return "data:image/svg+xml;utf8," + encodeURIComponent(s);
  }
  function pathNode(p) { if (p.indexOf("/.jjamtrash/") > 0) { var id = p.split("/")[p.split("/").length - 2]; var t = trash.filter(function (x) { return x.id === id; })[0]; return t && t.node; } return node(p); }
  return {
    openExternal: function (o) { window.__opened = o.path; return wait({}); },
    hasAccess: function () { return wait({ granted: true }); },
    requestAccess: function () { return wait({}); },
    roots: function () { return wait({ home: HOME, roots: ["DCIM", "Pictures", "Download"].map(function (n) { return { name: n, path: HOME + "/" + n }; }) }); },
    list: function (o) {
      var n = node(o.path); if (!n) return Promise.reject({ message: "폴더가 없어요" });
      var fo = [], fi = [];
      n.kids.forEach(function (k) {
        var p = o.path + "/" + k.name;
        if (k.dir) { var f1 = k.kids.filter(function (c) { return !c.dir && !c.video; })[0]; fo.push({ name: k.name, path: p, mtime: k.mtime, media: k.kids.filter(function (c) { return !c.dir; }).length, sub: k.kids.filter(function (c) { return c.dir; }).length, cover: f1 ? p + "/" + f1.name : undefined }); }
        else if (!o.foldersOnly) fi.push({ name: k.name, path: p, mtime: k.mtime, size: k.size, video: k.video });
      });
      return wait({ folders: fo, files: fi });
    },
    tree: function (o) {
      function t(n, p, d) { return { name: n.name, path: p, kids: d <= 0 ? [] : n.kids.filter(function (k) { return k.dir; }).sort(function (a, b) { return a.name.localeCompare(b.name); }).map(function (k) { return t(k, p + "/" + k.name, d - 1); }) }; }
      return wait({ tree: t(node(o.path), o.path, o.depth || 6) });
    },
    thumb: function (o) { var n = pathNode(o.path); return wait({ data: svg(n ? n.hue || 200 : 0, nameOf(o.path), o.size > 512 ? 800 : 160) }); },
    move: function (o) {
      var dest = node(o.dest), moved = [], failed = [];
      o.paths.forEach(function (p) {
        var src = node(p), par = node(parentOf(p));
        if (o.dest.indexOf(p + "/") === 0 || o.dest === p) { failed.push({ path: p, error: "폴더를 자기 안으로는 옮길 수 없어요" }); return; }
        if (parentOf(p) === o.dest) return;
        par.kids.splice(par.kids.indexOf(src), 1);
        var nn = uniq(dest, src.name); src.name = nn; dest.kids.push(src);
        moved.push({ from: p, to: o.dest + "/" + nn });
      });
      return wait({ moved: moved, failed: failed });
    },
    mkdir: function (o) { var par = node(o.parent); if (par.kids.some(function (k) { return k.name === o.name; })) return Promise.reject({ message: "같은 이름이 이미 있어요" }); par.kids.push(dir(o.name)); return wait({ path: o.parent + "/" + o.name }); },
    rename: function (o) { var n = node(o.path), par = node(parentOf(o.path)); if (par.kids.some(function (k) { return k.name === o.name; })) return Promise.reject({ message: "같은 이름이 이미 있어요" }); n.name = o.name; return wait({ path: parentOf(o.path) + "/" + o.name }); },
    trash: function (o) {
      var ids = [];
      o.paths.forEach(function (p) { var n = node(p), par = node(parentOf(p)); par.kids.splice(par.kids.indexOf(n), 1); var id = Date.now() + "_" + trash.length; trash.push({ id: id, name: n.name, orig: p, at: Date.now(), dir: !!n.dir, size: n.size || 0, node: n }); ids.push(id); });
      return wait({ ids: ids, failed: [] });
    },
    listTrash: function () { return wait({ keepDays: 30, items: trash.map(function (t) { return { id: t.id, name: t.name, orig: t.orig, at: t.at, dir: t.dir, size: t.size, video: !!t.node.video, path: HOME + "/.jjamtrash/" + t.id + "/" + t.name }; }) }); },
    restore: function (o) {
      var back = [];
      o.ids.forEach(function (id) { var i = trash.findIndex(function (t) { return t.id === id; }); if (i < 0) return; var t = trash[i], par = node(parentOf(t.orig)) || tree; t.node.name = uniq(par, t.name); par.kids.push(t.node); trash.splice(i, 1); back.push({ id: id, to: "" }); });
      return wait({ restored: back, failed: [] });
    },
    purge: function (o) { var n = 0; trash = trash.filter(function (t) { if (!o.ids || o.ids.indexOf(t.id) >= 0) { n++; return false; } return true; }); return wait({ count: n }); },
  };
}
