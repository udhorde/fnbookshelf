package com.fnbookshelf.core;

import android.app.Activity;
import android.content.ContentValues;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.widget.Toast;

import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

/**
 * 书籍保存到本机「下载」目录。
 * 网页里 saveFile() 走的是 fetch → Blob → &lt;a download&gt;，WebView 对 blob 下载不做事，
 * 所以由前端把 Blob 分片成 base64 交给这里落盘。
 */
public class Downloader {
    public static final long MAX_BYTES = 512L * 1024 * 1024;

    private final Activity act;
    private OutputStream out;
    private Uri uri;
    private File file;
    private String name;
    private long expect = -1;
    private long got = 0;
    private boolean active;

    public Downloader(Activity a) {
        this.act = a;
    }

    public boolean isActive() {
        return active;
    }

    public String currentName() {
        return name;
    }

    private static String safeName(String n) {
        String s = n == null ? "" : n.trim();
        if (s.isEmpty()) s = "book.bin";
        s = s.replace('\\', '_').replace('/', '_').replace(':', '_')
                .replace('*', '_').replace('?', '_').replace('"', '_')
                .replace('<', '_').replace('>', '_').replace('|', '_');
        if (s.length() > 120) {
            String ext = "";
            int dot = s.lastIndexOf('.');
            if (dot > 0 && s.length() - dot <= 8) ext = s.substring(dot);
            s = s.substring(0, 110) + ext;
        }
        return s;
    }

