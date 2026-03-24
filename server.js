/**
 * PowerClass Backend — Node.js + MySQL
 * ======================================
 * Database : MySQL (Railway managed)
 * Hosting  : Railway.app
 */

const express  = require('express');
const mysql    = require('mysql2/promise');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const cors     = require('cors');
const multer   = require('multer');
const fs       = require('fs');

const app        = express();
const PORT       = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret';

// ── Middleware ────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '20mb' }));
app.use('/uploads', express.static('uploads'));

// ── Upload folder ─────────────────────────────────────────────
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

const upload = multer({
  storage: multer.diskStorage({
    destination: (_, __, cb) => cb(null, 'uploads/'),
    filename:    (_, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/\s/g, '_')}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_, file, cb) =>
    file.mimetype === 'application/pdf' ? cb(null, true) : cb(new Error('PDF only')),
});

// ── MySQL Pool ────────────────────────────────────────────────
// Railway injects MYSQL_URL automatically when you add a MySQL plugin.
// Format: mysql://user:password@host:port/dbname
let pool;
async function db() {
  if (!pool) {
    pool = mysql.createPool({
      uri:                process.env.MYSQL_URL || process.env.DATABASE_URL,
      waitForConnections: true,
      connectionLimit:    10,
      ssl:                { rejectUnauthorized: false },
    });
  }
  return pool;
}

