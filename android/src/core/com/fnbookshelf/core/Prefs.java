package com.fnbookshelf.core;

import android.content.Context;
import android.content.SharedPreferences;

/** 极小的配置存储：只记服务器地址和几个开关。 */
public class Prefs {
    private static final String FILE = "fnb";
    private final SharedPreferences sp;

    public Prefs(Context ctx) {
        this.sp = ctx.getApplicationContext().getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    public String server() {
        String s = sp.getString("server", "");
        return s == null ? "" : s;
    }

    public void setServer(String url) {
        sp.edit().putString("server", url == null ? "" : url).apply();
    }

    public String lastServer() {
        String s = sp.getString("lastServer", "");
        return s == null ? "" : s;
    }

    public void setLastServer(String url) {
        sp.edit().putString("lastServer", url == null ? "" : url).apply();
    }

    public boolean keepAwake() {
        return sp.getBoolean("keepAwake", true);
    }

    public void setKeepAwake(boolean v) {
        sp.edit().putBoolean("keepAwake", v).apply();
    }

    public int launches() {
        int n = sp.getInt("launches", 0) + 1;
        sp.edit().putInt("launches", n).apply();
        return n;
    }
}
