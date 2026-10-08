(function (root) {
  const Logic = typeof module !== 'undefined' && module.exports ? require('./logic.js') : root.Logic;
  const { DAYS, dayKeyFromDate, toISO } = Logic;

  const roomKey = (r) => String(r || '').trim().toUpperCase();
  const splitList = (s) => String(s || '').split(/\s*,\s*/).map((x) => x.trim()).filter(Boolean);
  const stripGroup = (s) => s.replace(/\s*\(.*\)\s*$/, '');

  /** "D8-507" -> { building: 'D8', floor: '5' } */
  function roomPlace(room) {
    const m = roomKey(room).match(/^([A-Z]+\d*)-(\d)/);
    return m ? { building: m[1], floor: m[2] } : { building: '', floor: '' };
  }

  /**
   * Who is in which room, per day and period, combining whatever timetables are loaded:
   *   rooms:    classroom-wise [{ name, schedule: { Mon: [{ period, className, subject, teacher }] } }]
   *   sections: section-wise   [{ name, schedule: { Mon: [{ period, subject, room, teacher }] } }]
   *   faculty:  faculty-wise   [{ name, schedule: { Mon: [{ period, className, subject, room }] } }]
   * Returns { rooms: [sorted room codes], slots: { Mon: { 'D8-507': { 3: slot } } } } where
   * slot = { classes: [...], subject, teachers: [...] }.
   */
  function buildOccupancy({ rooms = [], sections = [], faculty = [] }) {
    const slots = Object.fromEntries(DAYS.map((d) => [d, {}]));
    const known = new Set(rooms.map((r) => roomKey(r.name)));

    function add(day, room, period, { classes = [], subject = '', teacher = '', fullName = '' }) {
      room = roomKey(room);
      if (!room || !slots[day]) return;
      known.add(room);
      const byRoom = (slots[day][room] = slots[day][room] || {});
      const slot = (byRoom[period] = byRoom[period] || { classes: [], subject: '', teachers: [], shortTeacher: '' });
      for (const c of classes) if (c && !slot.classes.includes(c)) slot.classes.push(c);
      if (!slot.subject && subject) slot.subject = subject;
      if (fullName && !slot.teachers.includes(fullName)) slot.teachers.push(fullName);
      if (!slot.shortTeacher && teacher) slot.shortTeacher = teacher;
    }

    for (const r of rooms) {
      for (const day of DAYS) {
        for (const l of (r.schedule && r.schedule[day]) || []) {
          add(day, r.name, l.period, {
            classes: splitList(l.className || l.label).map(stripGroup),
            subject: l.subject,
            teacher: l.teacher,
          });
        }
      }
    }
    for (const s of sections) {
      for (const day of DAYS) {
        for (const l of (s.schedule && s.schedule[day]) || []) {
          const roomsHere = splitList(l.room);
          // Split groups list subjects/teachers in the same order as their rooms.
          const subjects = String(l.subject || '').split(/\s*\/\s*/);
          const teachers = splitList(l.teacher);
          roomsHere.forEach((room, i) =>
            add(day, room, l.period, {
              classes: [s.name],
              subject: roomsHere.length === subjects.length ? subjects[i] : l.subject,
              teacher: roomsHere.length === teachers.length ? teachers[i] : l.teacher,
            })
          );
        }
      }
    }
    for (const f of faculty) {
      for (const day of DAYS) {
        for (const l of (f.schedule && f.schedule[day]) || []) {
          splitList(l.room).forEach((room) =>
            add(day, room, l.period, {
              classes: splitList(l.className).map(stripGroup),
              subject: l.subject,
              fullName: f.name,
            })
          );
        }
      }
    }
    return { rooms: [...known].sort(), slots };
  }

  const slotAt = (occ, day, room, period) => ((occ.slots[day] || {})[roomKey(room)] || {})[period] || null;

  function datesBetween(from, to, limit = 62) {
    const out = [];
    if (!from) return out;
    const d = new Date(from + 'T00:00:00');
    const end = to && to >= from ? to : from;
    while (out.length < limit) {
      const iso = toISO(d);
      if (iso > end) break;
      out.push(iso);
      d.setDate(d.getDate() + 1);
    }
    return out;
  }

  /** block = { id, rooms: [...], from, to, periods: 'all' | [n...], reason } */
  function blockCovers(block, room, date, period) {
    return (
      date >= block.from &&
      date <= (block.to || block.from) &&
      block.rooms.map(roomKey).includes(roomKey(room)) &&
      (block.periods === 'all' || block.periods.includes(period))
    );
  }

  const isBlocked = (blocks, room, date, period) => blocks.some((b) => blockCovers(b, room, date, period));

  const shiftKey = (date, room, period) => `${date}|${roomKey(room)}|${period}`;
  const parseShiftKey = (key) => {
    const [date, room, period] = key.split('|');
    return { date, room, period: Number(period) };
  };

  /** Every scheduled class that sits in a blocked room, sorted by date, period and room. */
  function lecturesToShift(occ, blocks, periods) {
    const out = new Map();
    for (const b of blocks) {
      for (const date of datesBetween(b.from, b.to)) {
        const day = dayKeyFromDate(date);
        const ps = b.periods === 'all' ? Array.from({ length: periods }, (_, i) => i + 1) : b.periods;
        for (const room of b.rooms) {
          for (const period of ps) {
            const slot = slotAt(occ, day, room, period);
            const key = shiftKey(date, room, period);
            if (!slot || out.has(key)) continue;
            out.set(key, { key, date, day, room: roomKey(room), period, ...slot, reason: b.reason || '', blockId: b.id });
          }
        }
      }
    }
    return [...out.values()].sort(
      (a, b) => a.date.localeCompare(b.date) || a.period - b.period || a.room.localeCompare(b.room)
    );
  }

  /** Rooms already taken on (date, period) as the target of another shift. */
  function takenTargets(shifts, date, period, exceptKey) {
    const taken = new Set();
    for (const [key, to] of Object.entries(shifts)) {
      if (!to || key === exceptKey) continue;
      const k = parseShiftKey(key);
      if (k.date === date && k.period === period) taken.add(roomKey(to));
    }
    return taken;
  }

  /**
   * Free rooms for one lecture, best first. A room is free when nothing is scheduled there in
   * that period, it isn't blocked, and no other shifted class has been sent there.
   * Preference: a room the class already uses that day, then same floor, then same building.
   */
  function rankRooms(occ, blocks, shifts, lecture) {
    const taken = takenTargets(shifts, lecture.date, lecture.period, lecture.key);
    const from = roomPlace(lecture.room);
    const usedToday = new Set();
    for (const [room, byPeriod] of Object.entries(occ.slots[lecture.day] || {})) {
      if (Object.values(byPeriod).some((s) => s.classes.some((c) => lecture.classes.includes(c)))) usedToday.add(room);
    }
    const isLab = (r) => /[A-Z]$|-T$/.test(r);

    return occ.rooms
      .filter(
        (r) =>
          r !== lecture.room &&
          !slotAt(occ, lecture.day, r, lecture.period) &&
          !isBlocked(blocks, r, lecture.date, lecture.period) &&
          !taken.has(r)
      )
      .map((room) => {
        const place = roomPlace(room);
        const why = [];
        let score = 0;
        if (usedToday.has(room)) { score += 3; why.push('class uses it today'); }
        if (place.building && place.building === from.building) {
          if (place.floor === from.floor) { score += 2; why.push('same floor'); }
          else { score += 1; why.push('same building'); }
        }
        if (isLab(room) && !isLab(lecture.room)) score -= 1;
        return { room, score, why };
      })
      .sort((a, b) => b.score - a.score || a.room.localeCompare(b.room));
  }

  /**
   * Fills every unassigned lecture with its best room, keeping a multi-period class together.
   * prefer(lecture) may name a room to use whenever it is free.
   */
  function autoAssignRooms(occ, blocks, shifts, lectures, prefer = () => null) {
    const next = { ...shifts };
    for (const l of lectures) {
      if (next[l.key]) continue;
      const options = rankRooms(occ, blocks, next, l);
      const neighbours = [l.period - 1, l.period + 1]
        .map((p) => lectures.find((o) => o.date === l.date && o.room === l.room && o.period === p))
        .filter((o) => o && o.classes.join() === l.classes.join())
        .map((o) => next[o.key])
        .filter(Boolean);
      const wanted = prefer(l);
      const best =
        options.find((o) => o.room === wanted) || options.find((o) => neighbours.includes(o.room)) || options[0];
      if (best) next[l.key] = best.room;
    }
    return next;
  }

  /** Rooms with nothing scheduled, not blocked and not used by a shift on (date, period). */
  function freeRooms(occ, blocks, shifts, date, period) {
    const day = dayKeyFromDate(date);
    const taken = takenTargets(shifts, date, period, null);
    return occ.rooms.filter(
      (r) => !slotAt(occ, day, r, period) && !isBlocked(blocks, r, date, period) && !taken.has(r)
    );
  }

  /**
   * For each room, the (date, period) slots it is free in out of the requested ones.
   * Returns { vacant: [rooms free throughout], partly: [{ room, free: [{ date, period }] }] }.
   */
  function vacancy(occ, blocks, shifts, dates, periods) {
    const slots = dates.flatMap((date) => periods.map((period) => ({ date, period })));
    const freeBy = new Map(occ.rooms.map((r) => [r, []]));
    for (const s of slots) {
      for (const r of freeRooms(occ, blocks, shifts, s.date, s.period)) freeBy.get(r).push(s);
    }
    const vacant = [], partly = [];
    for (const [room, free] of freeBy) {
      if (slots.length && free.length === slots.length) vacant.push(room);
      else if (free.length) partly.push({ room, free });
    }
    partly.sort((a, b) => b.free.length - a.free.length || a.room.localeCompare(b.room));
    return { vacant, partly };
  }

  const api = {
    roomKey, roomPlace, buildOccupancy, slotAt, datesBetween, blockCovers, isBlocked,
    shiftKey, parseShiftKey, lecturesToShift, rankRooms, autoAssignRooms, freeRooms, vacancy,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RoomLogic = api;
})(this);
