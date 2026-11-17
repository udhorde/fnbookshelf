package com.fnbookshelf.core;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ContentUris;
import android.content.DialogInterface;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.widget.Toast;

import java.io.File;
import java.util.ArrayList;
import java.util.List;

/**
 * 下载管理：列出应用保存到「下载 / 飞牛书屋」里的书，能打开、分享、删除。
 *
 * Android 10 起下载走 MediaStore（应用自己写入的文件自己有权限读），
 * 更早的系统走应用私有下载目录，这里两条路都覆盖。
 */
public class Downloads {

    public static class Item {
        public String name;
        public long size;
        public long added;
        public Uri uri;       // MediaStore 记录
        public File file;     // 旧系统
        public String mime;
    }

    private final Activity act;

    public Downloads(Activity a) {
        this.act = a;
    }

    public List<Item> list() {
        List<Item> out = new ArrayList<Item>();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            Cursor c = null;
            try {
                Uri base = MediaStore.Downloads.EXTERNAL_CONTENT_URI;
                String[] proj = new String[]{
                        MediaStore.MediaColumns._ID, MediaStore.MediaColumns.DISPLAY_NAME,
                        MediaStore.MediaColumns.SIZE, MediaStore.MediaColumns.DATE_ADDED,
                        MediaStore.MediaColumns.MIME_TYPE
                };
                c = act.getContentResolver().query(base, proj,
                        MediaStore.MediaColumns.RELATIVE_PATH + " LIKE ?",
                        new String[]{"Download/飞牛书屋%"}, MediaStore.MediaColumns.DATE_ADDED + " DESC");
                while (c != null && c.moveToNext()) {
                    Item it = new Item();
                    it.uri = ContentUris.withAppendedId(base, c.getLong(0));
                    it.name = c.getString(1);
                    it.size = c.getLong(2);
                    it.added = c.getLong(3) * 1000L;
                    it.mime = c.getString(4);
                    out.add(it);
                }
            } catch (Exception ignore) {
            } finally {
                try {
                    if (c != null) c.close();
                } catch (Exception ignore) {
                }
            }
        } else {
            File dir = act.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
            File[] fs = dir == null ? null : dir.listFiles();
            if (fs != null) {
                for (File f : fs) {
                    if (!f.isFile()) continue;
                    Item it = new Item();
                    it.file = f;
                    it.name = f.getName();
                    it.size = f.length();
                    it.added = f.lastModified();
                    it.mime = Downloader.mimeOf(it.name);
                    out.add(it);
                }
            }
        }
        return out;
    }

    /** 弹出下载列表。 */
    public void show() {
        final List<Item> items = list();
        if (items.isEmpty()) {
            new AlertDialog.Builder(act)
                    .setTitle("下载管理")
                    .setMessage("还没有下载过文件。\n\n在书库里点书籍的「⬇ 下载」，文件会保存到「下载 / 飞牛书屋」。")
                    .setPositiveButton("好", null)
                    .show();
            return;
        }
        final String[] labels = new String[items.size()];
        for (int i = 0; i < items.size(); i++) {
            Item it = items.get(i);
            labels[i] = it.name + "\n" + Downloader.human(it.size);
        }
        new AlertDialog.Builder(act)
                .setTitle("下载管理（" + items.size() + "）")
                .setItems(labels, new DialogInterface.OnClickListener() {
                    public void onClick(DialogInterface d, int which) {
                        actions(items.get(which));
                    }
                })
                .setPositiveButton("关闭", null)
                .show();
    }

    private void actions(final Item it) {
        final String[] ops = new String[]{"打开", "分享", "删除"};
        new AlertDialog.Builder(act)
                .setTitle(it.name)
                .setItems(ops, new DialogInterface.OnClickListener() {
                    public void onClick(DialogInterface d, int w) {
                        if (w == 0) open(it);
                        else if (w == 1) share(it);
                        else del(it);
                    }
                })
                .show();
    }

    private Uri uriOf(Item it) {
        return it.uri != null ? it.uri : FnbFiles.uriFor(act, it.file);
    }

    public void open(Item it) {
        try {
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(uriOf(it), it.mime == null ? Downloader.mimeOf(it.name) : it.mime);
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            act.startActivity(i);
        } catch (Exception e) {
            Toast.makeText(act, "没有能打开这个格式的应用", Toast.LENGTH_LONG).show();
        }
    }

    private void share(Item it) {
        try {
            Intent i = new Intent(Intent.ACTION_SEND);
            i.setType(it.mime == null ? "application/octet-stream" : it.mime);
            i.putExtra(Intent.EXTRA_STREAM, uriOf(it));
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            act.startActivity(Intent.createChooser(i, "分享 " + it.name));
        } catch (Exception e) {
            Toast.makeText(act, "分享失败：" + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    private void del(final Item it) {
        new AlertDialog.Builder(act)
                .setTitle("删除文件")
                .setMessage("从本机删除「" + it.name + "」？书库里的源文件不受影响。")
                .setPositiveButton("删除", new DialogInterface.OnClickListener() {
                    public void onClick(DialogInterface d, int w) {
                        boolean ok = false;
                        try {
                            if (it.uri != null) ok = act.getContentResolver().delete(it.uri, null, null) > 0;
                            else if (it.file != null) ok = it.file.delete();
                        } catch (Exception ignore) {
                        }
                        Toast.makeText(act, ok ? "已删除" : "删除失败", Toast.LENGTH_SHORT).show();
                    }
                })
                .setNegativeButton("取消", null)
                .show();
    }
}