    /** 开始接收：成功返回空串，失败返回原因。 */
    public synchronized String begin(String fileName, String mime, long size) {
        closeQuietly(false);
        this.name = safeName(fileName);
        this.expect = size;
        this.got = 0;
        if (size > MAX_BYTES) return "文件太大（超过 512 MB），请在电脑上下载";
        try {
            String m = (mime == null || mime.trim().isEmpty()) ? mimeOf(this.name) : mime;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues cv = new ContentValues();
                cv.put(MediaStore.MediaColumns.DISPLAY_NAME, this.name);
                cv.put(MediaStore.MediaColumns.MIME_TYPE, m);
                cv.put(MediaStore.MediaColumns.RELATIVE_PATH,
                        Environment.DIRECTORY_DOWNLOADS + "/飞牛书屋");
                cv.put(MediaStore.MediaColumns.IS_PENDING, 1);
                uri = act.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                if (uri == null) return "无法在「下载」目录里创建文件";
                out = act.getContentResolver().openOutputStream(uri);
            } else {
                File dir = act.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                if (dir == null) dir = act.getFilesDir();
                if (!dir.exists() && !dir.mkdirs()) return "无法创建下载目录";
                file = new File(dir, this.name);
                out = new BufferedOutputStream(new FileOutputStream(file), 65536);
            }
            active = out != null;
            return active ? "" : "无法写入文件";
        } catch (Exception e) {
            reset(true);
            return e.getClass().getSimpleName() + ": " + e.getMessage();
        }
    }

    /** 追加一段 base64。返回 false 表示已失败，前端应停止发送。 */
    public synchronized boolean write(String b64) {
        if (!active || out == null) return false;
        try {
            byte[] buf = Base64.decode(b64, Base64.DEFAULT);
            out.write(buf);
            got += buf.length;
            return true;
        } catch (Exception e) {
            reset(true);
            return false;
        }
    }

    /** 收尾：返回保存位置描述。 */
    public synchronized String finish() {
        if (!active) return "";
        try {
            out.flush();
            out.close();
        } catch (Exception ignore) {
        }
        String where;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentValues cv = new ContentValues();
            cv.put(MediaStore.MediaColumns.IS_PENDING, 0);
            try {
                act.getContentResolver().update(uri, cv, null, null);
            } catch (Exception ignore) {
            }
            where = "已保存到「下载 / 飞牛书屋」";
        } else {
            where = "已保存到 " + (file == null ? "应用目录" : file.getAbsolutePath());
        }
        String msg = where + "（" + human(got) + "）";
        active = false;
        out = null;
        toast(msg);
        return msg;
    }

    public synchronized void abort() {
        closeQuietly(true);
        toast("下载已取消");
    }

    private void closeQuietly(boolean delete) {
        if (out != null) {
            try {
                out.close();
            } catch (Exception ignore) {
            }
        }
        out = null;
        if (delete) {
            try {
                if (uri != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    act.getContentResolver().delete(uri, null, null);
                } else if (file != null && file.exists()) {
                    file.delete();
                }
            } catch (Exception ignore) {
            }
        }
        uri = null;
        file = null;
        active = false;
    }

    private void reset(boolean delete) {
        closeQuietly(delete);
        expect = -1;
        got = 0;
    }

    public synchronized long received() {
        return got;
    }

    public synchronized long expected() {
        return expect;
    }

    /** DownloadListener 兜底：直接把 URL 拉下来存盘（需要 Cookie 的情况由前端补 toke 参数）。 */
    public void downloadUrl(final String url, final String fileName, final String mime) {
        final String cookie = cookieFor(url);
        new Thread(new Runnable() {
            public void run() {
                String err;
                synchronized (Downloader.this) {
                    err = begin(fileName, mime, -1);
                }
                if (!err.isEmpty()) {
                    toastLater("下载失败：" + err);
                    return;
                }
                try {
                    Net.fetchToStream(url, new OutputStream() {
                        public void write(int b) throws java.io.IOException {
                            throw new java.io.IOException("不支持单字节写入");
                        }

                        public void write(byte[] b, int off, int len) throws java.io.IOException {
                            synchronized (Downloader.this) {
                                if (!active || out == null) throw new java.io.IOException("已取消");
                                out.write(b, off, len);
                                got += len;
                            }
                        }
                    }, MAX_BYTES, cookie);
                    synchronized (Downloader.this) {
                        finish();
                    }
                } catch (Exception e) {
                    synchronized (Downloader.this) {
                        abort();
                    }
                    toastLater("下载失败：" + Net.friendly(e));
                }
            }
        }).start();
    }

    private static String cookieFor(String url) {
        try {
            return android.webkit.CookieManager.getInstance().getCookie(url);
        } catch (Exception e) {
            return null;
        }
    }

    public static String mimeOf(String name) {
        String n = name == null ? "" : name.toLowerCase();
        if (n.endsWith(".epub")) return "application/epub+zip";
        if (n.endsWith(".pdf")) return "application/pdf";
        if (n.endsWith(".txt")) return "text/plain";
        if (n.endsWith(".mobi") || n.endsWith(".azw3") || n.endsWith(".azw")) return "application/x-mobipocket-ebook";
        if (n.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        if (n.endsWith(".doc")) return "application/msword";
        if (n.endsWith(".pptx")) return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
        if (n.endsWith(".ppt")) return "application/vnd.ms-powerpoint";
        if (n.endsWith(".xlsx")) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
        if (n.endsWith(".zip")) return "application/zip";
        if (n.endsWith(".mp3")) return "audio/mpeg";
        if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
        if (n.endsWith(".png")) return "image/png";
        return "application/octet-stream";
    }

    public static String human(long bytes) {
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1024 * 1024) return String.format(java.util.Locale.US, "%.0f KB", bytes / 1024.0);
        return String.format(java.util.Locale.US, "%.1f MB", bytes / 1048576.0);
    }

    private void toast(final String s) {
        act.runOnUiThread(new Runnable() {
            public void run() {
                try {
                    Toast.makeText(act, s, Toast.LENGTH_LONG).show();
                } catch (Exception ignore) {
                }
            }
        });
    }

    private void toastLater(final String s) {
        act.runOnUiThread(new Runnable() {
            public void run() {
                toast(s);
            }
        });
    }
}
