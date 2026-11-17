package com.fnbookshelf.tv;

import android.app.AlertDialog;
import android.content.DialogInterface;

import com.fnbookshelf.core.WebApp;

/**
 * TV 端：横屏、全屏沉浸、遥控器方向键在网页里做空间导航，
 * 输入框弹出原生对话框（电视遥控器没有软键盘）。
 */
public class TvApp extends WebApp {

    @Override
    protected String variantName() {
        return "tv";
    }

    @Override
    protected boolean tvMode() {
        return true;
    }

    @Override
    protected int textZoomPct() {
        return 140;
    }

    @Override
    protected String[] variantScripts() {
        return new String[]{"fnb-common.js", "tv-nav.js"};
    }

    @Override
    protected void onBackFallback() {
        if (!isLocalPage() && web != null) {
            // 1.9.2：按层级返回（网页算不出上一层时才落到下面的面板）
            try {
                web.evaluateJavascript(
                        "(function(){try{return window.__fnbParent?window.__fnbParent():'0'}catch(e){return '0'}})()",
                        new android.webkit.ValueCallback<String>() {
                            @Override
                            public void onReceiveValue(String value) {
                                if (value == null || value.indexOf("1") < 0) homeDialog();
                            }
                        });
                return;
            } catch (Exception ignore) {
                // 落到面板
            }
        }
        homeDialog();
    }

    private void homeDialog() {
        // 遥控器不一定有菜单键，所以返回键在首页给一个能进设置的小面板
        new AlertDialog.Builder(this)
                .setTitle("飞牛书屋")
                .setItems(new String[]{"服务器设置", "刷新页面", "退出"}, new DialogInterface.OnClickListener() {
                    public void onClick(DialogInterface d, int which) {
                        if (which == 0) {
                            showSettings();
                        } else if (which == 1) {
                            if (prefs.server().isEmpty()) showSetup("");
                            else openServer();
                        } else {
                            finish();
                        }
                    }
                })
                .setNegativeButton("取消", null)
                .show();
    }
}
