package com.fnbookshelf.core;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;

/**
 * 极简文件 ContentProvider（不引 AndroidX，所以不用 FileProvider）。
 *
 * 用途只有一个：把应用自己目录里的文件（升级用的 APK、旧系统上保存的书）
 * 变成一个 content:// 地址交给系统安装器 / 阅读器打开。
 * Android 7 起 file:// 会抛 FileUriExposedException，必须走这一层。
 */
public class FnbFiles extends ContentProvider {

    public static String authority(Context c) {
        return c.getPackageName() + ".files";
    }

    /** 把 File 变成 content:// 地址（必须在 <files-path>/<cache-path> 允许的目录内） */
    public static Uri uriFor(Context c, File f) {
        String base = c.getCacheDir().getAbsolutePath();
        String p = f.getAbsolutePath();
        if (p.startsWith(base + File.separator)) {
            return new Uri.Builder().scheme("content").authority(authority(c))
                    .appendPath("cache").appendPath(p.substring(base.length() + 1)).build();
        }
        String ext = c.getExternalFilesDir(null) == null ? "" : c.getExternalFilesDir(null).getAbsolutePath();
        if (!ext.isEmpty() && p.startsWith(ext + File.separator)) {
            return new Uri.Builder().scheme("content").authority(authority(c))
                    .appendPath("ext").appendPath(p.substring(ext.length() + 1)).build();
        }
        // 其它位置（一般不会走到）：退化成应用私有目录根
        return new Uri.Builder().scheme("content").authority(authority(c))
                .appendPath("cache").appendPath(f.getName()).build();
    }

    private File resolve(Uri uri) {
        java.util.List<String> seg = uri.getPathSegments();
        if (seg.isEmpty()) return null;
        String kind = seg.get(0);
        StringBuilder sb = new StringBuilder();
        for (int i = 1; i < seg.size(); i++) {
            if (sb.length() > 0) sb.append('/');
            sb.append(seg.get(i));
        }
        String rel = sb.toString();
        if (rel.contains("..")) return null;
        File root = "ext".equals(kind) ? getContext().getExternalFilesDir(null) : getContext().getCacheDir();
        if (root == null) return null;
        return new File(root, rel);
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        File f = resolve(uri);
        if (f == null || !f.exists()) throw new FileNotFoundException(String.valueOf(uri));
        return ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] args, String sort) {
        File f = resolve(uri);
        if (f == null) return null;
        String[] cols = projection != null ? projection : new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE};
        MatrixCursor c = new MatrixCursor(cols, 1);
        Object[] row = new Object[cols.length];
        for (int i = 0; i < cols.length; i++) {
            if (OpenableColumns.DISPLAY_NAME.equals(cols[i])) row[i] = f.getName();
            else if (OpenableColumns.SIZE.equals(cols[i])) row[i] = f.length();
            else row[i] = null;
        }
        c.addRow(row);
        return c;
    }

    @Override
    public String getType(Uri uri) {
        File f = resolve(uri);
        if (f == null) return "application/octet-stream";
        String n = f.getName().toLowerCase();
        return n.endsWith(".apk") ? "application/vnd.android.package-archive" : Downloader.mimeOf(n);
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        return null;
    }

    @Override
    public int delete(Uri uri, String selection, String[] args) {
        return 0;
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] args) {
        return 0;
    }
}
