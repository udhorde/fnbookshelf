# 飞牛书屋（fnbookshelf）

跑在飞牛 fnOS 上的自托管电子书阅读应用：把 NAS 上的电子书变成一个能搜、能读、能整理的书架。

- **服务端 / Web**：fnOS `.fpk` 应用包，Express + 原生 JS，无前端构建步骤
- **客户端**：Android 手机版 / TV 版（aapt2 + javac + d8，不依赖 Gradle）

当前版本 **1.9.3**。

## 目录结构

```
fnbookshelf/                 fnOS 应用（.fpk）
├── manifest                 应用元信息（fnOS 按「键=值」逐行解析，每行只能有一个 =）
├── build.sh                 打包：内嵌 Node 运行时 + server/ + www/ → fnbookshelf_<ver>_x86.fpk
├── appsrc/
│   ├── server/              服务端
│   │   ├── app.js           HTTP 入口、路由挂载、BASE_PATH 二级路径
│   │   ├── routes/          API 路由
│   │   └── lib/             store / scanner / taxonomy / scheduler / booksearch …
│   └── www/                 前端（原生 JS，无打包）
│       ├── js/app.js        书库、详情、筛选、专题、版本管理
│       ├── js/reader.js     阅读器（EPUB / PDF / MOBI / TXT / DOCX / PPT）
│       └── vendor/          epub.js / pdf.js / foliate / webppt
├── cmd/  config/  ui/  wizard/   fnOS 应用生命周期脚本与桌面入口

android/                     Android 客户端
├── build.sh                 aapt2 + javac + d8 + apksigner
├── AndroidManifest-phone.xml / -tv.xml
├── src/core|phone|tv/       Java 源码
├── assets-common/           fnb-common.js（下载交给原生）
└── assets-tv/               tv-nav.js（遥控器空间导航）
```

## 构建

**服务端 / fpk**（需 Node 22 与 fnOS 打包环境变量，见 `build.sh` 头部）：

```bash
cd fnbookshelf && bash build.sh
# → fnbookshelf_1.9.3_x86.fpk
```

**Android**（需 `android/tools/` 下的 JDK17 + build-tools;34 + platforms;android-34，见 `android/README.md`）：

```bash
cd android && bash build.sh
# → out/fnbookshelf-android-{phone,tv}-1.9.3.apk
```

签名密钥放在 `android/keystore/fnb.jks`（**不入库**）。首次构建若缺失，`build.sh` 会自动生成一把自签名密钥——但这意味着**升级覆盖安装会因签名不同而失败**，请自行备份并在多台机器之间复用同一把。

## 本地调试

```bash
PORT=8096 DATA_DIR=/path/to/data ADMIN_EMAIL=you@example.com \
  node fnbookshelf/appsrc/server/app.js
```

默认启用自签名 HTTPS，`curl` 需加 `-k`。首次启动会自动创建管理员账号，数据全部落在 `DATA_DIR` 下（`data.json` + `secret.key` + `logs/`）。

## 版本

| 版本 | 主要改动 |
|---|---|
| 1.9.3 | 阅读器退出卡死；PDF/PPT 每页底部灰底空白；多文件一次合并 |
| 1.9.2 | 刮削书名不再串号；格式/出版社/作者筛选；APP 返回键回上一层；朗读取全文 |
| 1.9.1 | 扫描调度；封面上传；回收站 30 天保留；顶栏吸顶 |
| 1.9.0 | 书库整理大改；多端安装包管理；专题封面 |
| 1.8.x | 编码自愈、大 TXT 分块、全库检索、流式落盘、专题、旧 WebView 兼容 |

完整改动见 `fnbookshelf/README.md`。
