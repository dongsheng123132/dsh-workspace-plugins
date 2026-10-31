/**
 * 终端表格渲染：中文项目路径很常见，必须按“显示宽度”对齐（一个汉字占 2 列）。
 */

const WIDE_RANGES = [
  [0x1100, 0x115f], // 韩文字母
  [0x2e80, 0x303e], // CJK 部首
  [0x3041, 0x33ff], // 假名 / CJK 符号
  [0x3400, 0x4dbf], // CJK 扩展 A
  [0x4e00, 0x9fff], // CJK 基本区
  [0xa000, 0xa4cf], // 彝文
  [0xac00, 0xd7a3], // 谚文音节
  [0xf900, 0xfaff], // CJK 兼容
  [0xfe30, 0xfe4f], // CJK 兼容形式
  [0xff00, 0xff60], // 全角
  [0xffe0, 0xffe6], // 全角符号
  [0x1f300, 0x1f64f], // emoji
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd], // CJK 扩展 B+
];

export function charWidth(cp) {
  for (const [lo, hi] of WIDE_RANGES) {
    if (cp >= lo && cp <= hi) return 2;
  }
  return 1;
}

export function strWidth(s) {
  let w = 0;
  for (const ch of String(s)) w += charWidth(ch.codePointAt(0));
  return w;
}

export function padEnd(s, width) {
  const gap = width - strWidth(s);
  return gap > 0 ? s + ' '.repeat(gap) : s;
}

export function truncate(s, width) {
  s = String(s);
  if (strWidth(s) <= width) return s;
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0));
    if (w + cw > width - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

/** 路径太长时保留头尾，中间省略；用户往往靠尾部认项目 */
export function truncateMiddle(s, width) {
  s = String(s);
  if (strWidth(s) <= width) return s;
  let head = '';
  let headW = 0;
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0));
    if (headW + cw > Math.floor(width * 0.38)) break;
    head += ch;
    headW += cw;
  }
  let tail = '';
  let tailW = 0;
  const chars = [...s];
  for (let i = chars.length - 1; i >= 0; i--) {
    const cw = charWidth(chars[i].codePointAt(0));
    if (tailW + cw > width - headW - 1) break;
    tail = chars[i] + tail;
    tailW += cw;
  }
  return head + '…' + tail;
}

/**
 * 渲染表格。
 * cols: [{ key, title, width?, align? }]；rows: [{ [key]: string }]
 */
export function renderTable(cols, rows, { indent = '  ' } = {}) {
  const widths = cols.map((c) => {
    let w = strWidth(c.title);
    for (const r of rows) w = Math.max(w, strWidth(String(r[c.key] ?? '')));
    return c.width ? Math.min(w, c.width) : w;
  });
  const line = (cells) =>
    indent +
    cells
      .map((cell, i) => {
        const text = cols[i].width
          ? truncate(String(cell ?? ''), cols[i].width)
          : String(cell ?? '');
        // 最后一列也补齐，保证每行显示宽度完全一致（测试会校验）
        return padEnd(text, i === cols.length - 1 ? widths[i] : widths[i] + 2);
      })
      .join('');
  const out = [line(cols.map((c) => c.title))];
  out.push(
    indent +
      widths
        .map((w, i) => '─'.repeat(w) + (i === widths.length - 1 ? '' : '  '))
        .join('')
  );
  for (const r of rows) out.push(line(cols.map((c) => r[c.key] ?? '')));
  return out.join('\n');
}

/** 简易进度/柱状条（用户偏好 ASCII 进度条） */
export function bar(value, max, width = 20) {
  if (!max) return '░'.repeat(width);
  const n = Math.max(0, Math.min(width, Math.round((value / max) * width)));
  return '█'.repeat(n) + '░'.repeat(width - n);
}
