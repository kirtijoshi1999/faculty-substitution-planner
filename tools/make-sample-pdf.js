// Generates sample timetable PDFs from the app's sample data.
//   node make-sample-pdf.js
// Writes ../samples/sample-timetable.pdf (one faculty per page) and
// fixtures/variant-timetable.pdf (two per page + days-as-columns layout),
// each with a matching *.expected.json used by test-parser.js.
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { buildSampleFaculty } = require('../data.js');

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_FULL = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday' };
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'];
const TIMES = ['9:00-10:00', '10:00-11:00', '11:15-12:15', '12:15-1:15', '2:00-3:00', '3:00-4:00', '4:00-5:00', '5:00-6:00'];

const cellText = (label) => label.replace(' · ', '\n');
const expectedLabel = (label) => label.replace(' · ', ' ');

function text(doc, str, x, y, w, h, opts = {}) {
  const lines = String(str).split('\n');
  const size = opts.size || 9;
  doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size);
  const total = lines.length * size * 1.2;
  let ty = y + (h - total) / 2;
  for (const line of lines) {
    doc.text(line, x, ty, { width: w, align: 'center', lineBreak: false });
    ty += size * 1.2;
  }
}

function box(doc, x, y, w, h) {
  doc.lineWidth(0.6).rect(x, y, w, h).stroke();
}

function toExpected(f) {
  const schedule = {};
  for (const d of DAYS) {
    schedule[d] = (f.schedule[d] || []).map((l) => ({ period: l.period, label: expectedLabel(l.label) }));
  }
  return { name: f.name, department: f.department, schedule };
}

