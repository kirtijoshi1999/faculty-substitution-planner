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

  const api = {
    DAYS, DAY_NAMES, PERIODS,
    dayKeyFromDate, toISO, weekStart, lecturesOn, weeklyLoad, rankSubstitutes,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Logic = api;
})(this);
