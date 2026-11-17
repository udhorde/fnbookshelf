// 生成结构完整（含 toc.ncx）的测试 EPUB
// 不依赖第三方库：自带一个最小 ZIP 写入器（mimetype 按规范用 stored 不压缩）
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

fs.mkdirSync(path.join(__dirname, 'testlib'), { recursive: true });
const out = path.join(__dirname, 'testlib', '三体-刘慈欣.epub');

// ---- 最小 ZIP 写入 ----
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}
function makeZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const data = f.data;
    const method = f.store ? 0 : 8;
    const comp = f.store ? data : zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);      // 文件名用 UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);          // 时间
    local.writeUInt16LE(0x21, 12);       // 日期 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, comp);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + comp.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralBuf, end]);
}

const chapters = [
  ['第一章 疯狂年代', '中国，1967年。\n\n红色的汪洋淹没了一切理性。叶文洁站在操场的边缘，看着父亲被推上高台。\n\n那一年，她十七岁。'],
  ['第二章 寂静的春天', '雷达阵列在红岸基地缓缓转向，指向深空。\n\n叶文洁按下了那个按钮。八光年之外，一个文明收到了她的信号。'],
  ['第三章 三体世界', '三个太阳在天空中交错运行，文明在一百三十七次毁灭与重生中轮回。\n\n“不要回答！不要回答！不要回答！”']
];

const files = [];
const add = (name, str, store) => files.push({ name, data: Buffer.isBuffer(str) ? str : Buffer.from(str), store: !!store });

// mimetype 必须是 ZIP 里第一个文件、且不压缩
add('mimetype', 'application/epub+zip', true);
add('META-INF/container.xml', `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`);

const manifestItems = chapters.map((_, i) => `    <item id="c${i + 1}" href="c${i + 1}.xhtml" media-type="application/xhtml+xml"/>`).join('\n');
const spineItems = chapters.map((_, i) => `    <itemref idref="c${i + 1}"/>`).join('\n');
add('OEBPS/content.opf', `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>三体</dc:title>
    <dc:creator opf:role="aut">刘慈欣</dc:creator>
    <dc:language>zh-CN</dc:language>
    <dc:publisher>重庆出版社</dc:publisher>
    <dc:subject>科幻</dc:subject>
    <dc:subject>小说</dc:subject>
    <dc:description>地球文明向宇宙发出的第一声啼鸣，以及随之而来的黑暗森林。</dc:description>
    <dc:identifier id="bookid">urn:uuid:12345678-1234-1234-1234-123456789abc</dc:identifier>
    <meta name="cover" content="cover-img"/>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="cover-img" href="cover.jpg" media-type="image/jpeg"/>
${manifestItems}
  </manifest>
  <spine toc="ncx">
${spineItems}
  </spine>
</package>`);

add('OEBPS/toc.ncx', `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="urn:uuid:12345678-1234-1234-1234-123456789abc"/></head>
  <docTitle><text>三体</text></docTitle>
  <navMap>
${chapters.map((c, i) => `    <navPoint id="np${i + 1}" playOrder="${i + 1}">
      <navLabel><text>${c[0]}</text></navLabel>
      <content src="c${i + 1}.xhtml"/>
    </navPoint>`).join('\n')}
  </navMap>
</ncx>`);

chapters.forEach((c, i) => {
  const body = c[1].split('\n\n').map(p => `<p>${p}</p>`).join('\n');
  add(`OEBPS/c${i + 1}.xhtml`, `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${c[0]}</title>
<style>body{font-family:serif;line-height:1.8;padding:20px} h1{font-size:1.4em}</style></head>
<body><h1>${c[0]}</h1>${body}</body></html>`);
});

// 1x1 红色 JPEG
add('OEBPS/cover.jpg', Buffer.from('ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffc0000b080001000101011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9faffda0008010100003f00fbfa28a2803a2800ffd9', 'hex'));

fs.writeFileSync(out, makeZip(files));
console.log('EPUB created:', out, fs.statSync(out).size, 'bytes');

// 用项目自己的 ZIP 读取器验证一遍（只读，与运行时同一条路径）
try {
  const zipread = require('./fnbookshelf/appsrc/server/lib/zipread.js');
  const names = (typeof zipread.list === 'function' ? zipread.list(out) : []);
  console.log('zip entries:', Array.isArray(names) ? names.length : '(跳过校验)');
} catch (e) {
  console.log('校验跳过：', e.message);
}
