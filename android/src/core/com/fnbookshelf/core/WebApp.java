package com.fnbookshelf.core;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.util.Log;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * 飞牛书屋客户端的公共外壳：一个 WebView + 首次配置页 + 出错重试页。
 * 手机/平板与 TV 的差异只在子类里（注入脚本、返回键行为、全屏方式）。
 */
public abstract class WebApp extends Activity {
    protected static final String TAG = "FnBookshelf";
    protected static final String LOCAL_BASE = "https://fnb.local/";
    protected static final String BRIDGE = "FNB";

    protected WebView web;
    protected ProgressBar bar;
    protected Prefs prefs;
    protected Downloader dl;

    private boolean localPage = true;
    private boolean clearHistoryAfterLoad = false;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final Map<String, String> scriptCache = new HashMap<String, String>();

    /** 子类标识，例如 phone / tv。 */
    protected abstract String variantName();

    /** 每次页面开始加载要注入的脚本资源名（按顺序）。 */
    protected abstract String[] variantScripts();

    /** TV 端返回 true：全屏沉浸、返回键弹确认框。 */
    protected boolean tvMode() {
        return false;
    }

    /** 网页文字缩放百分比，电视端调大一点更好认。 */
    protected int textZoomPct() {
        return 100;
    }

    /** 给人看的版本名（variantName 只放 ASCII，用于 UA 与日志）。 */
    protected String variantLabel() {
        return tvMode() ? "TV 版" : "手机 / 平板版";
    }

    // ---------------------------------------------------------------- 生命周期

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = new Prefs(this);
        dl = new Downloader(this);
        prefs.launches();

        setContentView(buildUi());
        setupWeb();

