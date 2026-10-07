(function (root) {
  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const DAY_RE =
    /^(mo(n(day)?)?|tu(e(s(day)?)?)?|we(d(nesday)?)?|th(u(r(s(day)?)?)?)?|fr(i(day)?)?|sa(t(urday)?)?)\.?$/i;
  const DAY_PREFIXES = ['mo', 'tu', 'we', 'th', 'fr', 'sa'];
  const BREAK_RE = /\b(break|lunch|recess|interval|tea)\b/i;
  const EMPTY_CELL_RE =
    /^(-+|–|—|x|nil|free|n\/?a|[a-z]|((short|long|lunch|tea)\s+)?(break|recess|interval)|lunch)$/i;
  const NAME_LABEL_RE =
    /(?:name\s+of\s+(?:the\s+)?(?:faculty|teacher|staff)(?:\s+member)?|(?:faculty|teacher|staff)\s+name|faculty|teacher|staff|name)\s*[:\-–]\s*(.+)/i;
  // aSc Timetables style heading: "Teacher Dr. Vipin Sharma (E15974)"
  const NAME_PREFIX_RE = /^\s*(?:teacher|faculty|staff)\s+(?!time\s*table|timetable|wise|schedule)(.+)/i;
  // Employee codes like "(E15974)", "E20647" or "e20504" at the end of the name.
  const CODE_RE = /\s*[(\[]?\s*\b([A-Z]{1,4}\d{3,})\s*[)\]]?\s*$/i;
  // A trailing letters-only tag like "(DCPD)" is treated as the department.
  const TAG_RE = /\s*\(\s*([A-Za-z][A-Za-z&.\s]{1,30})\s*\)\s*$/;
  const TITLE_RE = /^(dr|prof|mr|mrs|ms|miss|shri|smt)\b\.?\s+\S/i;
  const NAME_STOP_RE =
    /(\s{3,}|\s+\b(department|dept|designation|subject|semester|sem|class|room|code|academic|year|w\.?e\.?f|date)\b).*$/i;
  const DEPT_RE = /\b(?:department|dept)\b\.?\s*(?:of\s+)?[:\-–]?\s*(.+)/i;
  const DEPT_STOP_RE = /(\s{3,}|\s+\b(name|faculty|teacher|designation|semester|sem|class|room|year|w\.?e\.?f|date)\b).*$/i;

  const ROOM_RE = /^[A-Z]{1,2}\d{1,2}-\d{2,4}[A-Z]?$/;
  const TRAILING_ROOM_RE = /^(.*?)\s*([A-Z]\d{1,2}-\d{2,4}[A-Z]?)$/;
  const GROUP_RE = /^(group|grp|batch)\s*\S+$/i;
  const BATCH_START_RE = /^\d{2}[A-Z]/;
  const TIME_RE = /(\d{1,2}[:.]\d{2})\s*[-–]\s*(\d{1,2}[:.]\d{2})/;

  const median = (xs) => {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  const cx = (i) => i.x + i.w / 2;
  const cy = (i) => i.y + i.h / 2;
  const clean = (s) => s.replace(/\s+/g, ' ').trim();

  function dayOf(str) {
    const s = str.replace(/\s+/g, '');
    return DAY_RE.test(s) ? DAYS[DAY_PREFIXES.indexOf(s.slice(0, 2).toLowerCase())] : null;
  }

  function groupLines(items, tol) {
    const lines = [];
    for (const it of [...items].sort((a, b) => cy(a) - cy(b))) {
      const line = lines[lines.length - 1];
      if (line && Math.abs(cy(it) - line.cy) <= tol) line.items.push(it);
      else lines.push({ cy: cy(it), items: [it] });
    }
    for (const line of lines) {
      line.items.sort((a, b) => a.x - b.x);
      line.top = Math.min(...line.items.map((i) => i.y));
      line.bottom = Math.max(...line.items.map((i) => i.y + i.h));
      let text = '';
      let prevEnd = null;
      for (const i of line.items) {
        if (prevEnd != null) text += i.x - prevEnd > 2 * i.h ? '    ' : ' ';
        text += i.str;
        prevEnd = i.x + i.w;
      }
      line.text = text;
    }
    return lines;
  }

  // Clusters items whose horizontal extents overlap into columns.
  function clusterColumns(items) {
    const cols = [];
    for (const it of [...items].sort((a, b) => a.x - b.x)) {
      const col = cols.find((c) => it.x < c.right + 2 && it.x + it.w > c.left - 2);
      if (col) {
        col.items.push(it);
        col.left = Math.min(col.left, it.x);
        col.right = Math.max(col.right, it.x + it.w);
      } else {
        cols.push({ left: it.x, right: it.x + it.w, items: [it] });
      }
    }
    cols.sort((a, b) => a.left - b.left);
    for (const c of cols) {
      c.center = (c.left + c.right) / 2;
      c.label = clean([...c.items].sort(readingOrder).map((i) => i.str).join(' '));
    }
    return cols;
  }

  // Splits day labels (sorted along their axis) into separate tables whenever the day order restarts.
  function splitSequences(days) {
    const seqs = [];
    let cur = [];
    for (const d of days) {
      const prev = cur[cur.length - 1];
      if (prev && DAYS.indexOf(d.day) <= DAYS.indexOf(prev.day)) {
        seqs.push(cur);
        cur = [];
      }
      cur.push(d);
    }
    if (cur.length) seqs.push(cur);
    return seqs.filter((s) => s.length >= 3);
  }

  function findDayAxes(items) {
    const days = items.map((i) => ({ ...i, day: dayOf(i.str), src: i })).filter((i) => i.day);
    const used = new Set();
    const axes = [];

    const vertical = [];
    for (const d of days) {
      const g = vertical.find((g) => Math.abs(g[0].x - d.x) < 15 || Math.abs(cx(g[0]) - cx(d)) < 15);
      if (g) g.push(d);
      else vertical.push([d]);
    }
    for (const g of vertical) {
      g.sort((a, b) => cy(a) - cy(b));
      for (const seq of splitSequences(g)) {
        axes.push({ orientation: 'rows', days: seq });
        seq.forEach((d) => used.add(d));
      }
    }

    const horizontal = [];
    for (const d of days.filter((d) => !used.has(d))) {
      const g = horizontal.find((g) => Math.abs(cy(g[0]) - cy(d)) < 6);
      if (g) g.push(d);
      else horizontal.push([d]);
    }
    for (const g of horizontal) {
      g.sort((a, b) => cx(a) - cx(b));
      for (const seq of splitSequences(g)) axes.push({ orientation: 'cols', days: seq });
    }
    return axes;
  }

  const swap = (i) => ({ ...i, x: i.y, y: i.x, w: i.h, h: i.w, orig: i });
  const readingOrder = (a, b) => {
    const p = a.orig || a, q = b.orig || b;
    return p.y - q.y || p.x - q.x;
  };

  /**
   * Parses one table whose day labels run down the left edge.
   * `items` and `days` must already be in that orientation (see swap()).
   */
  function parseRowsTable(items, days, lineTol) {
    const centers = days.map(cy);
    const pitch = median(centers.slice(1).map((c, i) => c - centers[i])) || 40;
    const rows = days.map((d, i) => ({
      day: d.day,
      top: i === 0 ? centers[0] - pitch / 2 : (centers[i - 1] + centers[i]) / 2,
      bottom: i === days.length - 1 ? centers[i] + pitch / 2 : (centers[i] + centers[i + 1]) / 2,
    }));
    const tableTop = rows[0].top;
    const tableBottom = rows[rows.length - 1].bottom;
    const dayRight = Math.max(...days.map((d) => d.x + d.w));
    const dayLeft = Math.min(...days.map((d) => d.x));
    const rightOfDays = (i) => cx(i) > dayRight + 1;

    // Header: the closest line(s) above the first row that have several items right of the day column.
    const above = groupLines(
      items.filter((i) => rightOfDays(i) && cy(i) < tableTop && cy(i) > tableTop - 3 * pitch),
      lineTol
    ).reverse();
    const headerLines = [];
    for (const line of above) {
      const prev = headerLines[headerLines.length - 1];
      if (!prev) {
        if (line.items.length >= 3) headerLines.push(line);
        else if (tableTop - line.bottom > pitch) break;
        continue;
      }
      // Multi-line headers, e.g. "II" above "10:00-11:00".
      if (prev.top - line.bottom <= 2 * lineTol && line.items.length >= 2) headerLines.push(line);
      else break;
    }
    const headerItems = headerLines.flatMap((l) => l.items);
    const headerTop = headerLines.length ? Math.min(...headerLines.map((l) => l.top)) : tableTop;

    const dayItems = new Set(days.map((d) => d.src || (d.orig && d.orig.src)));
    const cellItems = items.filter(
      (i) => rightOfDays(i) && cy(i) >= tableTop && cy(i) < tableBottom && !dayItems.has(i.orig || i)
    );
    let cols = clusterColumns(headerItems.length >= 3 ? headerItems : cellItems);
    if (headerItems.length < 3) cols.forEach((c) => (c.label = ''));

    // Break columns: labelled as such, or spelled out one letter per row (e.g. "B R E A K").
    for (const c of cols) c.cells = [];
    // Text centred on the boundary between two periods belongs to a merged cell (e.g. a 2-hour lab).
    const colIndexFor = (it) => {
      const covered = cols.filter((c) => c.center >= it.x - 1 && c.center <= it.x + it.w + 1);
      if (covered.length >= 2) return covered;
      let i = 0;
      cols.forEach((c, k) => {
        if (Math.abs(c.center - cx(it)) < Math.abs(cols[i].center - cx(it))) i = k;
      });
      const j = cx(it) < cols[i].center ? i - 1 : i + 1;
      const neighbour = cols[j];
      if (neighbour && !BREAK_RE.test(neighbour.label) && !BREAK_RE.test(cols[i].label)) {
        const spacing = Math.abs(neighbour.center - cols[i].center);
        const boundary = (neighbour.center + cols[i].center) / 2;
        if (Math.abs(cx(it) - boundary) < 0.12 * spacing) return [cols[i], neighbour];
      }
      return [cols[i]];
    };
    const cells = new Map();
    const spans = new Map(rows.map((r) => [r.day, []]));
    for (const it of cellItems) {
      const row = rows.find((r) => cy(it) >= r.top && cy(it) < r.bottom);
      if (!row) continue;
      const targets = colIndexFor(it);
      if (targets.length >= 2) spans.get(row.day).push(targets.map((c) => cols.indexOf(c)));
      for (const col of targets) {
        col.cells.push(it);
        const key = row.day + '|' + cols.indexOf(col);
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push(it);
      }
    }
    // A merged cell's corner texts (e.g. subject top-left, room top-right) sit in different
    // columns; give every column of the merged cell the full set of texts.
    for (const [day, groups] of spans) {
      const merged = [];
      for (const g of groups) {
        const lo = Math.min(...g), hi = Math.max(...g);
        const hit = merged.find((m) => lo <= m.hi && hi >= m.lo);
        if (hit) { hit.lo = Math.min(hit.lo, lo); hit.hi = Math.max(hit.hi, hi); }
        else merged.push({ lo, hi });
      }
      for (const { lo, hi } of merged) {
        const all = new Set();
        for (let k = lo; k <= hi; k++) (cells.get(day + '|' + k) || []).forEach((i) => all.add(i));
        for (let k = lo; k <= hi; k++) cells.set(day + '|' + k, [...all]);
      }
    }
    for (const c of cols) {
      const texts = [...c.cells].sort((a, b) => a.y - b.y).map((i) => i.str.trim());
      c.isBreak =
        BREAK_RE.test(c.label) ||
        (texts.length > 0 && texts.every((t) => BREAK_RE.test(t))) ||
        (texts.length >= 2 && texts.every((t) => /^[a-z]$/i.test(t)) && BREAK_RE.test(texts.join('')));
    }

    const periodCols = cols.filter((c) => !c.isBreak);
    const breakText = cols
      .filter((c) => c.isBreak)
      .flatMap((c) => c.cells.map((i) => i.str.trim()).filter((t) => !EMPTY_CELL_RE.test(t)).map((t) => `"${t}" in ${c.label || 'break'}`));
    const schedule = Object.fromEntries(DAYS.map((d) => [d, []]));
    for (const row of rows) {
      periodCols.forEach((col, idx) => {
        const parts = cells.get(row.day + '|' + cols.indexOf(col));
        if (!parts) return;
        let label = clean([...parts].sort(readingOrder).map((i) => i.str).join(' '));
        if (!label || EMPTY_CELL_RE.test(label)) return;
        const detail = describeCell(parts);
        if (detail.className) label = [detail.subject, detail.className, detail.room].filter(Boolean).join(' · ');
        schedule[row.day].push({ period: idx + 1, label, ...detail });
      });
    }

    return {
      schedule,
      periodLabels: periodCols.map((c) => c.label),
      breakText,
      bounds: { top: headerTop, bottom: tableBottom, left: dayLeft },
    };
  }

  /**
   * Splits a cell into subject / class / room when it uses two font sizes, as aSc Timetables does:
   * small "Subject  Room" on top, the class code in large text (wrapped over lines), and an
   * optional small "Group 1". Returns {} for cells without that structure.
   */
  function describeCell(parts) {
    const heights = parts.map((i) => (i.orig || i).h);
    const maxH = Math.max(...heights);
    if (maxH / Math.min(...heights) < 1.4) return {};
    const big = [], small = [];
    for (const i of [...parts].sort(readingOrder)) {
      const s = i.str.trim();
      if ((i.orig || i).h >= 0.75 * maxH) { big.push(s); continue; }
      // "CLaBE D8-508" / "CEaRMD8-611": subject and room in one text run.
      const m = !ROOM_RE.test(s) && s.match(TRAILING_ROOM_RE);
      if (m && m[1]) small.push(m[1], m[2]);
      else small.push(s);
    }

    const classes = [];
    for (const s of big) {
      if (!classes.length || BATCH_START_RE.test(s)) classes.push(s);
      else classes[classes.length - 1] += s;
    }
    const uniq = (xs) => [...new Set(xs)];
    const rooms = uniq(small.filter((s) => ROOM_RE.test(s)));
    const groups = uniq(small.filter((s) => GROUP_RE.test(s)));
    const subjects = uniq(small.filter((s) => !ROOM_RE.test(s) && !GROUP_RE.test(s)));
    let className = uniq(classes).join(', ');
    if (groups.length) className += ` (${groups.join(', ')})`;
    return { subject: subjects.join(' / '), className, room: rooms.join(', ') };
  }

  /**
   * Same split as describeCell, but from a flat label such as "DSaA D8-515 25BA N-60 2"
   * (timetables imported before cells were split into fields).
   */
  function describeLabel(label) {
    const tokens = String(label || '').replace(/\s*·\s*/g, ' ').split(/\s+/).filter(Boolean);
    const subjects = [], rooms = [], groups = [], classes = [];
    for (let k = 0; k < tokens.length; k++) {
      const t = tokens[k];
      if (/^(group|grp|batch)$/i.test(t) && tokens[k + 1]) groups.push(`${t} ${tokens[++k]}`);
      else if (ROOM_RE.test(t)) rooms.push(t);
      else if (BATCH_START_RE.test(t)) classes.push(t);
      else if (classes.length && /^([A-Z]-\d+|\d{1,3})$/.test(t)) classes[classes.length - 1] += t;
      else {
        const m = t.match(TRAILING_ROOM_RE);
        if (m && m[1]) {
          subjects.push(m[1]);
          rooms.push(m[2]);
        } else {
          subjects.push(t);
        }
      }
    }
    if (!classes.length) return {};
    const uniq = (xs) => [...new Set(xs)];
    let className = uniq(classes).join(', ');
    if (groups.length) className += ` (${uniq(groups).join(', ')})`;
    return { subject: uniq(subjects).join(' / '), className, room: uniq(rooms).join(', ') };
  }

  function periodTime(label) {
    const m = String(label || '').match(TIME_RE);
    return m ? `${m[1]} - ${m[2]}` : '';
  }

  function findIdentity(lines) {
    let name = '';
    let department = '';
    for (const line of lines) {
      const m = line.text.match(NAME_LABEL_RE);
      if (!name && m) name = clean(m[1].replace(NAME_STOP_RE, ''));
      const d = line.text.match(DEPT_RE);
      if (!department && d) department = clean(d[1].replace(DEPT_STOP_RE, ''));
    }
    if (!name) {
      const prefixed = lines.map((l) => l.text.match(NAME_PREFIX_RE)).find(Boolean);
      if (prefixed) name = clean(prefixed[1].replace(NAME_STOP_RE, ''));
    }
    if (!name) {
      const titled = [...lines].reverse().find((l) => TITLE_RE.test(l.text.trim()));
      if (titled) name = clean(titled.text.replace(NAME_STOP_RE, ''));
    }
    const tag = name.match(TAG_RE);
    if (tag) {
      if (!department) department = clean(tag[1]);
      name = clean(name.replace(TAG_RE, ''));
    }
    let code = '';
    const c = name.match(CODE_RE);
    if (c) {
      code = c[1];
      name = clean(name.replace(CODE_RE, ''));
    }
    return { name, department, code };
  }

  /**
   * pages: [{ page, items: [{ str, x, y, w, h }] }] in top-down page coordinates.
   * Returns { faculty, periods, periodLabels, warnings }.
   */
  function parseTimetablePages(pages) {
    const found = [];
    const warnings = [];
    let periodLabels = [];
    const totalItems = pages.reduce((n, p) => n + p.items.length, 0);
    if (totalItems === 0) {
      return {
        faculty: [], periods: 0, periodLabels: [],
        warnings: ['This PDF has no selectable text — it looks like a scanned image. Export the timetable as a text PDF (e.g. from Word/Excel) and try again.'],
      };
    }

    for (const page of pages) {
      const items = page.items.filter((i) => i.str && i.str.trim());
      const lineTol = 0.6 * (median(items.map((i) => i.h)) || 10);
      const axes = findDayAxes(items);
      if (!axes.length) {
        warnings.push(`Page ${page.page}: no timetable found (no day names like Mon/Monday).`);
        continue;
      }

      const tables = axes.map((axis) => {
        const oriented = axis.orientation === 'rows' ? items : items.map(swap);
        const days = axis.orientation === 'rows' ? axis.days : axis.days.map(swap);
        const parsed = parseRowsTable(oriented, days, lineTol);
        // Bounds back in page coordinates (top edge of the table) for locating the heading above it.
        const top = axis.orientation === 'rows' ? parsed.bounds.top : Math.min(...axis.days.map((d) => d.y));
        const bottom =
          axis.orientation === 'rows'
            ? parsed.bounds.bottom
            : Math.max(...items.filter((i) => cx(i) >= Math.min(...axis.days.map((d) => d.x))).map((i) => i.y + i.h));
        return { ...parsed, top, bottom };
      });
      tables.sort((a, b) => a.top - b.top);

      const pageLines = groupLines(items, lineTol);
      tables.forEach((t, idx) => {
        const regionTop = idx === 0 ? -Infinity : tables[idx - 1].bottom;
        const heading = pageLines.filter((l) => l.cy > regionTop && l.cy < t.top);
        let { name, department, code } = findIdentity(heading);
        if (!name && tables.length === 1) {
          ({ name, department, code } = findIdentity(pageLines.filter((l) => l.cy > t.bottom)));
        }
        const count = DAYS.reduce((n, d) => n + t.schedule[d].length, 0);
        const where = tables.length > 1 ? `Page ${page.page}, table ${idx + 1}` : `Page ${page.page}`;
        if (!name) warnings.push(`${where}: faculty name not found — please type it in.`);
        if (count === 0) warnings.push(`${where}${name ? ` (${name})` : ''}: no lectures detected.`);
        if (t.breakText.length) {
          warnings.push(`${where}${name ? ` (${name})` : ''}: ignored text in break columns: ${t.breakText.join(', ')}.`);
        }
        if (t.periodLabels.length > periodLabels.length) periodLabels = t.periodLabels;
        found.push({ name, department, code, schedule: t.schedule, page: page.page, periods: t.periodLabels.length });
      });
    }

    // The same faculty can span several pages/tables; merge them by name.
    const byName = new Map();
    const faculty = [];
    for (const f of found) {
      const key = f.code ? 'code:' + f.code.toUpperCase() : normalizeName(f.name);
      const existing = key && byName.get(key);
      if (existing) {
        for (const d of DAYS) {
          for (const l of f.schedule[d]) {
            if (!existing.schedule[d].some((x) => x.period === l.period)) existing.schedule[d].push(l);
          }
          existing.schedule[d].sort((a, b) => a.period - b.period);
        }
        existing.pages.push(f.page);
        if (!existing.department) existing.department = f.department;
      } else {
        const entry = { name: f.name, department: f.department, code: f.code, schedule: f.schedule, pages: [f.page] };
        faculty.push(entry);
        if (key) byName.set(key, entry);
      }
    }

    return {
      faculty,
      periods: Math.max(0, ...found.map((f) => f.periods)),
      periodLabels,
      periodTimes: periodLabels.map(periodTime),
      warnings,
    };
  }

  function normalizeName(name) {
    return String(name || '')
      .toLowerCase()
      .replace(/\b(dr|prof|mr|mrs|ms|miss|shri|smt)\b\.?/g, '')
      .replace(/[^a-z]/g, '');
  }

  /** Reads text items (with positions) from a PDF using pdf.js. */
  async function extractPages(data, pdfjsLib) {
    const doc = await pdfjsLib.getDocument({ data }).promise;
    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items = [];
      for (const it of content.items) {
        const str = (it.str || '').trim();
        if (!str) continue;
        // Bounding box from the text's baseline direction and glyph "up" vector, so rotated text
        // (e.g. a vertical "Lunch Break" across a column) gets its real on-page extent.
        const t = pdfjsLib.Util.transform(viewport.transform, it.transform);
        const along = Math.hypot(t[0], t[1]) || 1;
        const up = Math.hypot(t[2], t[3]) || it.height || 10;
        const dx = t[0] / along, dy = t[1] / along;
        const ux = t[2] / up, uy = t[3] / up;
        const xs = [t[4], t[4] + dx * it.width, t[4] + ux * up, t[4] + dx * it.width + ux * up];
        const ys = [t[5], t[5] + dy * it.width, t[5] + uy * up, t[5] + dy * it.width + uy * up];
        const x = Math.min(...xs), y = Math.min(...ys);
        items.push({ str, x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y });
      }
      pages.push({ page: n, items });
    }
    return pages;
  }

  async function importTimetablePdf(data, pdfjsLib) {
    return parseTimetablePages(await extractPages(data, pdfjsLib));
  }

  const api = { parseTimetablePages, extractPages, importTimetablePdf, normalizeName, describeLabel };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PdfImport = api;
})(this);
