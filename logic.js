(function (root) {
  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const DAY_NAMES = {
    Sun: 'Sunday', Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday',
    Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday',
  };
  const PERIODS = 8;

  function dayKeyFromDate(iso) {
    const d = new Date(iso + 'T00:00:00');
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
  }

  function toISO(d) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function weekStart(iso) {
    const d = new Date(iso + 'T00:00:00');
    const offset = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - offset);
    return toISO(d);
  }

  function lecturesOn(faculty, day) {
    return (faculty.schedule && faculty.schedule[day]) || [];
  }

  function weeklyLoad(faculty) {
    return DAYS.reduce((sum, day) => sum + lecturesOn(faculty, day).length, 0);
  }

  /**
   * Ranks every non-absent faculty member as a potential substitute.
   *
   * adjustments:     substitutions already assigned on this date ({ substituteId, period })
   * weekAdjustments: substitutions assigned anywhere in the same week (counted in weekly load)
   * period:          when given, the faculty member must also be free in that period
   *
   * Sorted by day load, then weekly load, then name.
   */
  function rankSubstitutes(faculty, opts) {
    const {
      day,
      absentIds = [],
      adjustments = [],
      weekAdjustments = [],
      maxDayLoad = 3,
      maxWeeklyLoad = null,
      period = null,
      periods = PERIODS,
      exempt = {}, // id -> role label (HOD, COE, …): never given adjustments
    } = opts;
    const absent = new Set(absentIds);

    const rows = faculty
      .filter((f) => !absent.has(f.id))
      .map((f) => {
        const own = lecturesOn(f, day);
        const extra = adjustments.filter((a) => a.substituteId === f.id);
        const dayLoad = own.length + extra.length;
        const weekLoad =
          weeklyLoad(f) + weekAdjustments.filter((a) => a.substituteId === f.id).length;
        const busy = new Set([...own.map((l) => l.period), ...extra.map((a) => a.period)]);
        const freePeriods = [];
        for (let p = 1; p <= periods; p++) if (!busy.has(p)) freePeriods.push(p);

        const reasons = [];
        if (f.id in exempt) reasons.push(`No adjustments${exempt[f.id] ? ` (${exempt[f.id]})` : ''}`);
        if (dayLoad > maxDayLoad) reasons.push(`${dayLoad} lectures today (max ${maxDayLoad})`);
        if (maxWeeklyLoad != null && weekLoad > maxWeeklyLoad) {
          reasons.push(`Weekly load ${weekLoad} (max ${maxWeeklyLoad})`);
        }
        if (period != null && busy.has(period)) reasons.push(`Busy in period ${period}`);

        return {
          faculty: f,
          dayLoad,
          weeklyLoad: weekLoad,
          freePeriods,
          eligible: reasons.length === 0,
          reasons,
        };
      });

    rows.sort(
      (a, b) =>
        a.dayLoad - b.dayLoad ||
        a.weeklyLoad - b.weeklyLoad ||
        a.faculty.name.localeCompare(b.faculty.name)
    );
    return rows;
  }

  const CODE_CELL_RE = /^[A-Z]{1,4}\d{3,}$/i;
  const HEADER_RE =
    /^(s\.?\s*no\.?|sr\.?\s*no\.?|#|name|faculty(\s+name)?|emp(loyee)?\.?\s*(code|id|no\.?)|code|designation|role|post|position|department|dept\.?)$/i;
  const ROLE_RE = /^(hod|h\.o\.d\.?|coe|ad|dean|director|registrar|principal|vc|pro[\s-]?vc|coordinator|warden|admin|head\b.*|associate dean|assistant dean)/i;

  /**
   * Reads a pasted or uploaded list (CSV / TXT, one person per line) of faculty who must never
   * be given adjustments. A line can hold a name, an employee code and a role in any order,
   * separated by commas, tabs or semicolons, e.g. "Dr. Shikha Sharma, E20303, HOD".
   */
  function parseExemptList(text) {
    const out = [];
    for (const raw of String(text || '').split(/\r?\n/)) {
      let cells = raw.split(/[,\t;|]/).map((c) => c.replace(/^"|"$/g, '').trim()).filter(Boolean);
      if (!cells.length || cells.every((c) => HEADER_RE.test(c))) continue;
      if (cells.length === 1) {
        // "Dr. A Sharma (E20303) - HOD"
        const m = cells[0].match(/^(.*?)\s*(?:[-–:]\s*([A-Za-z .]{2,25}))?$/);
        cells = [m[1], m[2]].filter(Boolean);
        const code = cells[0].match(/[(\[]?\b([A-Z]{1,4}\d{3,})\b[)\]]?/i);
        if (code) cells = [cells[0].replace(code[0], '').trim(), code[1], ...cells.slice(1)];
      }
      const code = cells.find((c) => CODE_CELL_RE.test(c)) || '';
      const rest = cells.filter((c) => c !== code);
      const role = rest.find((c) => ROLE_RE.test(c)) || '';
      const nameCells = rest.filter((c) => c !== role && /[a-z]/i.test(c) && !/^\d+$/.test(c));
      const name = nameCells.sort((a, b) => b.length - a.length)[0] || '';
      if (!name && !code) continue;
      out.push({ name, code: code.toUpperCase(), role });
    }
    return out;
  }

  /**
   * Matches list entries to faculty by employee code, then exact name, then a unique partial
   * name match. Returns { byId: { facultyId: entry }, unmatched: [entry] }.
   */
  function matchExempt(faculty, entries, normalizeName) {
    const byId = {}, unmatched = [];
    for (const e of entries) {
      const n = normalizeName(e.name);
      let f = e.code && faculty.find((x) => x.code && x.code.toUpperCase() === e.code);
      if (!f && n) f = faculty.find((x) => normalizeName(x.name) === n);
      if (!f && n.length >= 4) {
        const partial = faculty.filter((x) => {
          const m = normalizeName(x.name);
          return m.length >= 4 && (m.includes(n) || n.includes(m));
        });
        if (partial.length === 1) f = partial[0];
      }
      if (f) byId[f.id] = e;
      else unmatched.push(e);
    }
    return { byId, unmatched };
  }

  const api = {
    DAYS, DAY_NAMES, PERIODS,
    dayKeyFromDate, toISO, weekStart, lecturesOn, weeklyLoad, rankSubstitutes,
    parseExemptList, matchExempt,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Logic = api;
})(this);
