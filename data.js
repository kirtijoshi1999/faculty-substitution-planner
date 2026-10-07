(function (root) {
  // Lectures per day, Mon..Sat
  const SEED = [
    { name: 'Dr. Anita Sharma', department: 'CSE', subjects: ['DBMS', 'Data Structures'], loads: [4, 3, 5, 2, 4, 1] },
    { name: 'Prof. Rajesh Kumar', department: 'CSE', subjects: ['Operating Systems', 'Networks'], loads: [2, 4, 3, 4, 2, 2] },
    { name: 'Dr. Meera Iyer', department: 'ECE', subjects: ['Signals', 'VLSI'], loads: [3, 2, 2, 3, 3, 0] },
    { name: 'Prof. Vikram Singh', department: 'ME', subjects: ['Thermodynamics', 'Fluid Mechanics'], loads: [5, 4, 4, 5, 3, 2] },
    { name: 'Dr. Priya Nair', department: 'Mathematics', subjects: ['Calculus', 'Linear Algebra'], loads: [1, 2, 1, 2, 2, 1] },
    { name: 'Prof. Sanjay Gupta', department: 'Physics', subjects: ['Applied Physics', 'Optics'], loads: [3, 3, 3, 3, 3, 1] },
    { name: 'Dr. Kavita Joshi', department: 'CSE', subjects: ['Machine Learning', 'Python'], loads: [2, 5, 2, 4, 1, 2] },
    { name: 'Prof. Amit Verma', department: 'IT', subjects: ['Web Technologies', 'Cloud Computing'], loads: [3, 1, 4, 2, 5, 0] },
    { name: 'Dr. Sunita Rao', department: 'Chemistry', subjects: ['Engineering Chemistry'], loads: [2, 2, 3, 1, 2, 2] },
    { name: 'Prof. Arjun Mehta', department: 'ECE', subjects: ['Digital Electronics', 'Microprocessors'], loads: [4, 3, 1, 3, 4, 2] },
    { name: 'Dr. Neha Kapoor', department: 'Humanities', subjects: ['Communication Skills', 'Ethics'], loads: [1, 3, 2, 2, 3, 1] },
    { name: 'Prof. Rohit Desai', department: 'Civil', subjects: ['Surveying', 'Structural Analysis'], loads: [3, 4, 3, 2, 3, 3] },
  ];
  const CLASSES = ['FE-A', 'FE-B', 'SE-A', 'SE-B', 'TE-A', 'TE-B', 'BE-A', 'BE-B'];
  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const PERIODS = 8;

  function rng(seed) {
    let s = seed;
    return () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };
  }

  function build() {
    const rand = rng(42);
    return SEED.map((f, i) => {
      const schedule = {};
      DAYS.forEach((day, d) => {
        const periods = Array.from({ length: PERIODS }, (_, k) => k + 1)
          .sort(() => rand() - 0.5)
          .slice(0, f.loads[d])
          .sort((a, b) => a - b);
        schedule[day] = periods.map((period) => {
          const subject = f.subjects[Math.floor(rand() * f.subjects.length)];
          const cls = CLASSES[Math.floor(rand() * CLASSES.length)];
          return { period, label: `${cls} · ${subject}` };
        });
      });
      return { id: `f${i + 1}`, name: f.name, department: f.department, schedule };
    });
  }

  const api = { buildSampleFaculty: build };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SampleData = api;
})(this);
