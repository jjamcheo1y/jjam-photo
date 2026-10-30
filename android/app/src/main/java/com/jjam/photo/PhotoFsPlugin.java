package com.jjam.photo;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.provider.MediaStore;
import android.webkit.MimeTypeMap;
import androidx.core.content.FileProvider;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.media.ExifInterface;
import android.media.MediaMetadataRetriever;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.PluginMethod;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 폰의 진짜 사진 폴더를 읽고 옮기는 플러그인.
 * - 기기 저장소 전체 접근 권한(MANAGE_EXTERNAL_STORAGE)을 받은 뒤 java.io.File 로 직접 다룸.
 * - 지우기는 .jjamtrash 폴더로 옮기는 휴지통(30일 뒤 자동 비움).
 */
@CapacitorPlugin(name = "PhotoFs")
public class PhotoFsPlugin extends Plugin {
    private static final Set<String> IMG = new HashSet<>(Arrays.asList("jpg", "jpeg", "png", "gif", "webp", "bmp", "heic", "heif", "avif"));
    private static final Set<String> VID = new HashSet<>(Arrays.asList("mp4", "mkv", "webm", "mov", "3gp", "avi", "m4v"));
    private static final long TRASH_KEEP_MS = 30L * 24 * 60 * 60 * 1000;

    private final ExecutorService pool = Executors.newFixedThreadPool(4);
    private final Object trashLock = new Object();
    private File root;
    private File trashDir;

    @Override
    public void load() {
        root = Environment.getExternalStorageDirectory();
        trashDir = new File(root, ".jjamtrash");
    }

    /* ---------- 권한 ---------- */
    private boolean access() {
        if (Build.VERSION.SDK_INT >= 30) return Environment.isExternalStorageManager();
        return getContext().checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED;
    }

    @PluginMethod
    public void hasAccess(PluginCall call) {
        JSObject o = new JSObject();
        o.put("granted", access());
        call.resolve(o);
    }

    @PluginMethod
    public void requestAccess(PluginCall call) {
        try {
            if (Build.VERSION.SDK_INT >= 30) {
                Intent i = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:" + getContext().getPackageName()));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(i);
            } else {
                getActivity().requestPermissions(new String[]{Manifest.permission.READ_EXTERNAL_STORAGE, Manifest.permission.WRITE_EXTERNAL_STORAGE}, 4321);
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("설정 화면을 열지 못했어요: " + e.getMessage());
        }
    }

    /* ---------- 공통 ---------- */
    private File safe(String p) throws Exception {
        if (p == null) throw new Exception("경로가 없어요");
        File f = new File(p).getCanonicalFile();
        String r = root.getCanonicalPath();
        String s = f.getPath();
        if (!s.equals(r) && !s.startsWith(r + "/")) throw new Exception("저장소 밖은 건드릴 수 없어요");
        return f;
    }

    private static String ext(String name) {
        int i = name.lastIndexOf('.');
        return i < 0 ? "" : name.substring(i + 1).toLowerCase();
    }

    private static boolean isMedia(String name) {
        String e = ext(name);
        return IMG.contains(e) || VID.contains(e);
    }

    private static List<String> strings(JSArray a) throws Exception {
        List<String> out = new ArrayList<>();
        if (a == null) return out;
        for (int i = 0; i < a.length(); i++) out.add(a.getString(i));
        return out;
    }

    private void scan(List<String> paths) {
        if (paths.isEmpty()) return;
        MediaScannerConnection.scanFile(getContext(), paths.toArray(new String[0]), null, null);
    }

    private static void collectFiles(File f, List<String> out, int cap) {
        if (out.size() >= cap) return;
        if (f.isDirectory()) {
            File[] kids = f.listFiles();
            if (kids != null) for (File k : kids) collectFiles(k, out, cap);
        } else out.add(f.getPath());
    }

    private static File unique(File dir, String name) {
        File t = new File(dir, name);
        if (!t.exists()) return t;
        String base = name, ex = "";
        int i = name.lastIndexOf('.');
        if (i > 0) { base = name.substring(0, i); ex = name.substring(i); }
        for (int n = 1; n < 10000; n++) {
            t = new File(dir, base + " (" + n + ")" + ex);
            if (!t.exists()) return t;
        }
        return new File(dir, base + "_" + System.currentTimeMillis() + ex);
    }

    private static void copyFile(File a, File b) throws Exception {
        try (InputStream in = new FileInputStream(a); OutputStream out = new FileOutputStream(b)) {
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        }
        b.setLastModified(a.lastModified());
    }

    private static void copyAny(File a, File b) throws Exception {
        if (a.isDirectory()) {
            if (!b.mkdirs() && !b.isDirectory()) throw new Exception("폴더를 만들지 못했어요");
            File[] kids = a.listFiles();
            if (kids != null) for (File k : kids) copyAny(k, new File(b, k.getName()));
        } else copyFile(a, b);
    }

    private static boolean deleteAny(File f) {
        if (f.isDirectory()) {
            File[] kids = f.listFiles();
            if (kids != null) for (File k : kids) deleteAny(k);
        }
        return f.delete();
    }

    private static long sizeOf(File f) {
        if (!f.isDirectory()) return f.length();
        long s = 0;
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) s += sizeOf(k);
        return s;
    }

