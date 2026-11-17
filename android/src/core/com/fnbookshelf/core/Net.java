package com.fnbookshelf.core;

import android.net.Uri;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.cert.X509Certificate;

import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSession;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/**
 * 网络小工具。
 * 飞牛书屋默认用自签名证书，客户端必须按「只信任用户自己填的那个主机」放行，
 * 所以这里的 trustAll 只在探测/下载这台已配置的服务器时使用，不能拿去访问任意网站。
 */
public class Net {

    /** 把用户随手输入的地址补成合法 URL：补 https://、去尾斜杠、去空格。 */
    public static String normalize(String raw) {
        String s = raw == null ? "" : raw.trim();
        if (s.isEmpty()) return "";
        s = s.replace(" ", "");
        if (!s.matches("(?i)^[a-z][a-z0-9+.\\-]*://.*")) {
            s = "https://" + s;
        }
        while (s.length() > "https://".length() && s.endsWith("/")) {
            s = s.substring(0, s.length() - 1);
        }
        return s;
    }

    public static boolean looksValid(String url) {
        if (url == null || url.isEmpty()) return false;
        try {
            Uri u = Uri.parse(url);
            String scheme = u.getScheme();
            if (scheme == null) return false;
            if (!scheme.equalsIgnoreCase("http") && !scheme.equalsIgnoreCase("https")) return false;
            String host = u.getHost();
            return host != null && host.length() > 0;
        } catch (Exception e) {
            return false;
        }
    }

    public static SSLContext trustAllContext() {
        try {
            TrustManager[] tm = new TrustManager[]{new X509TrustManager() {
                public void checkClientTrusted(X509Certificate[] chain, String authType) {
                }

                public void checkServerTrusted(X509Certificate[] chain, String authType) {
                }

                public X509Certificate[] getAcceptedIssuers() {
                    return new X509Certificate[0];
                }
            }};
            SSLContext ctx = SSLContext.getInstance("TLS");
            ctx.init(null, tm, new java.security.SecureRandom());
            return ctx;
        } catch (Exception e) {
            return null;
        }
    }

    private static HttpURLConnection open(String url, int connectMs, int readMs) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        if (c instanceof HttpsURLConnection) {
            SSLContext ctx = trustAllContext();
            if (ctx != null) ((HttpsURLConnection) c).setSSLSocketFactory(ctx.getSocketFactory());
            ((HttpsURLConnection) c).setHostnameVerifier(new HostnameVerifier() {
                public boolean verify(String host, SSLSession session) {
                    return true;
                }
            });
        }
        c.setConnectTimeout(connectMs);
        c.setReadTimeout(readMs);
        c.setInstanceFollowRedirects(true);
        c.setRequestProperty("User-Agent", "FnBookshelfApp/1.9.0");
        c.setRequestProperty("Accept", "application/json, text/plain, */*");
        return c;
    }

    private static String readSome(InputStream in, int max) throws Exception {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) {
            bo.write(buf, 0, n);
            if (bo.size() >= max) break;
        }
        return new String(bo.toByteArray(), "UTF-8");
    }

    /** 取一个 JSON（用于版本检查等小接口）；失败返回 null。 */
    public static JSONObject getJson(String base, String path) {
        HttpURLConnection c = null;
        try {
            c = open(normalize(base) + path, 7000, 9000);
            if (c.getResponseCode() != 200) return null;
            String body = readSome(c.getInputStream(), 262144);
            return new JSONObject(body);
        } catch (Exception e) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /** 探测 /api/site，返回 {ok, siteName, ms, msg, https}。 */    public static JSONObject probe(String url) {
        JSONObject r = new JSONObject();
        String base = normalize(url);
        long t0 = System.currentTimeMillis();
        if (!looksValid(base)) {
            put(r, "ok", false);
            put(r, "msg", "地址格式不对，应该像 192.168.1.10:8096 或 https://nas.example.com");
            return r;
        }
        HttpURLConnection c = null;
        try {
            c = open(base + "/api/site", 7000, 8000);
            int code = c.getResponseCode();
            long ms = System.currentTimeMillis() - t0;
            if (code == 200) {
                String body = readSome(c.getInputStream(), 65536);
                String name = "飞牛书屋";
                try {
                    JSONObject j = new JSONObject(body);
                    if (j.has("siteName") && j.optString("siteName").length() > 0) {
                        name = j.optString("siteName");
                    }
                } catch (Exception ignore) {
                }
                put(r, "ok", true);
                put(r, "siteName", name);
                put(r, "ms", ms);
                put(r, "https", base.toLowerCase().startsWith("https"));
                put(r, "msg", "连接成功，用时 " + ms + " ms");
            } else {
                put(r, "ok", false);
                put(r, "code", code);
                put(r, "msg", "服务器返回 HTTP " + code + "，请确认地址和端口是否正确");
            }
        } catch (Exception e) {
            put(r, "ok", false);
            put(r, "msg", friendly(e));
        } finally {
            if (c != null) c.disconnect();
        }
        return r;
    }

    public static String friendly(Exception e) {
        String m = e.getClass().getSimpleName() + ": " + e.getMessage();
        String low = m.toLowerCase();
        if (low.contains("timeout") || low.contains("timed out")) {
            return "连接超时。请确认手机和 NAS 在同一个网络，且端口已放行（默认 8096）";
        }
        if (low.contains("unknownhost") || low.contains("nodename")) {
            return "找不到这个主机名，请检查地址是否拼错";
        }
        if (low.contains("refused")) {
            return "对方拒绝了连接，应用可能没在运行，或端口不对";
        }
        if (low.contains("ssl") || low.contains("cert")) {
            return "TLS 握手失败：" + m;
        }
        if (low.contains("network is unreachable") || low.contains("econnunreach")) {
            return "网络不可达，请检查 Wi-Fi / 网线";
        }
        return m;
    }

    private static void put(JSONObject o, String k, Object v) {
        try {
            o.put(k, v);
        } catch (Exception ignore) {
        }
    }

    /** 把远端文件下载到本地 OutputStream（下载按钮走原生通道时用）。 */
    public static long fetchToStream(String url, java.io.OutputStream out, long maxBytes,
                                     String cookieHeader) throws Exception {
        HttpURLConnection c = open(url, 10000, 20000);
        try {
            if (cookieHeader != null && cookieHeader.length() > 0) {
                c.setRequestProperty("Cookie", cookieHeader);
            }
            int code = c.getResponseCode();
            if (code != 200) throw new Exception("HTTP " + code);
            InputStream in = c.getInputStream();
            byte[] buf = new byte[32768];
            long total = 0;
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                total += n;
                if (total > maxBytes) throw new Exception("文件过大（超过 " + (maxBytes / 1048576) + " MB）");
            }
            in.close();
            return total;
        } finally {
            c.disconnect();
        }
    }
}