// ── Create Tables ─────────────────────────────────────────────
async function setupDatabase() {
  const con = await db();

  await con.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id         VARCHAR(40)  PRIMARY KEY,
      email      VARCHAR(255) UNIQUE NOT NULL,
      password   VARCHAR(255) NOT NULL,
      role       VARCHAR(20)  NOT NULL DEFAULT 'student',
      created_at DATETIME     NOT NULL DEFAULT NOW()
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await con.execute(`
    CREATE TABLE IF NOT EXISTS students (
      id                  VARCHAR(40)  PRIMARY KEY,
      user_id             VARCHAR(40)  NOT NULL,
      full_name           VARCHAR(255) NOT NULL,
      registration_number VARCHAR(100),
      created_at          DATETIME     NOT NULL DEFAULT NOW(),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await con.execute(`
    CREATE TABLE IF NOT EXISTS results (
      id         VARCHAR(40)  PRIMARY KEY,
      student_id VARCHAR(40)  NOT NULL,
      subject    VARCHAR(255) NOT NULL,
      marks      INT          NOT NULL,
      grade      VARCHAR(10),
      term       VARCHAR(100),
      remarks    TEXT,
      created_at DATETIME     NOT NULL DEFAULT NOW(),
      FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await con.execute(`
    CREATE TABLE IF NOT EXISTS assignments (
      id          VARCHAR(40)  PRIMARY KEY,
      title       VARCHAR(255) NOT NULL,
      description TEXT,
      file_name   VARCHAR(255) NOT NULL,
      file_path   VARCHAR(500) NOT NULL,
      file_size   INT,
      created_at  DATETIME     NOT NULL DEFAULT NOW()
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await con.execute(`
    CREATE TABLE IF NOT EXISTS notes (
      id          VARCHAR(40)  PRIMARY KEY,
      title       VARCHAR(255) NOT NULL,
      subject     VARCHAR(255) NOT NULL,
      description TEXT,
      file_name   VARCHAR(255) NOT NULL,
      file_path   VARCHAR(500) NOT NULL,
      file_size   INT,
      created_at  DATETIME     NOT NULL DEFAULT NOW()
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await con.execute(`
    CREATE TABLE IF NOT EXISTS submissions (
      id            VARCHAR(40)  PRIMARY KEY,
      student_id    VARCHAR(40)  NOT NULL,
      assignment_id VARCHAR(40),
      title         VARCHAR(255),
      file_name     VARCHAR(255) NOT NULL,
      file_path     VARCHAR(500) NOT NULL,
      file_size     INT,
      submitted_at  DATETIME     NOT NULL DEFAULT NOW(),
      FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Seed admin
  const [rows] = await con.execute('SELECT id FROM users WHERE email = ?', ['zayeed728@gmail.com']);
  if (rows.length === 0) {
    const hash = bcrypt.hashSync('zayd1234', 10);
    await con.execute('INSERT INTO users (id, email, password, role) VALUES (?, ?, ?, ?)',
      ['u_admin', 'zayeed728@gmail.com', hash, 'admin']);
    console.log('✓ Admin seeded');
  }
  console.log('✓ MySQL ready');
}

// ── Helpers ───────────────────────────────────────────────────
const uid  = () => `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
const ok   = (res, data)          => res.json({ ok: true, ...data });
const fail = (res, msg, code=400) => res.status(code).json({ error: msg });

function auth(req, res, role = null) {
  const token = (req.headers.authorization || req.query.token || '').replace('Bearer ', '');
  if (!token) { fail(res, 'Unauthorized', 401); return null; }
  try {
    const p = jwt.verify(token, JWT_SECRET);
    if (role && p.role !== role) { fail(res, 'Forbidden', 403); return null; }
    return p;
  } catch { fail(res, 'Token expired or invalid', 401); return null; }
}

// ── AUTH ──────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return fail(res, 'Email and password required');
    const con = await db();
    const [rows] = await con.execute('SELECT * FROM users WHERE email = ?', [email.toLowerCase()]);
    const user = rows[0];
    if (!user || !bcrypt.compareSync(password, user.password))
      return fail(res, 'Invalid email or password', 401);
    const token = jwt.sign({ userId: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    const { password: _, ...safe } = user;
    let student = null;
    if (user.role === 'student') {
      const [sr] = await con.execute('SELECT * FROM students WHERE user_id = ?', [user.id]);
      student = sr[0] || null;
    }
    ok(res, { token, user: safe, student });
  } catch (e) { console.error(e); fail(res, 'Server error', 500); }
});

// ── STUDENTS ──────────────────────────────────────────────────
app.get('/api/students', async (req, res) => {
  try {
    const p = auth(req, res, 'admin'); if (!p) return;
    const con = await db();
    const [rows] = await con.execute(`
      SELECT s.*, u.email FROM students s
      JOIN users u ON u.id = s.user_id
      ORDER BY s.created_at DESC`);
    res.json(rows);
  } catch (e) { fail(res, 'Server error', 500); }
});

app.post('/api/students', async (req, res) => {
  try {
    const p = auth(req, res, 'admin'); if (!p) return;
    const { fullName, email, password, registrationNumber } = req.body;
    if (!fullName || !email || !password) return fail(res, 'Name, email and password required');
    const con = await db();
    const [ex] = await con.execute('SELECT id FROM users WHERE email = ?', [email.toLowerCase()]);
    if (ex.length > 0) return fail(res, 'Email already exists');
    const hash = bcrypt.hashSync(password, 10);
    const userId = uid(), studId = uid();
    await con.execute('INSERT INTO users (id, email, password, role) VALUES (?, ?, ?, ?)',
      [userId, email.toLowerCase(), hash, 'student']);
    await con.execute('INSERT INTO students (id, user_id, full_name, registration_number) VALUES (?, ?, ?, ?)',
      [studId, userId, fullName, registrationNumber || null]);
    ok(res, {
      user:    { id: userId, email: email.toLowerCase() },
      student: { id: studId, user_id: userId, full_name: fullName, registration_number: registrationNumber },
    });
  } catch (e) { console.error(e); fail(res, 'Server error', 500); }
});

app.delete('/api/students/:id', async (req, res) => {
  try {
    const p = auth(req, res, 'admin'); if (!p) return;
    const con = await db();
    const [rows] = await con.execute('SELECT * FROM students WHERE id = ?', [req.params.id]);
    if (!rows[0]) return fail(res, 'Not found', 404);
    await con.execute('DELETE FROM users WHERE id = ?', [rows[0].user_id]);
    ok(res, { deleted: req.params.id });
  } catch (e) { fail(res, 'Server error', 500); }
});

// ── RESULTS ───────────────────────────────────────────────────
app.get('/api/results', async (req, res) => {
  try {
    const p = auth(req, res); if (!p) return;
    const con = await db();
    if (p.role === 'student') {
      const [sr] = await con.execute('SELECT id FROM students WHERE user_id = ?', [p.userId]);
      if (!sr[0]) return res.json([]);
      const [rows] = await con.execute('SELECT * FROM results WHERE student_id = ? ORDER BY created_at DESC', [sr[0].id]);
      return res.json(rows);
    }
    const sid = req.query.studentId;
    if (sid) {
      const [rows] = await con.execute('SELECT * FROM results WHERE student_id = ? ORDER BY created_at DESC', [sid]);
      return res.json(rows);
    }
    const [rows] = await con.execute(`
      SELECT r.*, s.full_name AS student_name
      FROM results r JOIN students s ON s.id = r.student_id
      ORDER BY r.created_at DESC`);
    res.json(rows);
  } catch (e) { fail(res, 'Server error', 500); }
});

app.post('/api/results', async (req, res) => {
  try {
    const p = auth(req, res, 'admin'); if (!p) return;
    const { studentId, subject, marks, grade, term, remarks } = req.body;
    if (!studentId || !subject || marks == null || !term) return fail(res, 'Missing fields');
    const con = await db();
    const id = uid();
    await con.execute(
      'INSERT INTO results (id, student_id, subject, marks, grade, term, remarks) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, studentId, subject, parseInt(marks), grade || null, term, remarks || null]);
    const [rows] = await con.execute('SELECT * FROM results WHERE id = ?', [id]);
    ok(res, rows[0]);
  } catch (e) { fail(res, 'Server error', 500); }
});

app.put('/api/results/:id', async (req, res) => {
  try {
    const p = auth(req, res, 'admin'); if (!p) return;
    const { subject, marks, grade, term, remarks } = req.body;
    const con = await db();
    await con.execute('UPDATE results SET subject=?, marks=?, grade=?, term=?, remarks=? WHERE id=?',
      [subject, parseInt(marks), grade, term, remarks, req.params.id]);
    const [rows] = await con.execute('SELECT * FROM results WHERE id = ?', [req.params.id]);
    ok(res, rows[0]);
  } catch (e) { fail(res, 'Server error', 500); }
});

app.delete('/api/results/:id', async (req, res) => {
  try {
    const p = auth(req, res, 'admin'); if (!p) return;
    const con = await db();
    await con.execute('DELETE FROM results WHERE id = ?', [req.params.id]);
    ok(res, { deleted: req.params.id });
  } catch (e) { fail(res, 'Server error', 500); }
});

// ── ASSIGNMENTS ───────────────────────────────────────────────
app.get('/api/assignments', async (req, res) => {
  try {
    const p = auth(req, res); if (!p) return;
    const con = await db();
    const [rows] = await con.execute('SELECT id, title, description, file_name, file_size, created_at FROM assignments ORDER BY created_at DESC');
    res.json(rows);
  } catch (e) { fail(res, 'Server error', 500); }
});

app.get('/api/assignments/:id/download', async (req, res) => {
  try {
    const p = auth(req, res); if (!p) return;
    const con = await db();
    const [rows] = await con.execute('SELECT * FROM assignments WHERE id = ?', [req.params.id]);
    const a = rows[0];
    if (!a || !fs.existsSync(a.file_path)) return fail(res, 'File not found', 404);
    res.download(a.file_path, a.file_name);
  } catch (e) { fail(res, 'Server error', 500); }
});

app.post('/api/assignments', upload.single('file'), async (req, res) => {
  try {
    const p = auth(req, res, 'admin'); if (!p) return;
    if (!req.file) return fail(res, 'PDF file required');
    const { title, description } = req.body;
    if (!title) return fail(res, 'Title required');
    const con = await db();
    const id = uid();
    await con.execute(
      'INSERT INTO assignments (id, title, description, file_name, file_path, file_size) VALUES (?, ?, ?, ?, ?, ?)',
      [id, title, description || null, req.file.originalname, req.file.path, req.file.size]);
    const [rows] = await con.execute('SELECT id, title, description, file_name, file_size, created_at FROM assignments WHERE id = ?', [id]);
    ok(res, rows[0]);
  } catch (e) { fail(res, 'Server error', 500); }
});

app.delete('/api/assignments/:id', async (req, res) => {
  try {
    const p = auth(req, res, 'admin'); if (!p) return;
    const con = await db();
    const [rows] = await con.execute('SELECT * FROM assignments WHERE id = ?', [req.params.id]);
    if (!rows[0]) return fail(res, 'Not found', 404);
    if (fs.existsSync(rows[0].file_path)) fs.unlinkSync(rows[0].file_path);
    await con.execute('DELETE FROM assignments WHERE id = ?', [req.params.id]);
    ok(res, { deleted: req.params.id });
  } catch (e) { fail(res, 'Server error', 500); }
});

// ── NOTES ─────────────────────────────────────────────────────
app.get('/api/notes', async (req, res) => {
  try {
    const p = auth(req, res); if (!p) return;
    const con = await db();
    const [rows] = await con.execute('SELECT id, title, subject, description, file_name, file_size, created_at FROM notes ORDER BY created_at DESC');
    res.json(rows);
  } catch (e) { fail(res, 'Server error', 500); }
});

app.get('/api/notes/:id/download', async (req, res) => {
  try {
    const p = auth(req, res); if (!p) return;
    const con = await db();
    const [rows] = await con.execute('SELECT * FROM notes WHERE id = ?', [req.params.id]);
    const n = rows[0];
    if (!n || !fs.existsSync(n.file_path)) return fail(res, 'File not found', 404);
    res.download(n.file_path, n.file_name);
  } catch (e) { fail(res, 'Server error', 500); }
});

app.post('/api/notes', upload.single('file'), async (req, res) => {
  try {
    const p = auth(req, res, 'admin'); if (!p) return;
    if (!req.file) return fail(res, 'PDF file required');
    const { title, subject, description } = req.body;
    if (!title || !subject) return fail(res, 'Title and subject required');
    const con = await db();
    const id = uid();
    await con.execute(
      'INSERT INTO notes (id, title, subject, description, file_name, file_path, file_size) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, title, subject, description || null, req.file.originalname, req.file.path, req.file.size]);
    const [rows] = await con.execute('SELECT id, title, subject, description, file_name, file_size, created_at FROM notes WHERE id = ?', [id]);
    ok(res, rows[0]);
  } catch (e) { fail(res, 'Server error', 500); }
});

app.delete('/api/notes/:id', async (req, res) => {
  try {
    const p = auth(req, res, 'admin'); if (!p) return;
    const con = await db();
    const [rows] = await con.execute('SELECT * FROM notes WHERE id = ?', [req.params.id]);
    if (!rows[0]) return fail(res, 'Not found', 404);
    if (fs.existsSync(rows[0].file_path)) fs.unlinkSync(rows[0].file_path);
    await con.execute('DELETE FROM notes WHERE id = ?', [req.params.id]);
    ok(res, { deleted: req.params.id });
  } catch (e) { fail(res, 'Server error', 500); }
});

// ── SUBMISSIONS ───────────────────────────────────────────────
app.get('/api/submissions', async (req, res) => {
  try {
    const p = auth(req, res); if (!p) return;
    const con = await db();
    if (p.role === 'student') {
      const [sr] = await con.execute('SELECT id FROM students WHERE user_id = ?', [p.userId]);
      if (!sr[0]) return res.json([]);
      const [rows] = await con.execute(
        'SELECT id, assignment_id, title, file_name, file_size, submitted_at FROM submissions WHERE student_id = ? ORDER BY submitted_at DESC',
        [sr[0].id]);
      return res.json(rows);
    }
    const [rows] = await con.execute(`
      SELECT sub.id, sub.assignment_id, sub.title, sub.file_name, sub.file_size, sub.submitted_at,
             s.full_name AS student_name, s.id AS student_id
      FROM submissions sub
      JOIN students s ON s.id = sub.student_id
      ORDER BY sub.submitted_at DESC`);
    res.json(rows);
  } catch (e) { fail(res, 'Server error', 500); }
});

app.get('/api/submissions/:id/download', async (req, res) => {
  try {
    const p = auth(req, res, 'admin'); if (!p) return;
    const con = await db();
    const [rows] = await con.execute('SELECT * FROM submissions WHERE id = ?', [req.params.id]);
    const s = rows[0];
    if (!s || !fs.existsSync(s.file_path)) return fail(res, 'File not found', 404);
    res.download(s.file_path, s.file_name);
  } catch (e) { fail(res, 'Server error', 500); }
});

app.post('/api/submissions', upload.single('file'), async (req, res) => {
  try {
    const p = auth(req, res, 'student'); if (!p) return;
    if (!req.file) return fail(res, 'PDF file required');
    const con = await db();
    const [sr] = await con.execute('SELECT id FROM students WHERE user_id = ?', [p.userId]);
    if (!sr[0]) return fail(res, 'Student not found', 404);
    const { assignmentId, title } = req.body;
    if (assignmentId) {
      const [dup] = await con.execute(
        'SELECT id FROM submissions WHERE student_id = ? AND assignment_id = ?',
        [sr[0].id, assignmentId]);
      if (dup.length > 0) return fail(res, 'Already submitted');
    }
    const id = uid();
    await con.execute(
      'INSERT INTO submissions (id, student_id, assignment_id, title, file_name, file_path, file_size) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, sr[0].id, assignmentId || null, title || req.file.originalname, req.file.originalname, req.file.path, req.file.size]);
    const [rows] = await con.execute('SELECT id, assignment_id, title, file_name, file_size, submitted_at FROM submissions WHERE id = ?', [id]);
    ok(res, rows[0]);
  } catch (e) { console.error(e); fail(res, 'Server error', 500); }
});

// ── Health check ──────────────────────────────────────────────
app.get('/api/health', (req, res) =>
  res.json({ status: 'ok', db: 'mysql', time: new Date().toISOString() }));

// ── Boot ──────────────────────────────────────────────────────
setupDatabase()
  .then(() => app.listen(PORT, () => {
    console.log(`✅ PowerClass API → http://localhost:${PORT}`);
    console.log(`   Login: zayeed728@gmail.com / zayd1234`);
  }))
  .catch(err => {
    console.error('❌ MySQL connection failed:', err.message);
    process.exit(1);
  });
