// Parses the generated PDFs and compares against the expected timetables.
//   node make-sample-pdf.js && node test-parser.js [extra.pdf ...]
const fs = require('fs');
const path = require('path');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
const { importTimetablePdf } = require('../pdf-import.js');

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const fixtures = [
  [path.join(__dirname, '..', 'samples', 'sample-timetable.pdf'), 'fixtures/sample-timetable.expected.json'],
  [path.join(__dirname, 'fixtures', 'variant-timetable.pdf'), 'fixtures/variant-timetable.expected.json'],
];

async function parse(file) {
  return importTimetablePdf(new Uint8Array(fs.readFileSync(file)), pdfjsLib);
}

async function main() {
  let failures = 0;
  for (const [pdf, expectedFile] of fixtures) {
    const expected = JSON.parse(fs.readFileSync(path.join(__dirname, expectedFile), 'utf8'));
    const result = await parse(pdf);
    const problems = [];
    if (result.faculty.length !== expected.length) {
      problems.push(`expected ${expected.length} faculty, got ${result.faculty.length}`);
    }
    expected.forEach((exp, i) => {
      const got = result.faculty[i];
      if (!got) return;
      if (got.name !== exp.name) problems.push(`#${i + 1} name: "${got.name}" != "${exp.name}"`);
      if (got.department !== exp.department) problems.push(`#${i + 1} dept: "${got.department}" != "${exp.department}"`);
      for (const d of DAYS) {
        const a = JSON.stringify(got.schedule[d]);
        const b = JSON.stringify(exp.schedule[d]);
        if (a !== b) problems.push(`${exp.name} ${d}:\n    got      ${a}\n    expected ${b}`);
      }
    });
    console.log(`${path.basename(pdf)}: ${problems.length ? 'FAIL' : 'OK'} (${result.faculty.length} faculty, ${result.periods} periods)`);
    if (result.warnings.length) console.log('  warnings:', result.warnings);
    problems.forEach((p) => console.log('  - ' + p));
    failures += problems.length;
  }

  for (const extra of process.argv.slice(2)) {
    const result = await parse(extra);
    console.log(`\n${extra}:`, JSON.stringify(result, null, 1));
  }
  process.exit(failures ? 1 : 0);
}

main();