    /** a 를 b 로 옮기기: 이름 바꾸기가 되면 그대로, 안 되면 복사 뒤 지우기 */
    private static void moveAny(File a, File b) throws Exception {
        if (a.renameTo(b)) return;
        copyAny(a, b);
        if (!deleteAny(a)) throw new Exception("원본을 지우지 못했어요");
    }

    /** 폴더 안(하위 폴더 포함)에 사진/영상이 하나라도 있는지. 너무 깊거나 많으면 있다고 쳐 줌 */
    private static boolean hasMedia(File dir, int[] budget, int depth) {
        File[] kids = dir.listFiles();
        if (kids == null) return false;
        for (File k : kids) {
            if (k.getName().startsWith(".")) continue;
            if (--budget[0] < 0) return true;
            if (!k.isDirectory() && isMedia(k.getName())) return true;
        }
        if (depth <= 0) return false;
        for (File k : kids) {
            if (k.getName().startsWith(".") || !k.isDirectory()) continue;
            if (hasMedia(k, budget, depth - 1)) return true;
        }
        return false;
    }

    /* ---------- 목록 ---------- */
    @PluginMethod
    public void roots(PluginCall call) {
        JSArray arr = new JSArray();
        String[] names = {"DCIM", "Pictures", "Download", "Movies"};
        for (String n : names) {
            File f = new File(root, n);
            if (f.isDirectory()) {
                JSObject o = new JSObject();
                o.put("name", n);
                o.put("path", f.getPath());
                arr.put(o);
            }
        }
        JSObject res = new JSObject();
        res.put("roots", arr);
        res.put("home", root.getPath());
        call.resolve(res);
    }