        if (prefs.server().isEmpty()) {
            showSetup("");
        } else {
            openServer();
        }
        if (prefs.keepAwake()) {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        }
        if (tvMode()) hideSystemUi();
        // 1.9.0：启动后静默检查一次新版（没有新版不打扰用户）
        ui.postDelayed(new Runnable() {
            public void run() {
                checkUpdate(true);
            }
        }, 6000);
    }

    /** 检查客户端更新：silent=true 时只有发现新版才弹窗。 */
    protected void checkUpdate(boolean silent) {
        if (prefs.server().isEmpty()) {
            if (!silent) toast("还没有设置服务器地址");
            return;
        }
        new Updater(this, prefs.server(), tvMode() ? "tv" : "phone", silent).checkQuiet(null);
    }

    private View buildUi() {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#f5f6f8"));

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#f5f6f8"));
        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        bar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        bar.setMax(100);
        bar.setProgress(0);
        bar.setVisibility(View.GONE);
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(3));
        lp.topMargin = 0;
        root.addView(bar, lp);
        return root;
    }

    private int dp(int v) {
        return Math.round(getResources().getDisplayMetrics().density * v);
    }

    private void setupWeb() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setSupportMultipleWindows(false);
        s.setLoadWithOverviewMode(false);
        s.setUseWideViewPort(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setTextZoom(textZoomPct());
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        if (Build.VERSION.SDK_INT >= 21) {
            s.setMediaPlaybackRequiresUserGesture(false);
        }
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        String ua = s.getUserAgentString();
        s.setUserAgentString(ua + " FnBookshelf/" + appVersion() + " (" + variantName() + ")");

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        if (Build.VERSION.SDK_INT >= 21) {
            cm.setAcceptThirdPartyCookies(web, true);
        }

        web.addJavascriptInterface(new Bridge(), BRIDGE);
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());
        web.setDownloadListener(new DownloadListener() {
            public void onDownloadStart(String url, String ua, String cd, String mime, long len) {
                String name = nameFromDisposition(cd);
                if (name.isEmpty()) name = nameFromUrl(url);
                if (url.startsWith("blob:") || url.startsWith("data:")) {
                    // blob: 走前端分片交给原生，这里不处理
                    return;
                }
                dl.downloadUrl(url, name, mime);
            }
        });
        web.setFocusable(true);
        // TV 上不能设 touchMode：那会让 WebView 只有在触摸后才能获焦，遥控器直接失灵
        web.setFocusableInTouchMode(!tvMode());
        web.requestFocus();
    }

    /** 网页里点「下载」时，前端把 Blob 分片成 base64 通过这里落盘。 */
    public class Bridge {

        @JavascriptInterface
        public String info() {
            JSONObject o = new JSONObject();
            try {
                o.put("variant", variantName());
                o.put("server", prefs.server());
                o.put("lastServer", prefs.lastServer());
                o.put("version", appVersion());
                o.put("firstRun", prefs.server().isEmpty());
                o.put("tv", tvMode());
            } catch (Exception ignore) {
            }
            return o.toString();
        }

        @JavascriptInterface
        public void test(final String url, final String cb) {
            new Thread(new Runnable() {
                public void run() {
                    final JSONObject r = Net.probe(url);
                    ui.post(new Runnable() {
                        public void run() {
                            callback(cb, r);
                        }
                    });
                }
            }).start();
        }

        /** 测试通过才保存；失败时回 ok:false，由页面决定是否强制保存。 */
        @JavascriptInterface
        public void save(final String url, final String cb) {
            new Thread(new Runnable() {
                public void run() {
                    final JSONObject r = Net.probe(url);
                    final String norm = Net.normalize(url);
                    ui.post(new Runnable() {
                        public void run() {
                            boolean ok = r.optBoolean("ok");
                            if (ok) {
                                prefs.setServer(norm);
                                prefs.setLastServer(norm);
                            }
                            callback(cb, r);
                            if (ok) openServer();
                        }
                    });
                }
            }).start();
        }

        /** 跳过检测直接保存（企业内网/临时不可达时用）。 */
        @JavascriptInterface
        public void saveForce(final String url, final String cb) {
            final String norm = Net.normalize(url);
            ui.post(new Runnable() {
                public void run() {
                    if (!Net.looksValid(norm)) {
                        JSONObject o = new JSONObject();
                        try {
                            o.put("ok", false);
                            o.put("msg", "地址格式不对");
                        } catch (Exception ignore) {
                        }
                        callback(cb, o);
                        return;
                    }
                    prefs.setServer(norm);
                    prefs.setLastServer(norm);
                    JSONObject o = new JSONObject();
                    try {
                        o.put("ok", true);
                        o.put("msg", "已保存");
                    } catch (Exception ignore) {
                    }
                    callback(cb, o);
                    openServer();
                }
            });
        }

        @JavascriptInterface
        public void reload() {
            ui.post(new Runnable() {
                public void run() {
                    if (prefs.server().isEmpty()) showSetup("");
                    else if (localPage) openServer();
                    else web.reload();
                }
            });
        }

        @JavascriptInterface
        public void openSettings() {
            ui.post(new Runnable() {
                public void run() {
                    showSettings();
                }
            });
        }

        @JavascriptInterface
        public void toast(final String msg) {
            ui.post(new Runnable() {
                public void run() {
                    Toast.makeText(WebApp.this, msg == null ? "" : msg, Toast.LENGTH_SHORT).show();
                }
            });
        }

        /** TV 遥控器没输入法，弹原生对话框代替网页里的键盘。 */
        @JavascriptInterface
        public void prompt(final String hint, final String value, final String cb) {
            ui.post(new Runnable() {
                public void run() {
                    showPrompt(hint, value, cb);
                }
            });
        }

        @JavascriptInterface
        public void exitApp() {
            ui.post(new Runnable() {
                public void run() {
                    finish();
                }
            });
        }

        // ---- 下载：Blob 分片 ----

        @JavascriptInterface
        public String dlBegin(String name, String mime, long size) {
            return dl.begin(name, mime, size);
        }

        @JavascriptInterface
        public boolean dlChunk(String b64) {
            return dl.write(b64);
        }

        @JavascriptInterface
        public String dlEnd() {
            return dl.finish();
        }

        @JavascriptInterface
        public void dlAbort() {
            dl.abort();
        }

        @JavascriptInterface
        public void downloadUrl(String url, String name) {
            if (name == null || name.isEmpty()) name = nameFromUrl(url);
            dl.downloadUrl(url, name, Downloader.mimeOf(name));
        }
    }

    // ---------------------------------------------------------------- WebView 回调

    private class Client extends WebViewClient {
        @Override
        public void onPageStarted(WebView v, String url, Bitmap favicon) {
            if (bar != null) {
                bar.setVisibility(View.VISIBLE);
                bar.setProgress(0);
            }
            injectScripts(false);
        }

        @Override
        public void onPageFinished(WebView v, String url) {
            if (bar != null) {
                bar.setProgress(100);
                bar.setVisibility(View.GONE);
            }
            injectScripts(true);
            if (clearHistoryAfterLoad) {
                clearHistoryAfterLoad = false;
                try {
                    v.clearHistory();
                } catch (Exception ignore) {
                }
            }
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
            return handleUrl(req.getUrl() == null ? "" : req.getUrl().toString());
        }

        @SuppressWarnings("deprecation")
        @Override
        public boolean shouldOverrideUrlLoading(WebView v, String url) {
            return handleUrl(url);
        }

        @Override
        public void onReceivedSslError(WebView v, SslErrorHandler handler, SslError err) {
            // 只对「用户自己填的那台服务器」放行自签名证书，别的一律拒绝
            String errUrl = err == null ? "" : String.valueOf(err.getUrl());
            String host = hostOf(errUrl);
            String own = hostOf(prefs.server());
            if (own != null && host != null && own.equalsIgnoreCase(host)) {
                Log.w(TAG, "自签名证书放行：" + host);
                handler.proceed();
            } else {
                Log.w(TAG, "拒绝未知主机的证书：" + host);
                handler.cancel();
            }
        }

        @Override
        public void onReceivedError(WebView v, WebResourceRequest req, WebResourceError e) {
            if (Build.VERSION.SDK_INT >= 23 && req != null && req.isForMainFrame()) {
                showError(String.valueOf(req.getUrl()), e == null ? "" : String.valueOf(e.getDescription()),
                        e == null ? 0 : e.getErrorCode());
            }
        }

        @SuppressWarnings("deprecation")
        @Override
        public void onReceivedError(WebView v, int errorCode, String description, String failingUrl) {
            if (Build.VERSION.SDK_INT < 23) {
                showError(failingUrl, description, errorCode);
            }
        }
    }

    private class Chrome extends WebChromeClient {
        @Override
        public void onProgressChanged(WebView v, int p) {
            if (bar == null) return;
            if (p >= 100) {
                bar.setVisibility(View.GONE);
            } else {
                bar.setVisibility(View.VISIBLE);
                bar.setProgress(p);
            }
        }

        @Override
        public boolean onJsAlert(WebView v, String url, String message, final android.webkit.JsResult result) {
            new AlertDialog.Builder(WebApp.this)
                    .setTitle("提示")
                    .setMessage(message)
                    .setPositiveButton("好", new DialogInterface.OnClickListener() {
                        public void onClick(DialogInterface d, int w) {
                            result.confirm();
                        }
                    })
                    .setOnCancelListener(new DialogInterface.OnCancelListener() {
                        public void onCancel(DialogInterface d) {
                            result.confirm();
                        }
                    })
                    .show();
            return true;
        }

        @Override
        public boolean onJsConfirm(WebView v, String url, String message, final android.webkit.JsResult result) {
            new AlertDialog.Builder(WebApp.this)
                    .setTitle("请确认")
                    .setMessage(message)
                    .setPositiveButton("确定", new DialogInterface.OnClickListener() {
                        public void onClick(DialogInterface d, int w) {
                            result.confirm();
                        }
                    })
                    .setNegativeButton("取消", new DialogInterface.OnClickListener() {
                        public void onClick(DialogInterface d, int w) {
                            result.cancel();
                        }
                    })
                    .setOnCancelListener(new DialogInterface.OnCancelListener() {
                        public void onCancel(DialogInterface d) {
                            result.cancel();
                        }
                    })
                    .show();
            return true;
        }
    }

    private boolean handleUrl(String url) {
        if (url == null || url.isEmpty()) return false;
        if (url.startsWith("file:///android_asset/")) return false;
        Uri u = Uri.parse(url);
        String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase();
        if (scheme.equals("http") || scheme.equals("https")) {
            String own = hostOf(prefs.server());
            String host = u.getHost();
            if (own != null && host != null && own.equalsIgnoreCase(host)) {
                // 站内链接（含 hash 路由）继续在 WebView 里走
                localPage = false;
                return false;
            }
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, u));
            } catch (Exception e) {
                toast("没有可打开该链接的应用");
            }
            return true;
        }
        if (scheme.equals("blob") || scheme.equals("data") || scheme.equals("javascript")
                || scheme.equals("about") || scheme.equals("file")) {
            return false;
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, u));
        } catch (Exception ignore) {
        }
        return true;
    }

    // ---------------------------------------------------------------- 内置页面

    protected void showSetup(String reason) {
        localPage = true;
        if (bar != null) bar.setVisibility(View.GONE);
        String html = asset("setup.html")
                .replace("{{url}}", esc(prefs.lastServer().isEmpty() ? prefs.server() : prefs.lastServer()))
                .replace("{{reason}}", esc(reason == null ? "" : reason))
                .replace("{{variant}}", esc(variantLabel()))
                .replace("{{version}}", esc(appVersion()));
        web.loadDataWithBaseURL(LOCAL_BASE, html, "text/html", "UTF-8", null);
    }

    protected void showError(String url, String msg, int code) {
        localPage = true;
        if (bar != null) bar.setVisibility(View.GONE);
        String html = asset("error.html")
                .replace("{{url}}", esc(prefs.server()))
                .replace("{{msg}}", esc(msg == null ? "" : msg))
                .replace("{{code}}", String.valueOf(code));
        web.loadDataWithBaseURL(LOCAL_BASE, html, "text/html", "UTF-8", null);
    }

    protected void openServer() {
        String url = prefs.server();
        if (url.isEmpty()) {
            showSetup("");
            return;
        }
        localPage = false;
        clearHistoryAfterLoad = true;
        web.loadUrl(url + "/");
    }

    private String asset(String name) {
        try {
            InputStream in = getAssets().open(name);
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
            in.close();
            return new String(bo.toByteArray(), "UTF-8");
        } catch (Exception e) {
            return "<html><body style='font-family:sans-serif;padding:24px'>缺少内置资源：" + name + "</body></html>";
        }
    }

    private void injectScripts(boolean done) {
        String[] list = variantScripts();
        if (list == null) return;
        for (String name : list) {
            String code = scriptCache.get(name);
            if (code == null) {
                code = asset(name);
                scriptCache.put(name, code);
            }
            if (code != null && code.length() > 0) {
                web.evaluateJavascript(code, null);
            }
        }
    }

    private void callback(String id, JSONObject o) {
        if (id == null || id.isEmpty()) return;
        String js = "window.__fnbCb&&window.__fnbCb(" + JSONObject.quote(id) + "," + o.toString() + ")";
        try {
            web.evaluateJavascript(js, null);
        } catch (Exception ignore) {
        }
    }

    private void promptResult(String id, boolean ok, String text) {
        if (id == null || id.isEmpty()) return;
        String js = "window.__fnbPrompt&&window.__fnbPrompt(" + JSONObject.quote(id) + ","
                + JSONObject.quote(text == null ? "" : text) + "," + ok + ")";
        try {
            web.evaluateJavascript(js, null);
        } catch (Exception ignore) {
        }
    }

    private void showPrompt(String hint, String value, final String cb) {
        final EditText et = new EditText(this);
        et.setSingleLine(true);
        et.setInputType(InputType.TYPE_CLASS_TEXT);
        et.setText(value == null ? "" : value);
        et.setSelection(et.getText().length());
        new AlertDialog.Builder(this)
                .setTitle(hint == null || hint.isEmpty() ? "请输入" : hint)
                .setView(et)
                .setPositiveButton("确定", new DialogInterface.OnClickListener() {
                    public void onClick(DialogInterface d, int w) {
                        promptResult(cb, true, et.getText().toString());
                    }
                })
                .setNegativeButton("取消", new DialogInterface.OnClickListener() {
                    public void onClick(DialogInterface d, int w) {
                        promptResult(cb, false, "");
                    }
                })
                .setOnCancelListener(new DialogInterface.OnCancelListener() {
                    public void onCancel(DialogInterface d) {
                        promptResult(cb, false, "");
                    }
                })
                .show();
    }

    protected void showSettings() {
        boolean has = !prefs.server().isEmpty();
        String[] items = new String[]{
                "服务器地址" + (has ? "（" + prefs.server() + "）" : "（未设置）"),
                "重新加载页面",
                "清除缓存后重载",
                "保持屏幕常亮：" + (prefs.keepAwake() ? "开" : "关"),
                "下载管理",
                "检查更新（当前 " + new Updater(this, prefs.server(), tvMode() ? "tv" : "phone", true).myName() + "）",
                "关于",
                "环境信息（排障用）",
                "退出"
        };
        new AlertDialog.Builder(this)
                .setTitle("飞牛书屋")
                .setItems(items, new DialogInterface.OnClickListener() {
                    public void onClick(DialogInterface d, int which) {
                        switch (which) {
                            case 0:
                                showServerEdit();
                                break;
                            case 1:
                                if (prefs.server().isEmpty()) showSetup("");
                                else openServer();
                                break;
                            case 2:
                                web.clearCache(true);
                                web.clearHistory();
                                toast("缓存已清除");
                                if (prefs.server().isEmpty()) showSetup("");
                                else openServer();
                                break;
                            case 3:
                                prefs.setKeepAwake(!prefs.keepAwake());
                                if (prefs.keepAwake()) {
                                    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                                } else {
                                    getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                                }
                                break;
                            case 4:
                                new Downloads(WebApp.this).show();
                                break;
                            case 5:
                                checkUpdate(false);
                                break;
                            case 6:
                                showAbout();
                                break;
                            case 7:
                                showDiag();
                                break;
                            case 8:
                                finish();
                                break;
                        }
                    }
                })
                .show();
    }

    private void showServerEdit() {
        final EditText et = new EditText(this);
        et.setSingleLine(true);
        et.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        et.setHint("192.168.1.10:8096");
        et.setText(prefs.server());
        new AlertDialog.Builder(this)
                .setTitle("服务器地址")
                .setMessage("填写 NAS 的地址和端口，只填主机名会自动用 https")
                .setView(et)
                .setPositiveButton("测试并保存", new DialogInterface.OnClickListener() {
                    public void onClick(DialogInterface d, int w) {
                        probeAndSave(et.getText().toString());
                    }
                })
                .setNegativeButton("取消", null)
                .show();
    }

    private void probeAndSave(final String raw) {
        final String norm = Net.normalize(raw);
        if (!Net.looksValid(norm)) {
            toast("地址格式不对");
            return;
        }
        toast("正在连接 " + norm + " …");
        new Thread(new Runnable() {
            public void run() {
                final JSONObject r = Net.probe(norm);
                ui.post(new Runnable() {
                    public void run() {
                        if (r.optBoolean("ok")) {
                            prefs.setServer(norm);
                            prefs.setLastServer(norm);
                            toast("已连接：" + r.optString("siteName"));
                            openServer();
                        } else {
                            new AlertDialog.Builder(WebApp.this)
                                    .setTitle("连不上")
                                    .setMessage(r.optString("msg"))
                                    .setPositiveButton("重新填写", new DialogInterface.OnClickListener() {
                                        public void onClick(DialogInterface d, int w) {
                                            showServerEdit();
                                        }
                                    })
                                    .setNeutralButton("仍然保存", new DialogInterface.OnClickListener() {
                                        public void onClick(DialogInterface d, int w) {
                                            prefs.setServer(norm);
                                            prefs.setLastServer(norm);
                                            openServer();
                                        }
                                    })
                                    .setNegativeButton("取消", null)
                                    .show();
                        }
                    }
                });
            }
        }).start();
    }

    /**
     * 环境信息：电视内置 WebView 版本差异很大，出问题时先看这里。
     * UA 里带的 Chrome/xx 就是 WebView 内核版本。
     */
    private void showDiag() {
        String ua = "";
        try {
            ua = web.getSettings().getUserAgentString();
        } catch (Exception ignore) {
        }
        android.util.DisplayMetrics dm = getResources().getDisplayMetrics();
        StringBuilder sb = new StringBuilder();
        sb.append("客户端：").append(variantLabel()).append(' ').append(appVersion()).append('\n');
        sb.append("系统：Android ").append(android.os.Build.VERSION.RELEASE)
                .append("（API ").append(android.os.Build.VERSION.SDK_INT).append("）\n");
        sb.append("屏幕：").append(dm.widthPixels).append('×').append(dm.heightPixels)
                .append(" @").append(dm.density).append("x\n");
        sb.append("服务器：").append(prefs.server().isEmpty() ? "未设置" : prefs.server()).append("\n\n");
        sb.append("内核：").append(ua.isEmpty() ? "（读不到）" : ua);
        new AlertDialog.Builder(this)
                .setTitle("环境信息")
                .setMessage(sb.toString())
                .setPositiveButton("关闭", null)
                .show();
    }

    private void showAbout() {
        new AlertDialog.Builder(this)
                .setTitle("飞牛书屋 · " + variantLabel())
                .setMessage("版本 " + appVersion() + "\n\n一个跑在飞牛 NAS 上的私人书库客户端。\n"
                        + "服务器地址可在下方随时修改；自签名 HTTPS 证书仅对你自己填写的这台服务器放行。")
                .setPositiveButton("好", null)
                .show();
    }

    // ---------------------------------------------------------------- 输入与返回

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_MENU) {
            showSettings();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    protected boolean isLocalPage() {
        return localPage;
    }

    @Override
    public void onBackPressed() {
        if (localPage) {
            if (prefs.server().isEmpty()) {
                super.onBackPressed();
            } else {
                showSettings();
            }
            return;
        }
        // 1.8.4：先问网页里有没有「一层」要关（阅读器、看图、弹窗）。
        // 1.9.2：网页里的 __fnbBack 已改为「按路由层级返回」（书详情 → 来源列表 → 书库/书架），
        // 弹窗也能被它关掉，所以这里只问它；它说没有更上一层时才走兜底。
        if (web != null) {
            try {
                web.evaluateJavascript(
                        "(function(){try{return window.__fnbBack?(window.__fnbBack()?'1':'0'):'0'}catch(e){return '0'}})()",
                        new android.webkit.ValueCallback<String>() {
                            @Override
                            public void onReceiveValue(String value) {
                                if (value == null || value.indexOf('1') < 0) onBackFallback();
                            }
                        });
                return;
            } catch (Exception ignore) {
                // 网页崩溃/未就绪时直接走兜底
            }
        }
        onBackFallback();
    }

    /**
     * 网页里已经没有更上一层时的默认返回行为（TV 端会覆盖成弹面板）。
     * 1.9.2：不再用 web.goBack() 退浏览历史——那会退到「上一个页面」（例如刚从 A 书
     * 返回又来 B 书，按返回就跳回 A 书），用户要的是「回到上一层」。先让网页算层级，
     * 网页也算不出来时才回首页。
     */
    protected void onBackFallback() {
        if (web != null) {
            try {
                web.evaluateJavascript(
                        "(function(){try{return window.__fnbParent?window.__fnbParent():'0'}catch(e){return '0'}})()",
                        new android.webkit.ValueCallback<String>() {
                            @Override
                            public void onReceiveValue(String value) {
                                if (value == null || value.indexOf("1") < 0) goHome();
                            }
                        });
                return;
            } catch (Exception ignore) {
                // 落到 goHome
            }
        }
        goHome();
    }

    /** 已在最外层（书架）时按返回：回到首页 / 打开设置（子类可覆盖） */
    protected void goHome() {
        showSettings();
    }

    @Override
    protected void onPause() {
        if (web != null) web.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
        if (tvMode()) hideSystemUi();
    }

    @Override
    protected void onDestroy() {
        try {
            if (web != null) {
                web.loadUrl("about:blank");
                web.destroy();
            }
        } catch (Exception ignore) {
        }
        super.onDestroy();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus && tvMode()) hideSystemUi();
    }

    private void hideSystemUi() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    }

    // ---------------------------------------------------------------- 小工具

    protected void toast(String s) {
        Toast.makeText(this, s, Toast.LENGTH_SHORT).show();
    }

    protected String appVersion() {
        try {
            PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
            return pi.versionName;
        } catch (Exception e) {
            return "1.8.3";
        }
    }

    protected static String hostOf(String url) {
        if (url == null || url.isEmpty()) return null;
        try {
            return Uri.parse(url).getHost();
        } catch (Exception e) {
            return null;
        }
    }

    protected static String esc(String s) {
        if (s == null) return "";
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                .replace("\"", "&quot;").replace("'", "&#39;");
    }

    private static String nameFromDisposition(String cd) {
        if (cd == null) return "";
        String lower = cd.toLowerCase();
        int i = lower.indexOf("filename*=");
        if (i >= 0) {
            String v = cd.substring(i + 10).trim();
            int semi = v.indexOf(';');
            if (semi >= 0) v = v.substring(0, semi);
            v = v.replace("\"", "").trim();
            int q = v.indexOf("''");
            if (q >= 0) v = v.substring(q + 2);
            try {
                return java.net.URLDecoder.decode(v, "UTF-8");
            } catch (Exception ignore) {
            }
        }
        i = lower.indexOf("filename=");
        if (i >= 0) {
            String v = cd.substring(i + 9).trim();
            int semi = v.indexOf(';');
            if (semi >= 0) v = v.substring(0, semi);
            v = v.replace("\"", "").trim();
            try {
                return java.net.URLDecoder.decode(v, "UTF-8");
            } catch (Exception ignore) {
                return v;
            }
        }
        return "";
    }

    private static String nameFromUrl(String url) {
        try {
            String p = Uri.parse(url).getLastPathSegment();
            if (p != null && !p.isEmpty()) return p;
        } catch (Exception ignore) {
        }
        return "book.bin";
    }
}
