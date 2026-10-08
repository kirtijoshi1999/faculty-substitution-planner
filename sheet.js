/**
 * Shareable schedule sheets (dark-blue header, alternating light-blue groups, first column merged
 * per group) rendered as HTML, Excel, PNG, clipboard image or print.
 *
 * spec = { title, headers: [...], groups: [{ label, rows: [[cell, ...], ...] }], fileName }
 * Each row holds the cells after the merged first column.
 */
(function (root) {
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  function formatDate(iso) {
    const [y, m, d] = iso.split('-');
    return `${d}/${m}/${y}`;
  }

  function tableHtml(spec, inlineStyles) {
    const s = inlineStyles
      ? {
          th: ' style="background:#1f4e79;color:#fff;font-weight:bold;border:1px solid #9bb7d4;padding:6px 10px"',
          td: (g, bold) => ` style="background:${g ? '#ffffff' : '#dce6f1'};border:1px solid #9bb7d4;padding:6px 10px;text-align:center;vertical-align:middle${bold ? ';font-weight:bold' : ''}"`,
        }
      : { th: '', td: (g, bold) => (bold ? ' class="for"' : '') };
    const body = spec.groups
      .map((g, gi) =>
        g.rows
          .map((r, ri) => {
            const cells = r.map((v) => `<td${s.td(gi % 2)}>${esc(v)}</td>`).join('');
            const first = ri === 0 ? `<td rowspan="${g.rows.length}"${s.td(gi % 2, true)}>${esc(g.label)}</td>` : '';
            return `<tr class="g${gi % 2}">${first}${cells}</tr>`;
          })
          .join('')
      )
      .join('');
    return `<table class="sched"${inlineStyles ? ' border="1" style="border-collapse:collapse;font-family:Calibri,Arial,sans-serif"' : ''}>
      <thead><tr>${spec.headers.map((h) => `<th${s.th}>${esc(h)}</th>`).join('')}</tr></thead>
      <tbody>${body}</tbody></table>`;
  }

  const sheetHtml = (spec) => `<div class="sheet"><h3>${esc(spec.title)}</h3>${tableHtml(spec, false)}</div>`;

  function canvas(spec) {
    const rows = spec.groups.flatMap((g, gi) =>
      g.rows.map((cells, ri) => ({ cells, gi, first: ri === 0, span: g.rows.length, label: g.label }))
    );
    const scale = 2;
    const fonts = { title: 'bold 22px Calibri, Arial, sans-serif', head: 'bold 15px Calibri, Arial, sans-serif', bold: 'bold 14px Calibri, Arial, sans-serif', cell: '14px Calibri, Arial, sans-serif' };
    const ctx = document.createElement('canvas').getContext('2d');
    const measure = (text, font) => ((ctx.font = font), ctx.measureText(String(text ?? '')).width);
    const colW = spec.headers.map((h, c) => {
      let w = measure(h, fonts.head);
      for (const r of rows) w = Math.max(w, c === 0 ? measure(r.label, fonts.bold) : measure(r.cells[c - 1], fonts.cell));
      return Math.ceil(w + 36);
    });
    const titleH = 44, headH = 32, rowH = 30;
    const width = Math.max(colW.reduce((a, b) => a + b, 0), Math.ceil(measure(spec.title, fonts.title) + 40));
    colW[colW.length - 1] += width - colW.reduce((a, b) => a + b, 0);
    const height = titleH + headH + rows.length * rowH;

    const out = document.createElement('canvas');
    out.width = width * scale;
    out.height = height * scale;
    const g = out.getContext('2d');
    g.scale(scale, scale);
    g.fillStyle = '#fff';
    g.fillRect(0, 0, width, height);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#000';
    g.font = fonts.title;
    g.fillText(spec.title, width / 2, titleH / 2);

    const xs = colW.reduce((acc, w) => [...acc, acc[acc.length - 1] + w], [0]);
    const cell = (x, y, w, h, bg, text, font, color = '#000') => {
      g.fillStyle = bg;
      g.fillRect(x, y, w, h);
      g.strokeStyle = '#9bb7d4';
      g.lineWidth = 1;
      g.strokeRect(x + 0.5, y + 0.5, w, h);
      g.fillStyle = color;
      g.font = font;
      g.fillText(String(text ?? ''), x + w / 2, y + h / 2);
    };
    spec.headers.forEach((h, c) => cell(xs[c], titleH, colW[c], headH, '#1f4e79', h, fonts.head, '#fff'));
    rows.forEach((r, i) => {
      const y = titleH + headH + i * rowH;
      const bg = r.gi % 2 ? '#ffffff' : '#dce6f1';
      if (r.first) cell(xs[0], y, colW[0], rowH * r.span, bg, r.label, fonts.bold);
      r.cells.forEach((v, k) => cell(xs[k + 1], y, colW[k + 1], rowH, bg, v, fonts.cell));
    });
    return out;
  }

  function download(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function excel(spec) {
    const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">
      <head><meta charset="UTF-8"></head><body>
      <table><tr><td colspan="${spec.headers.length}" style="font-size:16pt;font-weight:bold;text-align:center">${esc(spec.title)}</td></tr></table>
      ${tableHtml(spec, true)}</body></html>`;
    download(new Blob(['\ufeff' + html], { type: 'application/vnd.ms-excel' }), `${spec.fileName}.xls`);
  }

  function image(spec) {
    canvas(spec).toBlob((blob) => download(blob, `${spec.fileName}.png`), 'image/png');
  }

  function copy(spec, btn) {
    const label = (btn.dataset.label = btn.dataset.label || btn.textContent);
    const done = (text) => {
      btn.textContent = text;
      setTimeout(() => (btn.textContent = label), 2000);
    };
    if (!navigator.clipboard || !window.ClipboardItem) {
      done('Copy not supported — use Download image');
      return;
    }
    const blob = new Promise((resolve) => canvas(spec).toBlob(resolve, 'image/png'));
    navigator.clipboard
      .write([new ClipboardItem({ 'image/png': blob })])
      .then(() => done('Copied ✓ — paste in WhatsApp/email'))
      .catch(() => done('Copy blocked — use Download image'));
  }

  /** Prints only the given card. */
  function print(card) {
    document.querySelectorAll('.print-target').forEach((el) => el.classList.remove('print-target'));
    card.classList.add('print-target');
    document.body.classList.add('print-schedule');
    window.print();
  }
  root.addEventListener('afterprint', () => document.body.classList.remove('print-schedule'));

  root.Sheet = { esc, formatDate, tableHtml, sheetHtml, canvas, download, excel, image, copy, print };
})(this);
