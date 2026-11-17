package com.fnbookshelf.reader;

import com.fnbookshelf.core.WebApp;

/**
 * 手机 / 平板端：跟随系统方向，支持分屏与横竖屏切换，
 * 保留状态栏（与网页同色），软键盘弹出时收缩页面。
 */
public class PhoneApp extends WebApp {

    @Override
    protected String variantName() {
        return "phone";
    }

    @Override
    protected String[] variantScripts() {
        return new String[]{"fnb-common.js"};
    }
}