// Layout 1: one faculty per landscape page, days as rows, break + lunch columns, merged lab cells.
function standardPage(doc, f) {
  doc.font('Helvetica-Bold').fontSize(16).text('ABC Institute of Technology', 0, 30, { align: 'center', width: doc.page.width });
  doc.font('Helvetica').fontSize(11).text('Faculty Time Table - Academic Year 2026-27 (Odd Semester)', 0, 52, { align: 'center', width: doc.page.width });
  doc.font('Helvetica-Bold').fontSize(11).text(`Name of Faculty: ${f.name}`, 40, 85, { lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(11).text(`Department: ${f.department}`, 560, 85, { lineBreak: false });

  const cols = [{ w: 70, kind: 'day' }];
  ROMAN.forEach((r, i) => {
    cols.push({ w: 80, kind: 'period', period: i + 1, header: `${r}\n${TIMES[i]}` });
    if (i === 1) cols.push({ w: 32, kind: 'break', header: 'Break', letters: 'BREAK' });
    if (i === 3) cols.push({ w: 32, kind: 'break', header: 'Lunch', letters: 'LUNCH' });
  });
  const x0 = 30, y0 = 110, headH = 34, rowH = 64;

  let x = x0;
  for (const c of cols) {
    box(doc, x, y0, c.w, headH);
    text(doc, c.kind === 'day' ? 'Day / Time' : c.header, x, y0, c.w, headH, { bold: true, size: 8 });
    x += c.w;
  }

  DAYS.forEach((day, r) => {
    const y = y0 + headH + r * rowH;
    const byPeriod = Object.fromEntries((f.schedule[day] || []).map((l) => [l.period, l.label]));
    let cx = x0;
    for (let ci = 0; ci < cols.length; ci++) {
      const c = cols[ci];
      if (c.kind === 'day') {
        box(doc, cx, y, c.w, rowH);
        text(doc, DAY_FULL[day], cx, y, c.w, rowH, { bold: true });
      } else if (c.kind === 'break') {
        box(doc, cx, y, c.w, rowH);
        text(doc, c.letters[r] || '', cx, y, c.w, rowH, { bold: true });
      } else {
        const label = byPeriod[c.period];
        const next = cols[ci + 1];
        if (label && label.endsWith('Lab') && next && next.kind === 'period' && byPeriod[next.period] === label) {
          box(doc, cx, y, c.w + next.w, rowH);
          text(doc, cellText(label), cx, y, c.w + next.w, rowH);
          cx += c.w + next.w;
          ci++;
          continue;
        }
        box(doc, cx, y, c.w, rowH);
        text(doc, label ? cellText(label) : (r + c.period) % 3 === 0 ? '-' : '', cx, y, c.w, rowH);
      }
      cx += c.w;
    }
  });
}

// Layout 2: compact table, days as rows, abbreviated day names, plain period numbers.
function compactTable(doc, f, top) {
  doc.font('Helvetica-Bold').fontSize(10).text(`Faculty : ${f.name}`, 40, top, { lineBreak: false });
  doc.font('Helvetica').fontSize(10).text(`Dept. ${f.department}`, 600, top, { lineBreak: false });
  const x0 = 40, y0 = top + 20, dayW = 50, colW = 92, headH = 18, rowH = 30;
  box(doc, x0, y0, dayW, headH);
  text(doc, 'Day', x0, y0, dayW, headH, { bold: true });
  for (let p = 1; p <= 8; p++) {
    box(doc, x0 + dayW + (p - 1) * colW, y0, colW, headH);
    text(doc, String(p), x0 + dayW + (p - 1) * colW, y0, colW, headH, { bold: true });
  }
  DAYS.forEach((day, r) => {
    const y = y0 + headH + r * rowH;
    box(doc, x0, y, dayW, rowH);
    text(doc, day.toUpperCase(), x0, y, dayW, rowH, { bold: true, size: 8 });
    const byPeriod = Object.fromEntries((f.schedule[day] || []).map((l) => [l.period, l.label]));
    for (let p = 1; p <= 8; p++) {
      const cx = x0 + dayW + (p - 1) * colW;
      box(doc, cx, y, colW, rowH);
      text(doc, byPeriod[p] ? expectedLabel(byPeriod[p]) : '', cx, y, colW, rowH, { size: 7 });
    }
  });
}

// Layout 3: days as columns, periods as rows.
function transposedPage(doc, f) {
  doc.font('Helvetica-Bold').fontSize(14).text('Individual Time Table', 0, 30, { align: 'center', width: doc.page.width });
  doc.font('Helvetica').fontSize(11).text(`Teacher Name : ${f.name}`, 40, 60, { lineBreak: false });
  doc.font('Helvetica').fontSize(11).text(`Department : ${f.department}`, 40, 76, { lineBreak: false });
  const x0 = 40, y0 = 100, labW = 90, colW = 115, headH = 22, rowH = 52;
  box(doc, x0, y0, labW, headH);
  text(doc, 'Period', x0, y0, labW, headH, { bold: true });
  DAYS.forEach((day, c) => {
    box(doc, x0 + labW + c * colW, y0, colW, headH);
    text(doc, DAY_FULL[day], x0 + labW + c * colW, y0, colW, headH, { bold: true });
  });
  for (let p = 1; p <= 8; p++) {
    const y = y0 + headH + (p - 1) * rowH;
    box(doc, x0, y, labW, rowH);
    text(doc, `Period ${p}\n${TIMES[p - 1]}`, x0, y, labW, rowH, { bold: true, size: 8 });
    DAYS.forEach((day, c) => {
      const l = (f.schedule[day] || []).find((x) => x.period === p);
      box(doc, x0 + labW + c * colW, y, colW, rowH);
      text(doc, l ? cellText(l.label) : '', x0 + labW + c * colW, y, colW, rowH);
    });
  }
}

function write(doc, file) {
  return new Promise((resolve) => {
    const out = fs.createWriteStream(file);
    out.on('finish', resolve);
    doc.pipe(out);
    doc.end();
  });
}

async function main() {
  const faculty = buildSampleFaculty();
  // A two-period lab, drawn as one merged cell.
  faculty[0].schedule.Tue = faculty[0].schedule.Tue
    .filter((l) => l.period !== 5 && l.period !== 6)
    .concat([{ period: 5, label: 'BE-A · DBMS Lab' }, { period: 6, label: 'BE-A · DBMS Lab' }])
    .sort((a, b) => a.period - b.period);

  const samplesDir = path.join(__dirname, '..', 'samples');
  const fixturesDir = path.join(__dirname, 'fixtures');
  fs.mkdirSync(samplesDir, { recursive: true });
  fs.mkdirSync(fixturesDir, { recursive: true });

  const std = new PDFDocument({ size: 'A4', layout: 'landscape', autoFirstPage: false });
  faculty.forEach((f) => { std.addPage({ size: 'A4', layout: 'landscape', margin: 20 }); standardPage(std, f); });
  await write(std, path.join(samplesDir, 'sample-timetable.pdf'));
  fs.writeFileSync(path.join(fixturesDir, 'sample-timetable.expected.json'), JSON.stringify(faculty.map(toExpected), null, 2));

  const variant = new PDFDocument({ autoFirstPage: false });
  const [a, b, c] = faculty.slice(1, 4);
  variant.addPage({ size: 'A4', layout: 'landscape', margin: 20 });
  compactTable(variant, a, 30);
  compactTable(variant, b, 300);
  variant.addPage({ size: 'A4', layout: 'landscape', margin: 20 });
  transposedPage(variant, c);
  await write(variant, path.join(fixturesDir, 'variant-timetable.pdf'));
  fs.writeFileSync(path.join(fixturesDir, 'variant-timetable.expected.json'), JSON.stringify([a, b, c].map(toExpected), null, 2));

  console.log('Wrote samples/sample-timetable.pdf and fixtures/variant-timetable.pdf');
}

main();
