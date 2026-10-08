(function () {
  const { DAY_NAMES, dayKeyFromDate, toISO } = window.Logic;
  const R = window.RoomLogic;
  const { esc, formatDate } = window.Sheet;
  const App = window.App;
  const $ = (id) => document.getElementById(id);

  const SUBTITLES = {
    faculty: 'Upload the faculty timetable, mark who is absent or engaged, and find the least-loaded colleagues to take their lectures.',
    rooms: 'Block rooms for events or workshops and shift their classes to free rooms, using the classroom-wise and section-wise timetables.',
  };
  const KIND_INFO = {
    room: { key: 'rooms', noun: 'room', looksRight: (n) => /^[A-Z]+\d*-\d/.test(n) },
    section: { key: 'sections', noun: 'section', looksRight: (n) => /^\d{2}[A-Z]+-\d/.test(n) },
  };

  let roomSel = new Set();
  let roomSearch = '';
  let shiftSel = new Set();
  let scheduleDate = null;
  const today = toISO(new Date());

  function st() {
    const s = App.state;
    s.rooms = s.rooms || null;
    s.sections = s.sections || null;
    s.roomBlocks = s.roomBlocks || [];
    s.roomShifts = s.roomShifts || {};
    return s;
  }

  const periodCount = () => App.periodCount();
  const periodTime = (p) => (st().settings.periodTimes || [])[p - 1] || '';
  const periodLabel = (p) => (periodTime(p) ? `P${p} · ${periodTime(p)}` : `P${p}`);
  const shortDate = (iso) => `${formatDate(iso).slice(0, 5)} ${dayKeyFromDate(iso)}`;
  const allPeriods = () => Array.from({ length: periodCount() }, (_, i) => i + 1);

  /** The "Time" dropdown (Full day / One period / Few periods) with its period selects, by id prefix. */
  function timeWidget(prefix) {
    const scope = $(prefix + 'Scope'), from = $(prefix + 'PFrom'), to = $(prefix + 'PTo');
    return {
      render() {
        const fill = (sel, fallback) => {
          const v = Number(sel.value) || fallback;
          sel.innerHTML = allPeriods()
            .map((p) => `<option value="${p}" ${p === v ? 'selected' : ''}>${esc(periodLabel(p))}</option>`)
            .join('');
        };
        fill(from, 1);
        fill(to, Math.min(periodCount(), (Number(from.value) || 1) + 1));
        if (Number(to.value) < Number(from.value)) to.value = from.value;
        $(prefix + 'FromWrap').hidden = scope.value === 'all';
        $(prefix + 'ToWrap').hidden = scope.value !== 'range';
        $(prefix + 'FromLabel').textContent = scope.value === 'range' ? 'From period' : 'Period';
      },
      /** 'all' or a sorted list of periods. */
      periods() {
        if (scope.value === 'all') return 'all';
        const a = Number(from.value) || 1;
        if (scope.value === 'one') return [a];
        const b = Math.max(a, Number(to.value) || a);
        return Array.from({ length: b - a + 1 }, (_, i) => a + i);
      },
      set(other) {
        scope.value = other.scope.value;
        from.value = other.from.value;
        to.value = other.to.value;
      },
      scope, from, to,
    };
  }
  const vacTime = timeWidget('vac');
  const blockTime = timeWidget('block');
  const listPeriods = (ps) => (ps === 'all' ? allPeriods() : ps);

  function occupancy() {
    const s = st();
    return R.buildOccupancy({
      rooms: (s.rooms && s.rooms.list) || [],
      sections: (s.sections && s.sections.list) || [],
      faculty: s.source.type === 'pdf' ? s.faculty : [],
    });
  }

  function lectures(occ) {
    return R.lecturesToShift(occ, st().roomBlocks, periodCount());
  }

  /** Drops room choices for classes that are no longer in a blocked room. */
  function pruneShifts(occ) {
    const keys = new Set(lectures(occ).map((l) => l.key));
    const shifts = st().roomShifts;
    for (const k of Object.keys(shifts)) if (!keys.has(k)) delete shifts[k];
    for (const k of [...shiftSel]) if (!shifts[k]) shiftSel.delete(k);
  }

  function commit() {
    App.save();
    render();
  }

  // ---- tabs ----------------------------------------------------------------

  function activeTab() {
    return location.hash === '#rooms' ? 'rooms' : 'faculty';
  }

  function renderTabs() {
    const tab = activeTab();
    document.querySelectorAll('[data-tab]').forEach((el) => (el.hidden = el.dataset.tab !== tab));
    document.querySelectorAll('[data-tab-btn]').forEach((b) => {
      b.classList.toggle('active', b.dataset.tabBtn === tab);
      b.setAttribute('aria-selected', b.dataset.tabBtn === tab);
    });
    document.querySelector('.subtitle').textContent = SUBTITLES[tab];
  }

  // ---- rendering -----------------------------------------------------------

  function render() {
    renderTabs();
    const occ = occupancy();
    pruneShifts(occ);
    renderUploads();
    renderVacancy(occ);
    renderRoomChecklist(occ);
    renderBlockForm(occ);
    renderBlocks(occ);
    const list = lectures(occ);
    renderShifts(occ, list);
    renderSchedule(list);
  }

  function renderVacancy(occ) {
    vacTime.render();
    const el = $('vacantRooms');
    if (!occ.rooms.length) {
      el.innerHTML = `<div class="empty">Upload the classroom-wise timetable above to check vacant rooms.</div>`;
      return;
    }
    const date = $('vacDate').value || today;
    const day = dayKeyFromDate(date);
    const periods = listPeriods(vacTime.periods());
    const when = vacTime.periods() === 'all' ? 'the full day' : periods.map((p) => periodLabel(p)).join(', ');
    const { vacant, partly } = R.vacancy(occ, st().roomBlocks, st().roomShifts, [date], periods);
    el.innerHTML = `
      <p><strong>${vacant.length}</strong> room(s) vacant on ${DAY_NAMES[day]}, ${esc(formatDate(date))} for ${esc(when)}:</p>
      <div class="chips">${
        vacant.length
          ? vacant.map((r) => `<span class="chip free">${esc(r)}</span>`).join('')
          : `<span class="muted">${
              periods.length > 1 && partly.length
                ? 'No room is vacant for the whole time — see partly vacant rooms below.'
                : 'No room is vacant at that time.'
            }</span>`
      }</div>
      ${
        partly.length && periods.length > 1
          ? `<details class="partly"><summary>Partly vacant (${partly.length})</summary>
              <table class="data"><thead><tr><th>Room</th><th>Vacant in</th></tr></thead><tbody>${partly
                .map((p) => `<tr><td><strong>${esc(p.room)}</strong></td><td>${p.free.map((s) => `P${s.period}`).join(', ')}</td></tr>`)
                .join('')}</tbody></table></details>`
          : ''
      }`;
  }

  function renderUploads(message) {
    for (const kind of ['room', 'section']) {
      const el = $(kind + 'Status');
      if (message && message.kind === kind) {
        el.innerHTML = `<span class="status-${message.type}">${esc(message.text)}</span>`;
        continue;
      }
      const data = st()[KIND_INFO[kind].key];
      el.innerHTML = data
        ? `<span class="status-ok">Loaded ${data.list.length} ${KIND_INFO[kind].noun}s from <strong>${esc(
            data.source.fileName
          )}</strong> on ${esc(new Date(data.source.importedAt).toLocaleString())}.</span>`
        : `<span class="muted">Not uploaded yet.</span>`;
    }
  }

  function renderRoomChecklist(occ) {
    const from = $('blockFrom').value || today;
    const day = dayKeyFromDate(from);
    const q = roomSearch.trim().toUpperCase();
    const rooms = occ.rooms.filter((r) => !q || r.includes(q));
    $('roomChecklist').innerHTML = occ.rooms.length
      ? rooms.length
        ? rooms
            .map((r) => {
              const checked = roomSel.has(r);
              const count = Object.keys((occ.slots[day] || {})[r] || {}).length;
              return `<label class="check-item ${checked ? 'checked' : ''}">
                <input type="checkbox" data-room="${esc(r)}" ${checked ? 'checked' : ''} />
                <span class="name">${esc(r)}</span>
                <span class="meta">${count} on ${day}</span>
              </label>`;
            })
            .join('')
        : `<div class="empty">No rooms match “${esc(roomSearch)}”.</div>`
      : `<div class="empty">Upload the classroom-wise timetable above to see the rooms.</div>`;
  }

  function renderBlockForm(occ = occupancy()) {
    blockTime.render();
    const from = $('blockFrom').value, to = $('blockTo').value || from;
    const dates = from ? R.datesBetween(from, to) : [];
    const periods = listPeriods(blockTime.periods());

    // Rooms vacant for the whole chosen time (other than the rooms being freed up).
    const target = $('blockTarget');
    const current = target.value;
    const { vacant } = R.vacancy(occ, st().roomBlocks, st().roomShifts, dates, periods);
    const options = vacant.filter((r) => !roomSel.has(r));
    target.innerHTML =
      `<option value="">Auto — best vacant room for each class</option>` +
      (options.length
        ? `<optgroup label="Vacant for the whole time">${options
            .map((r) => `<option value="${esc(r)}" ${r === current ? 'selected' : ''}>${esc(r)}</option>`)
            .join('')}</optgroup>`
        : '');

    $('blockSummary').textContent = roomSel.size
      ? `${[...roomSel].sort().join(', ')}${dates.length ? ` · ${dates.length} day(s)` : ''}`
      : 'Tick the room(s) to shift';
    $('addBlockBtn').disabled = roomSel.size === 0;
  }

  function describePeriods(periods) {
    if (periods === 'all') return 'Full day';
    return periods.map((p) => `P${p}`).join(', ');
  }

  function renderBlocks(occ) {
    const all = lectures(occ);
    const blocks = [...st().roomBlocks].sort((a, b) => a.from.localeCompare(b.from));
    $('blockList').innerHTML = blocks
      .map((b) => {
        const count = all.filter((l) => l.blockId === b.id).length;
        const dates = b.to && b.to !== b.from ? `${formatDate(b.from)} – ${formatDate(b.to)}` : formatDate(b.from);
        const past = (b.to || b.from) < today;
        return `<div class="block-item ${past ? 'past' : ''}">
          <div><strong>${esc(b.rooms.join(', '))}</strong> → ${b.target ? `<strong>${esc(b.target)}</strong>` : 'best vacant room'}${
            b.reason ? ` · ${esc(b.reason)}` : ''
          }</div>
          <div class="muted">${dates} · ${describePeriods(b.periods)} · ${count} class(es) to shift${past ? ' · past' : ''}</div>
          <button class="icon-btn" data-remove-block="${b.id}" title="Remove this block">✕</button>
        </div>`;
      })
      .join('');
  }

  function teacherOf(l) {
    return l.teachers.length ? l.teachers.join(', ') : l.shortTeacher || '';
  }

  function renderShifts(occ, list) {
    const el = $('shifts');
    const shifts = st().roomShifts;
    if (!st().roomBlocks.length) {
      el.innerHTML = `<div class="empty">Block a room above and the classes scheduled in it will appear here.</div>`;
    } else if (!list.length) {
      el.innerHTML = `<div class="empty">No classes are scheduled in the blocked rooms at those times — nothing to shift.</div>`;
    } else {
      const rows = list.map((l) => {
        const current = shifts[l.key] || '';
        const options = R.rankRooms(occ, st().roomBlocks, shifts, l);
        const opts = options.map(
          (o, i) =>
            `<option value="${esc(o.room)}" ${o.room === current ? 'selected' : ''}>${i === 0 ? '★ ' : ''}${esc(o.room)}${
              o.why.length ? ` — ${esc(o.why.join(', '))}` : ''
            }</option>`
        );
        if (current && !options.some((o) => o.room === current)) {
          opts.unshift(`<option value="${esc(current)}" selected>⚠ ${esc(current)} (no longer free)</option>`);
        }
        const status = current
          ? `<span class="badge ok">Shifted</span>
             <button class="icon-btn" data-clear-shift="${esc(l.key)}" title="Clear this room">✕</button>`
          : options.length
            ? `<span class="badge plus">${options.length} free</span>`
            : `<span class="badge no">No room free</span>`;
        return `<tr class="${current ? 'assigned' : ''}">
          <td><input type="checkbox" data-pick-shift="${esc(l.key)}" ${shiftSel.has(l.key) ? 'checked' : ''} ${current ? '' : 'disabled'} /></td>
          <td>${esc(shortDate(l.date))}</td>
          <td><strong>P${l.period}</strong>${periodTime(l.period) ? `<br><span class="muted">${esc(periodTime(l.period))}</span>` : ''}</td>
          <td><strong>${esc(l.room)}</strong></td>
          <td>${esc(l.classes.join(', '))}</td>
          <td>${esc(l.subject)}</td>
          <td>${esc(teacherOf(l))}</td>
          <td><select data-shift="${esc(l.key)}"><option value="">— Select room —</option>${opts.join('')}</select></td>
          <td>${status}</td>
        </tr>`;
      });
      const assigned = list.filter((l) => shifts[l.key]).map((l) => l.key);
      const allPicked = assigned.length > 0 && assigned.every((k) => shiftSel.has(k));
      el.innerHTML = `<div class="grid-wrap"><table class="data shifts">
        <thead><tr>
          <th><input type="checkbox" id="pickAllShifts" title="Select all shifted" ${allPicked ? 'checked' : ''} ${assigned.length ? '' : 'disabled'} /></th>
          <th>Date</th><th>Period</th><th>Room</th><th>Class</th><th>Subject</th><th>Faculty</th><th>Shift to (best first)</th><th>Status</th>
        </tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
    }
    const assignedCount = Object.values(shifts).filter(Boolean).length;
    const picked = [...shiftSel].filter((k) => shifts[k]).length;
    $('clearShiftSelectedBtn').disabled = picked === 0;
    $('clearShiftSelectedBtn').textContent = picked ? `Clear selected (${picked})` : 'Clear selected';
    $('clearShiftAllBtn').disabled = assignedCount === 0;
    $('autoShiftBtn').disabled = !list.some((l) => !shifts[l.key]);
  }

  // ---- shifting schedule ---------------------------------------------------

  function scheduleDates(list) {
    const shifts = st().roomShifts;
    return [...new Set(list.filter((l) => shifts[l.key]).map((l) => l.date))];
  }

  function scheduleSpec(list) {
    const shifts = st().roomShifts;
    const dates = scheduleDates(list);
    const all = scheduleDate === 'all';
    const groups = new Map();
    for (const l of list) {
      if (!shifts[l.key] || (!all && l.date !== scheduleDate)) continue;
      const key = `${l.date}|${l.room}`;
      if (!groups.has(key)) {
        const room = l.reason ? `${l.room} (${l.reason})` : l.room;
        groups.set(key, { label: all ? `${formatDate(l.date)} · ${room}` : room, rows: [] });
      }
      groups.get(key).rows.push([
        periodTime(l.period) || `Period ${l.period}`,
        l.classes.join(', '),
        l.subject,
        teacherOf(l),
        shifts[l.key],
      ]);
    }
    const span = all
      ? dates.length > 1 ? `${formatDate(dates[0])} – ${formatDate(dates[dates.length - 1])}` : formatDate(dates[0] || today)
      : formatDate(scheduleDate);
    return {
      title: `Classroom Shifting Schedule: ${span}`,
      headers: [all ? 'Date · Room' : 'Shifted From', 'Time', 'Class', 'Subject', 'Faculty', 'Shifted To'],
      groups: [...groups.values()],
      fileName: `classroom-shifting-${all ? 'all' : scheduleDate}`,
    };
  }

  function renderSchedule(list) {
    const dates = scheduleDates(list);
    if (scheduleDate !== 'all' && !dates.includes(scheduleDate)) {
      scheduleDate = dates.find((d) => d >= today) || dates[0] || null;
    }
    const select = $('shiftDateSelect');
    select.innerHTML =
      dates.map((d) => `<option value="${d}" ${d === scheduleDate ? 'selected' : ''}>${esc(formatDate(d))} (${dayKeyFromDate(d)})</option>`).join('') +
      (dates.length > 1 ? `<option value="all" ${scheduleDate === 'all' ? 'selected' : ''}>All dates</option>` : '');
    select.hidden = dates.length === 0;

    const spec = scheduleDate ? scheduleSpec(list) : { groups: [] };
    const hasRows = spec.groups.length > 0;
    $('shiftSchedule').innerHTML = hasRows
      ? window.Sheet.sheetHtml(spec)
      : `<div class="empty">Choose a new room for the classes above and the shifting schedule will appear here.</div>`;
    const pending = list.filter((l) => !st().roomShifts[l.key]).length;
    $('shiftNote').textContent = pending ? `${pending} class(es) still have no room and are not included yet.` : '';
    ['printShiftBtn', 'excelShiftBtn', 'imageShiftBtn', 'copyShiftBtn'].forEach((id) => ($(id).disabled = !hasRows));
  }

  // ---- actions -------------------------------------------------------------

  async function handlePdf(file, kind) {
    if (!file) return;
    const info = KIND_INFO[kind];
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
      renderUploads({ kind, type: 'error', text: 'Please choose a PDF file.' });
      return;
    }
    const zone = document.querySelector(`.drop-zone[data-kind="${kind}"]`);
    zone.classList.add('busy');
    renderUploads({ kind, type: 'ok', text: `Reading ${file.name}…` });
    try {
      const data = new Uint8Array(await file.arrayBuffer());
      const result = await window.PdfImport.importTimetablePdf(data, window.pdfjsLib, { kind });
      const list = result.faculty.filter((e) => e.name).map(({ name, schedule, pages }) => ({ name, schedule, pages }));
      if (!list.length) {
        renderUploads({ kind, type: 'error', text: `No ${info.noun} timetables found in ${file.name}. ${result.warnings.join(' ')}` });
        return;
      }
      const odd = list.filter((e) => !info.looksRight(e.name));
      if (odd.length > list.length / 2 &&
          !confirm(`${file.name} doesn't look like a ${info.noun}-wise timetable (pages are titled e.g. “${odd[0].name}”). Load it anyway?`)) {
        renderUploads();
        return;
      }
      const s = st();
      s[info.key] = { list, source: { fileName: file.name, importedAt: new Date().toISOString() } };
      if (!(s.settings.periodTimes || []).some(Boolean) && result.periodTimes.some(Boolean)) {
        s.settings.periodTimes = result.periodTimes;
      }
      if (result.periods > periodCount()) s.settings.periods = result.periods;
      App.save();
      App.render();
      const skipped = result.faculty.length - list.length;
      if (skipped) renderUploads({ kind, type: 'error', text: `Loaded ${list.length} ${info.noun}s; ${skipped} page(s) had no title and were skipped.` });
    } catch (err) {
      console.error(err);
      renderUploads({ kind, type: 'error', text: `Could not read ${file.name}: ${err.message}` });
    } finally {
      zone.classList.remove('busy');
    }
  }

  function addBlock() {
    const from = $('blockFrom').value;
    const to = $('blockTo').value || from;
    if (!roomSel.size) return;
    if (!from) {
      alert('Choose the date the rooms are needed.');
      return;
    }
    if (to < from) {
      alert('The “To” date is before the “From” date.');
      return;
    }
    const s = st();
    const block = {
      id: 'b' + Date.now().toString(36),
      rooms: [...roomSel].sort(),
      from,
      to,
      periods: blockTime.periods(),
      target: $('blockTarget').value,
      reason: $('blockReason').value.trim(),
    };
    s.roomBlocks.push(block);
    const occ = occupancy();
    const mine = lectures(occ).filter((l) => l.blockId === block.id);
    s.roomShifts = R.autoAssignRooms(occ, s.roomBlocks, s.roomShifts, mine, () => block.target || null);
    roomSel.clear();
    $('blockReason').value = '';
    $('blockTarget').value = '';
    scheduleDate = from;
    commit();
    if (!mine.length) alert(`No classes are scheduled in ${block.rooms.join(', ')} at that time — nothing to shift.`);
    else $('shifts').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function removeBlock(id) {
    const s = st();
    const b = s.roomBlocks.find((x) => x.id === id);
    if (!b) return;
    const shifted = lectures(occupancy()).filter((l) => l.blockId === id && s.roomShifts[l.key]).length;
    if (shifted && !confirm(`Remove the block on ${b.rooms.join(', ')}? ${shifted} class(es) already given a new room will go back to their own room.`)) return;
    s.roomBlocks = s.roomBlocks.filter((x) => x.id !== id);
    commit();
  }

  function clearShifts(keys) {
    const shifts = st().roomShifts;
    keys.forEach((k) => {
      delete shifts[k];
      shiftSel.delete(k);
    });
    commit();
  }

  function autoShift() {
    const occ = occupancy();
    const s = st();
    const targetOf = Object.fromEntries(s.roomBlocks.map((b) => [b.id, b.target || null]));
    s.roomShifts = R.autoAssignRooms(occ, s.roomBlocks, s.roomShifts, lectures(occ), (l) => targetOf[l.blockId]);
    commit();
  }

  // ---- events --------------------------------------------------------------

  document.querySelectorAll('[data-tab-btn]').forEach((b) =>
    b.addEventListener('click', () => {
      history.replaceState(null, '', b.dataset.tabBtn === 'rooms' ? '#rooms' : location.pathname + location.search);
      renderTabs();
    })
  );
  window.addEventListener('hashchange', renderTabs);

  document.querySelectorAll('.drop-zone[data-kind]').forEach((zone) => {
    const kind = zone.dataset.kind;
    const input = zone.querySelector('input');
    input.addEventListener('change', () => {
      handlePdf(input.files[0], kind);
      input.value = '';
    });
    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      zone.classList.add('dragging');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('dragging'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('dragging');
      handlePdf(e.dataTransfer.files[0], kind);
    });
  });

  $('roomSearch').addEventListener('input', (e) => {
    roomSearch = e.target.value;
    renderRoomChecklist(occupancy());
  });
  $('roomChecklist').addEventListener('change', (e) => {
    const r = e.target.dataset.room;
    if (!r) return;
    if (e.target.checked) roomSel.add(r);
    else roomSel.delete(r);
    renderRoomChecklist(occupancy());
    renderBlockForm();
  });
  $('roomSelectNoneBtn').addEventListener('click', () => {
    roomSel.clear();
    renderRoomChecklist(occupancy());
    renderBlockForm();
  });
  // The vacancy check's date and time carry over to the shifting form below it.
  $('vacDate').value = today;
  $('blockFrom').value = today;
  $('blockTo').value = today;
  const onVacancyChange = () => {
    vacTime.render();
    blockTime.set(vacTime);
    const d = $('vacDate').value || today;
    $('blockFrom').value = d;
    $('blockTo').value = d;
    const occ = occupancy();
    renderVacancy(occ);
    renderRoomChecklist(occ);
    renderBlockForm(occ);
  };
  ['vacDate', 'vacScope', 'vacPFrom', 'vacPTo'].forEach((id) => $(id).addEventListener('change', onVacancyChange));

  $('blockFrom').addEventListener('change', () => {
    const from = $('blockFrom').value;
    if (!$('blockTo').value || $('blockTo').value < from) $('blockTo').value = from;
    renderRoomChecklist(occupancy());
    renderBlockForm();
  });
  ['blockTo', 'blockScope', 'blockPFrom', 'blockPTo'].forEach((id) => $(id).addEventListener('change', () => renderBlockForm()));
  $('addBlockBtn').addEventListener('click', addBlock);
  $('blockList').addEventListener('click', (e) => {
    const id = e.target.dataset.removeBlock;
    if (id) removeBlock(id);
  });

  $('shifts').addEventListener('change', (e) => {
    const shifts = st().roomShifts;
    if (e.target.id === 'pickAllShifts') {
      Object.keys(shifts).forEach((k) => (e.target.checked ? shiftSel.add(k) : shiftSel.delete(k)));
      render();
      return;
    }
    const pick = e.target.dataset.pickShift;
    if (pick) {
      if (e.target.checked) shiftSel.add(pick);
      else shiftSel.delete(pick);
      render();
      return;
    }
    const key = e.target.dataset.shift;
    if (!key) return;
    if (e.target.value) shifts[key] = e.target.value;
    else {
      delete shifts[key];
      shiftSel.delete(key);
    }
    commit();
  });
  $('shifts').addEventListener('click', (e) => {
    const key = e.target.dataset.clearShift;
    if (key) clearShifts([key]);
  });
  $('autoShiftBtn').addEventListener('click', autoShift);
  $('clearShiftSelectedBtn').addEventListener('click', () => clearShifts([...shiftSel]));
  $('clearShiftAllBtn').addEventListener('click', () => {
    const keys = Object.keys(st().roomShifts);
    if (keys.length && confirm(`Clear all ${keys.length} room shift(s)?`)) clearShifts(keys);
  });

  $('shiftDateSelect').addEventListener('change', (e) => {
    scheduleDate = e.target.value;
    renderSchedule(lectures(occupancy()));
  });
  const currentSpec = () => scheduleSpec(lectures(occupancy()));
  $('printShiftBtn').addEventListener('click', () => window.Sheet.print($('shiftScheduleCard')));
  $('excelShiftBtn').addEventListener('click', () => window.Sheet.excel(currentSpec()));
  $('imageShiftBtn').addEventListener('click', () => window.Sheet.image(currentSpec()));
  $('copyShiftBtn').addEventListener('click', (e) => window.Sheet.copy(currentSpec(), e.target));

  window.RoomsUI = { render };
  render();
})();
