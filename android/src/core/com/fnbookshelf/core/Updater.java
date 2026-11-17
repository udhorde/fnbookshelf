package com.fnbookshelf.core;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;

/**
 * 客户端自动更新：
 * 管理员在管理后台上传 APK 后，APP 启动时向 /api/app/info 取当前类型的版本号，
 * 比自己新就提示下载，下载完直接调起系统安装界面。
 *
 * 服务端的 code 用 versionName 换算（1.9.0 → 10900），与 build.sh 里的 versionCode 一致。
 */
public class Updater {

    public interface Cb {
        void done(String msg);
    }

    private final Activity act;
    private final String base;
    private final String kind;      // phone / tv
    private final boolean silent;   // 静默检查（启动时）：没有新版就不打扰用户

    public Updater(Activity a, String base, String kind, boolean silent) {
        this.act = a;
        this.base = base;
        this.kind = kind;
        this.silent = silent;
    }

    public int myCode() {
        try {
            PackageInfo pi = act.getPackageManager().getPackageInfo(act.getPackageName(), 0);
            return pi.versionCode;
        } catch (Exception e) {
            return 0;
        }
    }

    public String myName() {
        try {
            PackageInfo pi = act.getPackageManager().getPackageInfo(act.getPackageName(), 0);
            return pi.versionName;
        } catch (Exception e) {
            return "?";
        }
    }

    /** 后台线程调用：返回 {ok, code, name, size} 或 null */
    private JSONObject remote() {
        if (base == null || base.isEmpty()) return null;
        JSONObject all = Net.getJson(base, "/api/app/info");
        if (all == null) return null;
        JSONObject items = all.optJSONObject("items");
        if (items == null) return null;
        return items.optJSONObject(kind);
    }

    /** 启动时静默检查：有新版才弹窗。 */
    public void checkQuiet(final Cb cb) {
        new Thread(new Runnable() {
            public void run() {
                final JSONObject r = remote();
                act.runOnUiThread(new Runnable() {
                    public void run() {
                        if (r == null) {
                            if (!silent) toast("检查失败：连不上服务器");
                            if (cb != null) cb.done("fail");
                            return;
                        }
                        handleRemote(r, cb);
                    }
                });
            }
        }).start();
    }

    private void handleRemote(final JSONObject r, final Cb cb) {
        final int code = r.optInt("code", 0);
        final String ver = r.optString("version", "");
        final int mine = myCode();
        if (code <= mine) {
            if (!silent) {
                new AlertDialog.Builder(act)
                        .setTitle("已是最新版本")
                        .setMessage("当前版本 " + myName() + "，服务器上的版本 " + ver + "。")
                        .setPositiveButton("好", new DialogInterface.OnClickListener() {
                            public void onClick(DialogInterface d, int w) {
                                if (cb != null) cb.done("latest");
                            }
                        })
                        .show();
            } else if (cb != null) cb.done("latest");
            return;
        }
        String size = Downloader.human(r.optLong("size", 0));
        if (silent) {
            // 启动时检测到新版：直接下载并调起安装（用户要求「检测到有新版自动下载发起安装」），
            // 系统安装界面本身还要用户确认一次，不会悄悄装上。
            toast("发现新版本 " + ver + "，正在下载…");
            downloadAndInstall(cb);
            return;
        }
        new AlertDialog.Builder(act)
                .setTitle("发现新版本 " + ver)
                .setMessage("当前 " + myName() + "，新版本 " + ver + "（" + size + "）。\n下载完成后会直接打开安装界面。")
                .setPositiveButton("立即更新", new DialogInterface.OnClickListener() {
                    public void onClick(DialogInterface d, int w) {
                        downloadAndInstall(cb);
                    }
                })
                .setNegativeButton("以后再说", new DialogInterface.OnClickListener() {
                    public void onClick(DialogInterface d, int w) {
                        if (cb != null) cb.done("skip");
                    }
                })
                .show();
    }

    private void downloadAndInstall(final Cb cb) {
        final String url = Net.normalize(base) + "/api/app/download/" + kind;
        final File dir = new File(act.getCacheDir(), "update");
        if (!dir.exists()) dir.mkdirs();
        final File out = new File(dir, "fnbookshelf-" + kind + ".apk");
        toast("开始下载新版本…");
        new Thread(new Runnable() {
            public void run() {
                String err = null;
                FileOutputStream fo = null;
                try {
                    if (out.exists()) out.delete();
                    fo = new FileOutputStream(out);
                    Net.fetchToStream(url, fo, 200L * 1024 * 1024, null);
                    fo.flush();
                } catch (Exception e) {
                    err = Net.friendly(e);
                } finally {
                    try {
                        if (fo != null) fo.close();
                    } catch (Exception ignore) {
                    }
                }
                final String e2 = err;
                final boolean okFile = err == null && out.exists() && out.length() > 8192;
                act.runOnUiThread(new Runnable() {
                    public void run() {
                        if (!okFile) {
                            toast("下载失败：" + (e2 == null ? "文件不完整" : e2));
                            if (cb != null) cb.done("fail");
                            return;
                        }
                        install(out);
                        if (cb != null) cb.done("downloaded");
                    }
                });
            }
        }).start();
    }

    /** 调起系统安装界面（8.0 起需要「安装未知应用」权限，没给就跳设置页）。 */
    public void install(File apk) {
        try {
            if (Build.VERSION.SDK_INT >= 26 && !act.getPackageManager().canRequestPackageInstalls()) {
                new AlertDialog.Builder(act)
                        .setTitle("需要安装权限")
                        .setMessage("请在接下来的页面里允许「" + act.getString(act.getApplicationInfo().labelRes) + "」安装应用，然后返回重试。")
                        .setPositiveButton("去设置", new DialogInterface.OnClickListener() {
                            public void onClick(DialogInterface d, int w) {
                                try {
                                    Intent i = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                                            Uri.parse("package:" + act.getPackageName()));
                                    act.startActivity(i);
                                } catch (Exception e) {
                                    toast("请到「设置 → 应用 → 安装未知应用」里允许本应用");
                                }
                            }
                        })
                        .setNegativeButton("取消", null)
                        .show();
                return;
            }
            Uri uri = FnbFiles.uriFor(act, apk);
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(uri, "application/vnd.android.package-archive");
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            act.startActivity(i);
        } catch (Exception e) {
            toast("无法启动安装：" + e.getMessage());
        }
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
}