    @PluginMethod
    public void list(final PluginCall call) {
        pool.execute(() -> {
            try {
                File dir = safe(call.getString("path"));
                boolean foldersOnly = Boolean.TRUE.equals(call.getBoolean("foldersOnly", false));
                File[] kids = dir.listFiles();
                JSArray folders = new JSArray(), files = new JSArray();
                if (kids != null) {
                    for (File k : kids) {
                        String n = k.getName();
                        if (n.startsWith(".")) continue;
                        JSObject o = new JSObject();
                        o.put("name", n);
                        o.put("path", k.getPath());
                        o.put("mtime", k.lastModified());
                        if (k.isDirectory()) {
                            int media = 0, sub = 0;
                            String cover = null;
                            File[] in = k.listFiles();
                            if (in != null) for (File c : in) {
                                if (c.getName().startsWith(".")) continue;
                                if (c.isDirectory()) sub++;
                                else if (isMedia(c.getName())) { media++; if (cover == null && !VID.contains(ext(c.getName()))) cover = c.getPath(); }
                            }
                            if (cover != null) o.put("cover", cover);
                            o.put("has", media > 0 || (sub > 0 && hasMedia(k, new int[]{3000}, 8)));
                            o.put("media", media);
                            o.put("sub", sub);
                            folders.put(o);
                        } else if (!foldersOnly && isMedia(n)) {
                            o.put("size", k.length());
                            o.put("video", VID.contains(ext(n)));
                            files.put(o);
                        }
                    }
                }
                JSObject res = new JSObject();
                res.put("folders", folders);
                res.put("files", files);
                call.resolve(res);
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()));
            }
        });
    }

    /** 폴더 트리(폴더만, 깊이 제한) — 이동할 곳 고르기용 */
    @PluginMethod
    public void tree(final PluginCall call) {
        pool.execute(() -> {
            try {
                File dir = safe(call.getString("path"));
                int depth = call.getInt("depth", 6);
                JSObject res = new JSObject();
                res.put("tree", treeOf(dir, depth));
                call.resolve(res);
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()));
            }
        });
    }

    private JSObject treeOf(File dir, int depth) {
        JSObject o = new JSObject();
        o.put("name", dir.getName());
        o.put("path", dir.getPath());
        JSArray kids = new JSArray();
        boolean has = false;
        File[] list = dir.listFiles();
        if (list != null) {
            Arrays.sort(list, (x, y) -> x.getName().compareToIgnoreCase(y.getName()));
            for (File k : list) {
                if (k.getName().startsWith(".")) continue;
                if (k.isDirectory()) {
                    if (depth > 0) {
                        JSObject c = treeOf(k, depth - 1);
                        kids.put(c);
                        if (c.optBoolean("has")) has = true;
                    } else if (!has && hasMedia(k, new int[]{800}, 4)) has = true;
                } else if (!has && isMedia(k.getName())) has = true;
            }
        }
        o.put("has", has);
        o.put("kids", kids);
        return o;
    }

    /* ---------- 기본 갤러리(다른 앱)로 열기 ---------- */
    @PluginMethod
    public void openExternal(final PluginCall call) {
        try {
            File f = safe(call.getString("path"));
            if (!f.isFile()) throw new Exception("파일이 없어요");
            String ex = ext(f.getName());
            boolean vid = VID.contains(ex);
            String mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ex);
            if (mime == null) mime = vid ? "video/*" : "image/*";
            Uri uri = mediaUri(f, vid);
            if (uri == null) uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", f);
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(uri, mime);
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("열지 못했어요: " + e.getMessage());
        }
    }

    /** 갤러리 앱이 앨범 맥락으로 열 수 있게 MediaStore 주소를 먼저 찾아 봄 */
    private Uri mediaUri(File f, boolean video) {
        Cursor c = null;
        try {
            Uri base = video ? MediaStore.Video.Media.EXTERNAL_CONTENT_URI : MediaStore.Images.Media.EXTERNAL_CONTENT_URI;
            c = getContext().getContentResolver().query(base, new String[]{MediaStore.MediaColumns._ID}, MediaStore.MediaColumns.DATA + "=?", new String[]{f.getPath()}, null);
            if (c != null && c.moveToFirst()) return Uri.withAppendedPath(base, String.valueOf(c.getLong(0)));
        } catch (Exception ignore) {
        } finally {
            if (c != null) c.close();
        }
        return null;
    }

    /* ---------- 썸네일 / 미리보기 ---------- */
    @PluginMethod
    public void thumb(final PluginCall call) {
        pool.execute(() -> {
            try {
                File f = safe(call.getString("path"));
                int size = call.getInt("size", 256);
                File cache = null;
                if (size <= 512) {
                    File cd = new File(getContext().getCacheDir(), "thumbs");
                    cd.mkdirs();
                    cache = new File(cd, md5(f.getPath() + "|" + f.lastModified() + "|" + f.length() + "|" + size) + ".jpg");
                    if (cache.exists()) {
                        JSObject r = new JSObject();
                        r.put("data", "data:image/jpeg;base64," + Base64.encodeToString(readAll(cache), Base64.NO_WRAP));
                        call.resolve(r);
                        return;
                    }
                }
                Bitmap bmp = VID.contains(ext(f.getName())) ? videoFrame(f, size) : decode(f, size);
                if (bmp == null) { call.reject("그림을 읽지 못했어요"); return; }
                ByteArrayOutputStream bo = new ByteArrayOutputStream();
                bmp.compress(Bitmap.CompressFormat.JPEG, size <= 512 ? 78 : 88, bo);
                bmp.recycle();
                byte[] bytes = bo.toByteArray();
                if (cache != null) {
                    try (OutputStream out = new FileOutputStream(cache)) { out.write(bytes); } catch (Exception ignore) {}
                }
                JSObject r = new JSObject();
                r.put("data", "data:image/jpeg;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP));
                call.resolve(r);
            } catch (Throwable e) {
                call.reject(String.valueOf(e.getMessage()));
            }
        });
    }

    private static Bitmap decode(File f, int size) throws Exception {
        BitmapFactory.Options o = new BitmapFactory.Options();
        o.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(f.getPath(), o);
        int s = 1;
        while (o.outWidth / (s * 2) >= size && o.outHeight / (s * 2) >= size) s *= 2;
        o = new BitmapFactory.Options();
        o.inSampleSize = s;
        Bitmap b = BitmapFactory.decodeFile(f.getPath(), o);
        if (b == null) return null;
        int rot = 0;
        try {
            int ori = new ExifInterface(f.getPath()).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL);
            if (ori == ExifInterface.ORIENTATION_ROTATE_90) rot = 90;
            else if (ori == ExifInterface.ORIENTATION_ROTATE_180) rot = 180;
            else if (ori == ExifInterface.ORIENTATION_ROTATE_270) rot = 270;
        } catch (Exception ignore) {}
        return fit(b, size, rot);
    }

    private static Bitmap videoFrame(File f, int size) {
        MediaMetadataRetriever m = new MediaMetadataRetriever();
        try {
            m.setDataSource(f.getPath());
            Bitmap b = m.getFrameAtTime(0);
            return b == null ? null : fit(b, size, 0);
        } catch (Exception e) {
            return null;
        } finally {
            try { m.release(); } catch (Exception ignore) {}
        }
    }

    /** 긴 쪽이 size 가 되게 줄이고 필요하면 돌리기 */
    private static Bitmap fit(Bitmap b, int size, int rot) {
        float sc = Math.min(1f, (float) size / Math.max(b.getWidth(), b.getHeight()));
        if (sc >= 1f && rot == 0) return b;
        Matrix mx = new Matrix();
        mx.postScale(sc, sc);
        if (rot != 0) mx.postRotate(rot);
        Bitmap n = Bitmap.createBitmap(b, 0, 0, b.getWidth(), b.getHeight(), mx, true);
        if (n != b) b.recycle();
        return n;
    }

    private static byte[] readAll(File f) throws Exception {
        try (InputStream in = new FileInputStream(f); ByteArrayOutputStream bo = new ByteArrayOutputStream()) {
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
            return bo.toByteArray();
        }
    }

    private static String md5(String s) throws Exception {
        byte[] d = MessageDigest.getInstance("MD5").digest(s.getBytes("UTF-8"));
        StringBuilder sb = new StringBuilder();
        for (byte x : d) sb.append(String.format("%02x", x));
        return sb.toString();
    }

    /* ---------- 옮기기 / 폴더 / 이름 ---------- */
    @PluginMethod
    public void move(final PluginCall call) {
        pool.execute(() -> {
            try {
                File dest = safe(call.getString("dest"));
                if (!dest.isDirectory()) throw new Exception("옮길 폴더가 없어요");
                JSArray moved = new JSArray(), failed = new JSArray();
                List<String> toScan = new ArrayList<>();
                for (String p : strings(call.getArray("paths"))) {
                    try {
                        File src = safe(p);
                        if (src.getParentFile().equals(dest)) continue;
                        if (src.isDirectory() && (dest.equals(src) || dest.getPath().startsWith(src.getPath() + "/")))
                            throw new Exception("폴더를 자기 안으로는 옮길 수 없어요");
                        File t = unique(dest, src.getName());
                        collectFiles(src, toScan, 5000);
                        moveAny(src, t);
                        collectFiles(t, toScan, 10000);
                        JSObject o = new JSObject();
                        o.put("from", src.getPath());
                        o.put("to", t.getPath());
                        moved.put(o);
                    } catch (Exception e) {
                        JSObject o = new JSObject();
                        o.put("path", p);
                        o.put("error", String.valueOf(e.getMessage()));
                        failed.put(o);
                    }
                }
                scan(toScan);
                JSObject res = new JSObject();
                res.put("moved", moved);
                res.put("failed", failed);
                call.resolve(res);
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()));
            }
        });
    }

    @PluginMethod
    public void mkdir(final PluginCall call) {
        pool.execute(() -> {
            try {
                File parent = safe(call.getString("parent"));
                String name = cleanName(call.getString("name"));
                File t = new File(parent, name);
                if (t.exists()) throw new Exception("같은 이름이 이미 있어요");
                if (!t.mkdirs()) throw new Exception("폴더를 만들지 못했어요");
                JSObject r = new JSObject();
                r.put("path", t.getPath());
                call.resolve(r);
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()));
            }
        });
    }

    @PluginMethod
    public void rename(final PluginCall call) {
        pool.execute(() -> {
            try {
                File src = safe(call.getString("path"));
                String name = cleanName(call.getString("name"));
                File t = new File(src.getParentFile(), name);
                if (t.exists()) throw new Exception("같은 이름이 이미 있어요");
                List<String> sc = new ArrayList<>();
                collectFiles(src, sc, 5000);
                if (!src.renameTo(t)) throw new Exception("이름을 바꾸지 못했어요");
                collectFiles(t, sc, 10000);
                scan(sc);
                JSObject r = new JSObject();
                r.put("path", t.getPath());
                call.resolve(r);
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()));
            }
        });
    }

    private static String cleanName(String n) throws Exception {
        if (n == null) throw new Exception("이름을 적어 주세요");
        n = n.trim();
        if (n.isEmpty() || n.equals(".") || n.equals("..") || n.contains("/")) throw new Exception("쓸 수 없는 이름이에요");
        return n;
    }

    /* ---------- 휴지통 ---------- */
    private JSONArray readIndex() {
        try {
            File ix = new File(trashDir, "index.json");
            if (ix.exists()) return new JSONArray(new String(readAll(ix), "UTF-8"));
        } catch (Exception ignore) {}
        return new JSONArray();
    }

    private void writeIndex(JSONArray a) throws Exception {
        trashDir.mkdirs();
        File nm = new File(trashDir, ".nomedia");
        if (!nm.exists()) nm.createNewFile();
        try (OutputStream out = new FileOutputStream(new File(trashDir, "index.json"))) {
            out.write(a.toString().getBytes("UTF-8"));
        }
    }

    @PluginMethod
    public void trash(final PluginCall call) {
        pool.execute(() -> {
            try {
                JSArray done = new JSArray(), failed = new JSArray();
                List<String> toScan = new ArrayList<>();
                synchronized (trashLock) {
                    JSONArray idx = readIndex();
                    int i = 0;
                    for (String p : strings(call.getArray("paths"))) {
                        try {
                            File src = safe(p);
                            if (src.getPath().startsWith(trashDir.getPath())) throw new Exception("이미 휴지통이에요");
                            String id = System.currentTimeMillis() + "_" + (i++);
                            File slot = new File(trashDir, id);
                            slot.mkdirs();
                            File t = new File(slot, src.getName());
                            boolean dir = src.isDirectory();
                            long size = sizeOf(src);
                            collectFiles(src, toScan, 5000);
                            moveAny(src, t);
                            JSONObject e = new JSONObject();
                            e.put("id", id);
                            e.put("name", src.getName());
                            e.put("orig", src.getPath());
                            e.put("at", System.currentTimeMillis());
                            e.put("dir", dir);
                            e.put("size", size);
                            idx.put(e);
                            done.put(id);
                        } catch (Exception e) {
                            JSObject o = new JSObject();
                            o.put("path", p);
                            o.put("error", String.valueOf(e.getMessage()));
                            failed.put(o);
                        }
                    }
                    writeIndex(idx);
                }
                scan(toScan);
                JSObject res = new JSObject();
                res.put("ids", done);
                res.put("failed", failed);
                call.resolve(res);
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()));
            }
        });
    }

    @PluginMethod
    public void listTrash(final PluginCall call) {
        pool.execute(() -> {
            try {
                JSArray out = new JSArray();
                synchronized (trashLock) {
                    JSONArray idx = readIndex(), keep = new JSONArray();
                    long now = System.currentTimeMillis();
                    boolean changed = false;
                    for (int i = 0; i < idx.length(); i++) {
                        JSONObject e = idx.getJSONObject(i);
                        File slot = new File(trashDir, e.getString("id"));
                        if (!slot.exists()) { changed = true; continue; }
                        if (now - e.getLong("at") > TRASH_KEEP_MS) { deleteAny(slot); changed = true; continue; }
                        keep.put(e);
                        File f = new File(slot, e.getString("name"));
                        JSObject o = new JSObject();
                        o.put("id", e.getString("id"));
                        o.put("name", e.getString("name"));
                        o.put("orig", e.getString("orig"));
                        o.put("at", e.getLong("at"));
                        o.put("dir", e.getBoolean("dir"));
                        o.put("size", e.getLong("size"));
                        o.put("path", f.getPath());
                        o.put("video", VID.contains(ext(e.getString("name"))));
                        out.put(o);
                    }
                    if (changed) writeIndex(keep);
                }
                JSObject res = new JSObject();
                res.put("items", out);
                res.put("keepDays", 30);
                call.resolve(res);
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()));
            }
        });
    }

    @PluginMethod
    public void restore(final PluginCall call) {
        pool.execute(() -> {
            try {
                Set<String> ids = new HashSet<>(strings(call.getArray("ids")));
                JSArray back = new JSArray(), failed = new JSArray();
                List<String> toScan = new ArrayList<>();
                synchronized (trashLock) {
                    JSONArray idx = readIndex(), keep = new JSONArray();
                    for (int i = 0; i < idx.length(); i++) {
                        JSONObject e = idx.getJSONObject(i);
                        if (!ids.contains(e.getString("id"))) { keep.put(e); continue; }
                        try {
                            File slot = new File(trashDir, e.getString("id"));
                            File f = new File(slot, e.getString("name"));
                            File origDir = new File(e.getString("orig")).getParentFile();
                            if (!origDir.isDirectory()) origDir.mkdirs();
                            File t = unique(origDir, e.getString("name"));
                            moveAny(f, t);
                            deleteAny(slot);
                            collectFiles(t, toScan, 10000);
                            JSObject o = new JSObject();
                            o.put("id", e.getString("id"));
                            o.put("to", t.getPath());
                            back.put(o);
                        } catch (Exception ex) {
                            keep.put(e);
                            JSObject o = new JSObject();
                            o.put("id", e.getString("id"));
                            o.put("error", String.valueOf(ex.getMessage()));
                            failed.put(o);
                        }
                    }
                    writeIndex(keep);
                }
                scan(toScan);
                JSObject res = new JSObject();
                res.put("restored", back);
                res.put("failed", failed);
                call.resolve(res);
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()));
            }
        });
    }

    /** ids 를 주면 그것만, 안 주면 휴지통 전체를 영구 삭제 */
    @PluginMethod
    public void purge(final PluginCall call) {
        pool.execute(() -> {
            try {
                JSArray a = call.getArray("ids");
                Set<String> ids = a == null ? null : new HashSet<>(strings(a));
                int n = 0;
                synchronized (trashLock) {
                    JSONArray idx = readIndex(), keep = new JSONArray();
                    for (int i = 0; i < idx.length(); i++) {
                        JSONObject e = idx.getJSONObject(i);
                        if (ids == null || ids.contains(e.getString("id"))) {
                            deleteAny(new File(trashDir, e.getString("id")));
                            n++;
                        } else keep.put(e);
                    }
                    writeIndex(keep);
                }
                JSObject res = new JSObject();
                res.put("count", n);
                call.resolve(res);
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()));
            }
        });
    }
}
