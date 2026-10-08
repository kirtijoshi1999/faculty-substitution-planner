(function () {
  const {
    DAYS, DAY_NAMES, PERIODS, dayKeyFromDate, toISO, weekStart, lecturesOn, weeklyLoad, rankSubstitutes,
    parseExemptList, matchExempt,
  } = window.Logic;
  const STORAGE_KEY = 'faculty-substitution-planner-v1';
  const REASONS = {
    absent: 'Absent',
    leave: 'On leave',
    engaged: 'Engaged in other work',
  };

  const $ = (id) => document.getElementById(id);
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  let state = load();
  let currentDate = toISO(new Date());
  let editingId = null;
  let selection = new Set();
  let adjSelection = new Set();
  let search = '';
  let pendingImport = null;

  function defaultState() {
    return {
      faculty: window.SampleData.buildSampleFaculty(),
      days: {},
      settings: { maxDayLoad: 3, maxWeeklyLoad: null, periods: PERIODS },
      source: { type: 'sample' },
      exempt: [],
    };
  }

  function migrate(s) {
    s.exempt = s.exempt || [];
    s.settings = { maxDayLoad: 3, maxWeeklyLoad: null, periods: PERIODS, ...s.settings };
    s.source = s.source || { type: 'sample' };
    s.days = s.days || {};
    for (const data of Object.values(s.days)) {
      if (!data.unavailable) {
        data.unavailable = Object.fromEntries((data.absentIds || []).map((id) => [id, 'absent']));
        delete data.absentIds;
      }
      data.assignments = data.assignments || {};
    }
    // Older imports stored only a flat label; split it into class / subject / room.
    for (const f of s.faculty) {
      for (const lectures of Object.values(f.schedule || {})) {
        lectures.forEach((l, i) => {
          if (l.className) return;
          const detail = window.PdfImport.describeLabel(l.label);
          if (!detail.className) return;
          lectures[i] = {
            ...l,
            ...detail,
            label: [detail.subject, detail.className, detail.room].filter(Boolean).join(' · '),
          };
        });
      }
    }
    return s;
  }

  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (saved && Array.isArray(saved.faculty)) return migrate(saved);
    } catch (_) { /* fall through to defaults */ }
    return defaultState();
  }

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  const periodCount = () => state.settings.periods || PERIODS;

  // ---- per-date data -------------------------------------------------------

  function dayData(date = currentDate) {
    if (!state.days[date]) state.days[date] = { unavailable: {}, assignments: {} };
    return state.days[date];
  }

  const unavailableIds = () => Object.keys(dayData().unavailable);
  const slotKey = (absentId, period) => `${absentId}:${period}`;

  function assignmentsFor(date, excludeKey) {
    const data = state.days[date];
    if (!data) return [];
    return Object.entries(data.assignments)
      .filter(([key, sub]) => sub && key !== excludeKey)
      .map(([key, substituteId]) => {
        const [absentId, period] = key.split(':');
        return { absentId, period: Number(period), substituteId };
      });
  }

  function weekAssignments(excludeKey) {
    const start = weekStart(currentDate);
    return Object.keys(state.days)
      .filter((date) => weekStart(date) === start)
      .flatMap((date) => assignmentsFor(date, date === currentDate ? excludeKey : null));
  }

  function facultyById(id) {
    return state.faculty.find((f) => f.id === id);
  }

  // ---- faculty who never take adjustments (HOD, COE, AD …) ------------------

  const exemptMatch = () => matchExempt(state.faculty, state.exempt, window.PdfImport.normalizeName);

  function exemptRoles() {
    const { byId } = exemptMatch();
    return Object.fromEntries(Object.entries(byId).map(([id, e]) => [id, e.role]));
  }

  function sameEntry(a, b) {
    const n = window.PdfImport.normalizeName;
    return (a.code && a.code === b.code) || (a.name && b.name && n(a.name) === n(b.name));
  }

  function addExempt(entries) {
    let added = 0;
    for (const e of entries) {
      const existing = state.exempt.find((x) => sameEntry(x, e));
      if (existing) {
        if (e.role) existing.role = e.role;
        if (e.code) existing.code = e.code;
        if (e.name && !existing.name) existing.name = e.name;
      } else {
        state.exempt.push(e);
        added++;
      }
    }
    save();
    render();
    return added;
  }

  function renderExempt() {
    const { byId, unmatched } = exemptMatch();
    const label = (e) => e.name || e.code;
    const matched = Object.entries(byId)
      .map(([id, e]) => ({ f: facultyById(id), e }))
      .sort((a, b) => a.f.name.localeCompare(b.f.name));
    const indexOf = (e) => state.exempt.indexOf(e);
    $('exemptChips').innerHTML =
      matched
        .map(
          ({ f, e }) => `<span class="chip exempt">${esc(f.name)}${e.role ? ` <small>${esc(e.role)}</small>` : ''}
            <button data-exempt-remove="${indexOf(e)}" title="Allow adjustments again">×</button></span>`
        )
        .join('') +
      unmatched
        .map(
          (e) => `<span class="chip unmatched" title="Not found in the current timetable">${esc(label(e))}${
            e.role ? ` <small>${esc(e.role)}</small>` : ''
          } <small>· not in timetable</small>
            <button data-exempt-remove="${indexOf(e)}" title="Remove">×</button></span>`
        )
        .join('') ||
      `<span class="muted">No one yet — upload or add the HOD / COE / AD names.</span>`;

    const options = state.faculty
      .filter((f) => !byId[f.id])
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((f) => `<option value="${f.id}">${esc(f.name)}${f.code ? ` (${esc(f.code)})` : ''}</option>`);
    $('exemptPick').innerHTML = `<option value="">— Choose faculty —</option>${options.join('')}`;
    $('exemptDownloadBtn').disabled = $('exemptClearBtn').disabled = state.exempt.length === 0;
  }

  function uploadExempt(file) {
    if (/\.xlsx?$/i.test(file.name)) {
      alert('Excel files can’t be read directly. In Excel use File → Save As → CSV, then upload the .csv file.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const entries = parseExemptList(reader.result);
      if (!entries.length) {
        alert(`No names found in ${file.name}. Put one person per line: Name, Employee code, Role.`);
        return;
      }
      addExempt(entries);
      const { unmatched } = exemptMatch();
      const missing = unmatched.filter((e) => entries.some((x) => sameEntry(x, e)));
      alert(
        `Added ${entries.length - missing.length} of ${entries.length} name(s) from ${file.name}.` +
          (missing.length ? `\n\nNot found in the timetable (check spelling or add the employee code):\n${missing.map((e) => '• ' + (e.name || e.code)).join('\n')}` : '')
      );
    };
    reader.readAsText(file);
  }

  function downloadExempt() {
    const q = (s) => `"${String(s || '').replace(/"/g, '""')}"`;
    const csv = ['Name,Emp Code,Role', ...state.exempt.map((e) => [e.name, e.code, e.role].map(q).join(','))].join('\r\n');
    window.Sheet.download(new Blob(['\ufeff' + csv], { type: 'text/csv' }), 'no-adjustment-list.csv');
  }

  function rank({ period = null, excludeKey = null } = {}) {
    return rankSubstitutes(state.faculty, {
      exempt: exemptRoles(),
      day: dayKeyFromDate(currentDate),
      absentIds: unavailableIds(),
      adjustments: assignmentsFor(currentDate, excludeKey),
      weekAdjustments: weekAssignments(excludeKey),
      maxDayLoad: state.settings.maxDayLoad,
      maxWeeklyLoad: state.settings.maxWeeklyLoad,
      periods: periodCount(),
      period,
    });
  }

  function slotsToAdjust() {
    const day = dayKeyFromDate(currentDate);
    return unavailableIds()
      .map(facultyById)
      .filter(Boolean)
      .flatMap((f) => lecturesOn(f, day).map((l) => ({ absent: f, ...l })))
      .sort((a, b) => a.period - b.period || a.absent.name.localeCompare(b.absent.name));
  }

  // ---- rendering -----------------------------------------------------------

  function render() {
    const day = dayKeyFromDate(currentDate);
    $('dateInput').value = currentDate;
    $('dayLabel').textContent = DAY_NAMES[day];
    $('dayLabel2').textContent = `· ${DAY_NAMES[day]}, ${currentDate}`;
    $('maxDayLoad').value = state.settings.maxDayLoad;
    $('maxWeeklyLoad').value = state.settings.maxWeeklyLoad ?? '';
    $('periodsPerDay').value = periodCount();

    renderUploadStatus();
    renderChecklist();
    renderChips(day);
    renderExempt();
    renderAdjustments(day);
    updateClearButtons();
    renderSubstitutes(day);
    renderSchedule();
    renderFacultyTable();
    if (window.RoomsUI) window.RoomsUI.render();
  }

  function renderUploadStatus(message, kind) {
    const el = $('uploadStatus');
    if (message) {
      el.innerHTML = `<span class="status-${kind}">${esc(message)}</span>`;
      return;
    }
    const src = state.source;
    el.innerHTML =
      src.type === 'pdf'
        ? `<span class="status-ok">Loaded ${state.faculty.length} faculty from <strong>${esc(src.fileName)}</strong> on ${esc(
            new Date(src.importedAt).toLocaleString()
          )}.</span>`
        : `<span class="notice">Showing sample data. Upload your timetable PDF to replace it — try <code>samples/sample-timetable.pdf</code>.</span>`;
  }

  function renderChecklist() {
    const day = dayKeyFromDate(currentDate);
    const off = dayData().unavailable;
    const roles = exemptRoles();
    const q = search.trim().toLowerCase();
    const list = state.faculty
      .filter((f) => !off[f.id])
      .filter((f) => !q || [f.name, f.department, f.code].some((v) => (v || '').toLowerCase().includes(q)))
      .sort((a, b) => a.name.localeCompare(b.name));

    $('facultyChecklist').innerHTML = list.length
      ? list
          .map((f) => {
            const checked = selection.has(f.id);
            return `<label class="check-item ${checked ? 'checked' : ''}">
              <input type="checkbox" data-select="${f.id}" ${checked ? 'checked' : ''} />
              <span class="name" title="${esc(f.name)}">${esc(f.name)}</span>
              <span class="meta">${f.id in roles ? `<span class="badge plus">${esc(roles[f.id] || 'No adj.')}</span> ` : ''}${esc(f.department)} · ${lecturesOn(f, day).length} today</span>
            </label>`;
          })
          .join('')
      : `<div class="empty">${q ? 'No faculty match your search.' : 'Everyone is already marked unavailable.'}</div>`;

    $('selectedCount').textContent = selection.size ? `${selection.size} selected` : 'Tick one or more faculty';
    $('markSelectedBtn').disabled = selection.size === 0;
  }

  function renderChips(day) {
    const off = dayData().unavailable;
    $('absentChips').innerHTML = Object.entries(off)
      .map(([id, reason]) => [facultyById(id), reason])
      .filter(([f]) => f)
      .sort(([a], [b]) => a.name.localeCompare(b.name))
      .map(
        ([f, reason]) =>
          `<span class="chip reason-${reason}">${esc(f.name)} <small>${REASONS[reason] || reason} · ${lecturesOn(f, day).length} lecture(s)</small>
            <button data-remove-absent="${f.id}" title="Remove">×</button></span>`
      )
      .join('');
  }

  function renderAdjustments(day) {
    const el = $('adjustments');
    if (!DAYS.includes(day)) {
      el.innerHTML = `<div class="empty">No lectures are scheduled on ${DAY_NAMES[day]}.</div>`;
      return;
    }
    if (unavailableIds().length === 0) {
      el.innerHTML = `<div class="empty">Mark faculty as absent or engaged to see the lectures that need adjustment.</div>`;
      return;
    }
    const slots = slotsToAdjust();
    if (slots.length === 0) {
      el.innerHTML = `<div class="empty">The selected faculty have no lectures on ${DAY_NAMES[day]}.</div>`;
      return;
    }

    const { assignments, unavailable } = dayData();
    const rows = slots.map((s) => {
      const key = slotKey(s.absent.id, s.period);
      const current = assignments[key] || '';
      const candidates = rank({ period: s.period, excludeKey: key }).filter((r) => r.eligible);
      const options = candidates.map(
        (r, i) =>
          `<option value="${r.faculty.id}" ${r.faculty.id === current ? 'selected' : ''}>
            ${i === 0 ? '★ ' : ''}${esc(r.faculty.name)} — ${r.dayLoad} today, ${r.weeklyLoad}/week</option>`
      );
      // Keep a stale assignment visible so the user can see and clear it.
      if (current && !candidates.some((r) => r.faculty.id === current)) {
        const f = facultyById(current);
        options.unshift(`<option value="${current}" selected>⚠ ${esc(f ? f.name : current)} (no longer eligible)</option>`);
      }
      const status = current
        ? `<span class="badge ok">Assigned</span>
           <button class="icon-btn" data-clear="${key}" title="Clear this assignment">✕</button>`
        : candidates.length
          ? `<span class="badge plus">${candidates.length} available</span>`
          : `<span class="badge no">No one free</span>`;
      return `<tr class="${current ? 'assigned' : ''}">
        <td><input type="checkbox" data-pick="${key}" ${adjSelection.has(key) ? 'checked' : ''} ${current ? '' : 'disabled'} /></td>
        <td><strong>P${s.period}</strong></td>
        <td>${esc(s.label)}</td>
        <td>${esc(s.absent.name)}</td>
        <td>${REASONS[unavailable[s.absent.id]] || ''}</td>
        <td><select data-slot="${key}">
          <option value="">— Select substitute —</option>${options.join('')}
        </select></td>
        <td>${status}</td>
      </tr>`;
    });

    const assignedKeys = slots.map((s) => slotKey(s.absent.id, s.period)).filter((k) => assignments[k]);
    const allPicked = assignedKeys.length > 0 && assignedKeys.every((k) => adjSelection.has(k));
    el.innerHTML = `<table class="data">
      <thead><tr>
        <th><input type="checkbox" id="pickAll" title="Select all assigned" ${allPicked ? 'checked' : ''} ${assignedKeys.length ? '' : 'disabled'} /></th>
        <th>Period</th><th>Class / Subject</th><th>Faculty</th><th>Reason</th><th>Substitute (best first)</th><th>Status</th>
      </tr></thead>
      <tbody>${rows.join('')}</tbody></table>`;
  }

  function updateClearButtons() {
    const { assignments } = dayData();
    const assigned = Object.values(assignments).filter(Boolean).length;
    const picked = [...adjSelection].filter((k) => assignments[k]).length;
    $('clearSelectedBtn').disabled = picked === 0;
    $('clearSelectedBtn').textContent = picked ? `Clear selected (${picked})` : 'Clear selected';
    $('clearAllBtn').disabled = assigned === 0;
  }

  // ---- adjustment schedule (the shareable sheet) ---------------------------

  const { formatDate } = window.Sheet;

  function scheduleSpec() {
    const { assignments } = dayData();
    const times = state.settings.periodTimes || [];
    const groups = new Map();
    for (const s of slotsToAdjust()) {
      const sub = facultyById(assignments[slotKey(s.absent.id, s.period)]);
      if (!sub) continue;
      if (!groups.has(s.absent.id)) groups.set(s.absent.id, { label: s.absent.name, rows: [] });
      groups.get(s.absent.id).rows.push([
        sub.name,
        s.className || s.label,
        s.subject || '',
        times[s.period - 1] || `Period ${s.period}`,
        s.room || '',
      ]);
    }
    return {
      title: `Adjustment Schedule: ${formatDate(currentDate)}`,
      headers: ['Adjustment For', 'Adjusted By', 'Class', 'Subject', 'Time', 'Room No.'],
      groups: [...groups.values()],
      fileName: `adjustment-schedule-${currentDate}`,
    };
  }

  function renderSchedule() {
    const spec = scheduleSpec();
    const pending = slotsToAdjust().filter((s) => !dayData().assignments[slotKey(s.absent.id, s.period)]).length;
    const hasRows = spec.groups.length > 0;
    $('schedule').innerHTML = hasRows
      ? window.Sheet.sheetHtml(spec)
      : `<div class="empty">Assign substitutes above and the adjustment schedule will appear here.</div>`;
    const notes = [];
    if (pending) notes.push(`${pending} lecture(s) still have no substitute and are not included yet.`);
    if (hasRows && !(state.settings.periodTimes || []).some(Boolean)) {
      notes.push('Period times are missing because this timetable was imported with an older version — upload the timetable PDF again (step 1) to show times like 9:30 - 10:20.');
    }
    $('scheduleNote').textContent = notes.join(' ');
    ['printScheduleBtn', 'excelScheduleBtn', 'imageScheduleBtn', 'copyScheduleBtn'].forEach((id) => ($(id).disabled = !hasRows));
  }

  function loadBar(value, max) {
    const pct = Math.min(100, (value / max) * 100);
    const cls = pct >= 75 ? 'high' : pct >= 50 ? 'mid' : '';
    return `<div class="bar ${cls}"><i style="width:${pct}%"></i></div>`;
  }

  function periodStrip(row, day) {
    const own = new Set(lecturesOn(row.faculty, day).map((l) => l.period));
    let html = '';
    for (let p = 1; p <= periodCount(); p++) {
      const cls = own.has(p) ? 'busy' : row.freePeriods.includes(p) ? '' : 'extra';
      const title = own.has(p) ? 'Own lecture' : cls === 'extra' ? 'Adjustment assigned' : 'Free';
      html += `<span class="${cls}" title="P${p}: ${title}">${p}</span>`;
    }
    return `<div class="periods">${html}</div>`;
  }

  function renderSubstitutes(day) {
    const el = $('substitutes');
    const wrap = $('unavailableWrap');
    if (!DAYS.includes(day)) {
      el.innerHTML = `<div class="empty">No lectures are scheduled on ${DAY_NAMES[day]}.</div>`;
      wrap.hidden = true;
      return;
    }
    const rows = rank();
    const eligible = rows.filter((r) => r.eligible);
    const unavailable = rows.filter((r) => !r.eligible);
    const maxWeek = Math.max(1, ...rows.map((r) => r.weeklyLoad));
    const { maxDayLoad } = state.settings;

    el.innerHTML = eligible.length
      ? `<table class="data">
          <thead><tr><th>Rank</th><th>Faculty</th><th>Dept</th><th>Lectures today</th><th>Weekly load</th><th>Periods (1–${periodCount()})</th></tr></thead>
          <tbody>${eligible
            .map(
              (r, i) => `<tr>
                <td><span class="rank ${i === 0 ? 'top' : ''}">${i + 1}</span></td>
                <td><strong>${esc(r.faculty.name)}</strong></td>
                <td>${esc(r.faculty.department)}</td>
                <td><div class="load">${loadBar(r.dayLoad, periodCount())} ${r.dayLoad} / ${maxDayLoad}</div></td>
                <td><div class="load">${loadBar(r.weeklyLoad, maxWeek)} ${r.weeklyLoad}</div></td>
                <td>${periodStrip(r, day)}</td>
              </tr>`
            )
            .join('')}</tbody></table>`
      : `<div class="empty">No faculty member has ${maxDayLoad} or fewer lectures on ${DAY_NAMES[day]}.</div>`;

    wrap.hidden = unavailable.length === 0;
    $('unavailableSummary').textContent = `Not available (${unavailable.length})`;
    $('unavailable').innerHTML = `<table class="data">
      <thead><tr><th>Faculty</th><th>Dept</th><th>Lectures today</th><th>Weekly load</th><th>Reason</th></tr></thead>
      <tbody>${unavailable
        .map(
          (r) => `<tr>
            <td>${esc(r.faculty.name)}</td>
            <td>${esc(r.faculty.department)}</td>
            <td>${r.dayLoad}</td>
            <td>${r.weeklyLoad}</td>
            <td><span class="badge no">${esc(r.reasons.join('; '))}</span></td>
          </tr>`
        )
        .join('')}</tbody></table>`;
  }

  function renderFacultyTable() {
    const rows = state.faculty.map(
      (f) => `<tr>
        <td><strong>${esc(f.name)}</strong>${f.code ? ` <span class="muted">${esc(f.code)}</span>` : ''}</td>
        <td>${esc(f.department)}</td>
        ${DAYS.map((d) => `<td>${lecturesOn(f, d).length}</td>`).join('')}
        <td><strong>${weeklyLoad(f)}</strong></td>
        <td class="inline">
          <button class="btn small" data-edit="${f.id}">Edit</button>
          <button class="btn small danger" data-delete="${f.id}">Delete</button>
        </td>
      </tr>`
    );
    $('facultyTable').innerHTML = state.faculty.length
      ? `<table class="data">
          <thead><tr><th>Name</th><th>Dept</th>${DAYS.map((d) => `<th>${d}</th>`).join('')}<th>Week</th><th></th></tr></thead>
          <tbody>${rows.join('')}</tbody></table>`
      : `<div class="empty">No faculty yet. Upload a timetable PDF or click “Add faculty”.</div>`;
  }

  // ---- unavailable faculty -------------------------------------------------

  function markSelected(reason) {
    const data = dayData();
    for (const id of selection) {
      data.unavailable[id] = reason;
      // Someone who is away can't cover anyone else's lecture that day.
      for (const [key, sub] of Object.entries(data.assignments)) {
        if (sub === id) delete data.assignments[key];
      }
    }
    selection.clear();
    save();
    render();
  }

  function removeUnavailable(id) {
    const data = dayData();
    delete data.unavailable[id];
    for (const key of Object.keys(data.assignments)) {
      if (key.startsWith(id + ':')) delete data.assignments[key];
    }
    save();
    render();
  }

  function clearAssignments(keys) {
    const { assignments } = dayData();
    keys.forEach((k) => {
      delete assignments[k];
      adjSelection.delete(k);
    });
    save();
    render();
  }

  function clearAll() {
    const keys = Object.keys(dayData().assignments);
    if (!keys.length || !confirm(`Clear all ${keys.length} assignment(s) for ${formatDate(currentDate)}?`)) return;
    clearAssignments(keys);
  }

  function autoAssign() {
    const { assignments } = dayData();
    const day = dayKeyFromDate(currentDate);
    for (const s of slotsToAdjust()) {
      const key = slotKey(s.absent.id, s.period);
      if (assignments[key]) continue;
      const eligible = rank({ period: s.period, excludeKey: key }).filter((r) => r.eligible);
      // Keep the same substitute across consecutive periods of one lab/session.
      const neighbourSubs = lecturesOn(s.absent, day)
        .filter((l) => Math.abs(l.period - s.period) === 1 && l.label === s.label)
        .map((l) => assignments[slotKey(s.absent.id, l.period)])
        .filter(Boolean);
      const best = eligible.find((r) => neighbourSubs.includes(r.faculty.id)) || eligible[0];
      if (best) assignments[key] = best.faculty.id;
    }
    save();
    render();
  }

  // ---- PDF import ----------------------------------------------------------

  async function handlePdf(file) {
    if (!file) return;
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
      renderUploadStatus('Please choose a PDF file.', 'error');
      return;
    }
    const zone = $('dropZone');
    zone.classList.add('busy');
    renderUploadStatus(`Reading ${file.name}…`, 'ok');
    try {
      const data = new Uint8Array(await file.arrayBuffer());
      const result = await window.PdfImport.importTimetablePdf(data, window.pdfjsLib);
      if (!result.faculty.length) {
        renderUploadStatus(
          `No faculty timetables found in ${file.name}. ${result.warnings.join(' ')}`,
          'error'
        );
        return;
      }
      pendingImport = {
        fileName: file.name,
        periods: result.periods,
        periodLabels: result.periodLabels,
        periodTimes: result.periodTimes,
        warnings: result.warnings,
        rows: result.faculty.map((f) => ({ ...f, include: true, open: false })),
      };
      renderUploadStatus();
      openReview();
    } catch (err) {
      console.error(err);
      renderUploadStatus(`Could not read ${file.name}: ${err.message}`, 'error');
    } finally {
      zone.classList.remove('busy');
    }
  }

  function maxPeriodIn(schedule) {
    return Math.max(0, ...DAYS.flatMap((d) => (schedule[d] || []).map((l) => l.period)));
  }

  function openReview() {
    const p = pendingImport;
    const pages = new Set(p.rows.flatMap((r) => r.pages));
    const labels = p.periodLabels.filter(Boolean);
    $('reviewSummary').innerHTML = `Found <strong>${p.rows.length}</strong> faculty timetable(s) on ${pages.size} page(s) of
      <strong>${esc(p.fileName)}</strong>, with <strong>${p.periods}</strong> lecture periods per day${
        labels.length ? ` (${labels.map(esc).join(', ')})` : ''
      }. Break and lunch columns were skipped. Check the names and counts, then import.`;
    $('reviewWarnings').innerHTML = p.warnings.map((w) => `<li>${esc(w)}</li>`).join('');
    renderReviewTable();
    $('reviewDialog').showModal();
  }

  function renderReviewTable() {
    const p = pendingImport;
    const periods = Math.max(p.periods, ...p.rows.map((r) => maxPeriodIn(r.schedule)));
    const rows = p.rows.map((r, i) => {
      const counts = DAYS.map((d) => r.schedule[d].length);
      let html = `<tr class="${r.include ? '' : 'excluded'}">
        <td><input type="checkbox" data-include="${i}" ${r.include ? 'checked' : ''} /></td>
        <td><input type="text" data-field="name" data-row="${i}" value="${esc(r.name)}" placeholder="Faculty name" /></td>
        <td class="muted">${esc(r.code || '')}</td>
        <td><input type="text" data-field="department" data-row="${i}" value="${esc(r.department)}" placeholder="Dept" /></td>
        ${counts.map((c) => `<td>${c}</td>`).join('')}
        <td><strong>${counts.reduce((a, b) => a + b, 0)}</strong></td>
        <td>${r.pages.join(', ')}</td>
        <td><button class="btn small" data-toggle="${i}">${r.open ? 'Hide' : 'View'}</button></td>
      </tr>`;
      if (r.open) {
        const head = Array.from({ length: periods }, (_, k) => `<th>P${k + 1}${p.periodLabels[k] ? `<br>${esc(p.periodLabels[k])}` : ''}</th>`).join('');
        const body = DAYS.map((d) => {
          const byPeriod = Object.fromEntries(r.schedule[d].map((l) => [l.period, l.label]));
          const cells = Array.from({ length: periods }, (_, k) =>
            byPeriod[k + 1] ? `<td class="has">${esc(byPeriod[k + 1])}</td>` : '<td></td>'
          ).join('');
          return `<tr><th>${d}</th>${cells}</tr>`;
        }).join('');
        html += `<tr class="preview-grid"><td colspan="${DAYS.length + 7}">
          <table class="mini-grid"><tr><th></th>${head}</tr>${body}</table></td></tr>`;
      }
      return html;
    });
    $('reviewTable').innerHTML = `<table class="data">
      <thead><tr><th></th><th>Name</th><th>Code</th><th>Dept</th>${DAYS.map((d) => `<th>${d}</th>`).join('')}<th>Week</th><th>Page</th><th></th></tr></thead>
      <tbody>${rows.join('')}</tbody></table>`;
  }

  function confirmImport() {
    const p = pendingImport;
    const rows = p.rows.filter((r) => r.include);
    if (!rows.length) {
      alert('Select at least one faculty timetable to import.');
      return;
    }
    const unnamed = rows.find((r) => !r.name.trim());
    if (unnamed) {
      alert(`Please enter a name for the timetable on page ${unnamed.pages.join(', ')}.`);
      return;
    }
    const mode = document.querySelector('input[name="importMode"]:checked').value;
    const stamp = Date.now().toString(36);
    const toFaculty = (r, i) => ({
      id: `f${stamp}${i}`,
      name: r.name.trim(),
      code: r.code || '',
      department: r.department.trim(),
      schedule: r.schedule,
    });
    const detected = Math.max(p.periods, ...rows.map((r) => maxPeriodIn(r.schedule)));
    if (p.periodTimes.some(Boolean)) state.settings.periodTimes = p.periodTimes;

    const { normalizeName } = window.PdfImport;
    const findExisting = (r) =>
      state.faculty.find((f) =>
        r.code && f.code
          ? f.code.toUpperCase() === r.code.toUpperCase()
          : normalizeName(f.name) === normalizeName(r.name)
      );

    if (mode === 'replace') {
      // Re-use ids of faculty already known, so absences and assignments survive a re-upload.
      state.faculty = rows.map((r, i) => {
        const existing = findExisting(r);
        return existing ? { ...toFaculty(r, i), id: existing.id } : toFaculty(r, i);
      });
      const ids = new Set(state.faculty.map((f) => f.id));
      for (const data of Object.values(state.days)) {
        for (const id of Object.keys(data.unavailable)) if (!ids.has(id)) delete data.unavailable[id];
        for (const [key, sub] of Object.entries(data.assignments)) {
          if (!ids.has(sub) || !ids.has(key.split(':')[0])) delete data.assignments[key];
        }
      }
      state.settings.periods = detected || PERIODS;
    } else {
      rows.forEach((r, i) => {
        const existing = findExisting(r);
        if (existing) {
          existing.schedule = r.schedule;
          existing.name = r.name.trim();
          if (r.code) existing.code = r.code;
          if (r.department.trim()) existing.department = r.department.trim();
        } else {
          state.faculty.push(toFaculty(r, i));
        }
      });
      state.settings.periods = Math.max(periodCount(), detected);
    }
    state.source = { type: 'pdf', fileName: p.fileName, importedAt: new Date().toISOString() };
    pendingImport = null;
    selection.clear();
    $('reviewDialog').close();
    save();
    render();
  }

  // ---- faculty editor ------------------------------------------------------

  function openEditor(id) {
    editingId = id;
    const f = id ? facultyById(id) : { name: '', department: '', schedule: {} };
    const periods = Math.max(periodCount(), maxPeriodIn(f.schedule));
    $('dialogTitle').textContent = id ? 'Edit faculty' : 'Add faculty';
    $('fName').value = f.name;
    $('fDept').value = f.department;

    let html = `<tr><th></th>${Array.from({ length: periods }, (_, i) => `<th>P${i + 1}</th>`).join('')}</tr>`;
    for (const day of DAYS) {
      const byPeriod = Object.fromEntries(lecturesOn(f, day).map((l) => [l.period, l.label]));
      html += `<tr><th>${day}</th>`;
      for (let p = 1; p <= periods; p++) {
        html += `<td><input data-day="${day}" data-period="${p}" placeholder="free" value="${esc(byPeriod[p] || '')}" /></td>`;
      }
      html += '</tr>';
    }
    $('ttGrid').innerHTML = html;
    $('facultyDialog').showModal();
  }

  function saveEditor() {
    const before = editingId ? facultyById(editingId).schedule || {} : {};
    const schedule = Object.fromEntries(DAYS.map((d) => [d, []]));
    $('ttGrid')
      .querySelectorAll('input')
      .forEach((input) => {
        const label = input.value.trim();
        if (!label) return;
        const day = input.dataset.day;
        const period = Number(input.dataset.period);
        // Keep the imported class/subject/room when the cell text wasn't changed.
        const old = (before[day] || []).find((l) => l.period === period);
        schedule[day].push(old && old.label === label ? old : { period, label });
      });
    const data = { name: $('fName').value.trim(), department: $('fDept').value.trim(), schedule };
    if (editingId) {
      Object.assign(facultyById(editingId), data);
    } else {
      state.faculty.push({ id: 'f' + Date.now().toString(36), ...data });
    }
    save();
    render();
  }

  function deleteFaculty(id) {
    const f = facultyById(id);
    if (!f || !confirm(`Delete ${f.name}?`)) return;
    state.faculty = state.faculty.filter((x) => x.id !== id);
    selection.delete(id);
    for (const data of Object.values(state.days)) {
      delete data.unavailable[id];
      for (const [key, sub] of Object.entries(data.assignments)) {
        if (sub === id || key.startsWith(id + ':')) delete data.assignments[key];
      }
    }
    save();
    render();
  }

  // ---- backup --------------------------------------------------------------

  function exportData() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'faculty-data.json';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function importData(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!Array.isArray(data.faculty)) throw new Error('Missing "faculty" array');
        state = migrate({ ...defaultState(), ...data });
        selection.clear();
        save();
        render();
      } catch (err) {
        alert('Could not import file: ' + err.message);
      }
    };
    reader.readAsText(file);
  }

  // ---- events --------------------------------------------------------------

  $('reasonSelect').innerHTML = Object.entries(REASONS)
    .map(([value, label]) => `<option value="${value}">${label}</option>`)
    .join('');

  $('pdfInput').addEventListener('change', (e) => {
    handlePdf(e.target.files[0]);
    e.target.value = '';
  });
  const zone = $('dropZone');
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('dragging');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragging'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('dragging');
    handlePdf(e.dataTransfer.files[0]);
  });

  $('reviewTable').addEventListener('input', (e) => {
    const { field, row } = e.target.dataset;
    if (field) pendingImport.rows[row][field] = e.target.value;
  });
  $('reviewTable').addEventListener('change', (e) => {
    const idx = e.target.dataset.include;
    if (idx == null) return;
    pendingImport.rows[idx].include = e.target.checked;
    renderReviewTable();
  });
  $('reviewTable').addEventListener('click', (e) => {
    const idx = e.target.dataset.toggle;
    if (idx == null) return;
    pendingImport.rows[idx].open = !pendingImport.rows[idx].open;
    renderReviewTable();
  });
  $('cancelReview').addEventListener('click', () => {
    pendingImport = null;
    $('reviewDialog').close();
  });
  $('confirmReview').addEventListener('click', confirmImport);

  $('dateInput').addEventListener('change', (e) => {
    if (!e.target.value) return;
    currentDate = e.target.value;
    selection.clear();
    adjSelection.clear();
    render();
  });
  $('facultySearch').addEventListener('input', (e) => {
    search = e.target.value;
    renderChecklist();
  });
  $('facultyChecklist').addEventListener('change', (e) => {
    const id = e.target.dataset.select;
    if (!id) return;
    if (e.target.checked) selection.add(id);
    else selection.delete(id);
    renderChecklist();
  });
  $('selectNoneBtn').addEventListener('click', () => {
    selection.clear();
    renderChecklist();
  });
  $('markSelectedBtn').addEventListener('click', () => markSelected($('reasonSelect').value));
  $('absentChips').addEventListener('click', (e) => {
    const id = e.target.dataset.removeAbsent;
    if (id) removeUnavailable(id);
  });

  $('exemptFile').addEventListener('change', (e) => {
    if (e.target.files[0]) uploadExempt(e.target.files[0]);
    e.target.value = '';
  });
  $('exemptDownloadBtn').addEventListener('click', downloadExempt);
  $('exemptClearBtn').addEventListener('click', () => {
    if (!confirm(`Remove all ${state.exempt.length} name(s) from the no-adjustment list?`)) return;
    state.exempt = [];
    save();
    render();
  });
  $('exemptAddBtn').addEventListener('click', () => {
    const f = facultyById($('exemptPick').value);
    if (!f) return;
    addExempt([{ name: f.name, code: (f.code || '').toUpperCase(), role: $('exemptRole').value.trim() }]);
    $('exemptRole').value = '';
  });
  $('exemptPasteBtn').addEventListener('click', () => {
    const entries = parseExemptList($('exemptText').value);
    if (!entries.length) return;
    addExempt(entries);
    $('exemptText').value = '';
  });
  $('exemptChips').addEventListener('click', (e) => {
    const i = e.target.dataset.exemptRemove;
    if (i == null) return;
    state.exempt.splice(Number(i), 1);
    save();
    render();
  });

  $('adjustments').addEventListener('change', (e) => {
    if (e.target.id === 'pickAll') {
      const { assignments } = dayData();
      const keys = slotsToAdjust().map((s) => slotKey(s.absent.id, s.period)).filter((k) => assignments[k]);
      keys.forEach((k) => (e.target.checked ? adjSelection.add(k) : adjSelection.delete(k)));
      render();
      return;
    }
    const pick = e.target.dataset.pick;
    if (pick) {
      if (e.target.checked) adjSelection.add(pick);
      else adjSelection.delete(pick);
      render();
      return;
    }
    const key = e.target.dataset.slot;
    if (!key) return;
    if (e.target.value) dayData().assignments[key] = e.target.value;
    else {
      delete dayData().assignments[key];
      adjSelection.delete(key);
    }
    save();
    render();
  });
  $('adjustments').addEventListener('click', (e) => {
    const key = e.target.dataset.clear;
    if (key) clearAssignments([key]);
  });
  $('autoAssignBtn').addEventListener('click', autoAssign);
  $('clearSelectedBtn').addEventListener('click', () => clearAssignments([...adjSelection]));
  $('clearAllBtn').addEventListener('click', clearAll);
  $('printScheduleBtn').addEventListener('click', () => window.Sheet.print($('scheduleCard')));
  $('excelScheduleBtn').addEventListener('click', () => window.Sheet.excel(scheduleSpec()));
  $('imageScheduleBtn').addEventListener('click', () => window.Sheet.image(scheduleSpec()));
  $('copyScheduleBtn').addEventListener('click', (e) => window.Sheet.copy(scheduleSpec(), e.target));
  $('maxDayLoad').addEventListener('change', (e) => {
    state.settings.maxDayLoad = Math.max(0, Number(e.target.value) || 0);
    save();
    render();
  });
  $('maxWeeklyLoad').addEventListener('change', (e) => {
    state.settings.maxWeeklyLoad = e.target.value === '' ? null : Math.max(0, Number(e.target.value));
    save();
    render();
  });
  $('periodsPerDay').addEventListener('change', (e) => {
    state.settings.periods = Math.min(12, Math.max(1, Number(e.target.value) || PERIODS));
    save();
    render();
  });

  $('facultyTable').addEventListener('click', (e) => {
    if (e.target.dataset.edit) openEditor(e.target.dataset.edit);
    if (e.target.dataset.delete) deleteFaculty(e.target.dataset.delete);
  });
  $('addFacultyBtn').addEventListener('click', () => openEditor(null));
  $('cancelDialog').addEventListener('click', () => $('facultyDialog').close());
  $('facultyForm').addEventListener('submit', saveEditor);
  $('exportBtn').addEventListener('click', exportData);
  $('importInput').addEventListener('change', (e) => {
    if (e.target.files[0]) importData(e.target.files[0]);
    e.target.value = '';
  });
  $('resetBtn').addEventListener('click', () => {
    if (!confirm('Replace all faculty, absences and adjustments with the sample data?')) return;
    const { rooms, sections, roomBlocks, roomShifts, exempt } = state;
    state = { ...defaultState(), rooms, sections, roomBlocks, roomShifts, exempt };
    selection.clear();
    save();
    render();
  });

  window.App = {
    get state() { return state; },
    save,
    render,
    periodCount,
  };

  render();
})();
