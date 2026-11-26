import Database from 'better-sqlite3'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '..', 'data')
import fs from 'node:fs'
fs.mkdirSync(DATA_DIR, { recursive: true })

export const db = new Database(path.join(DATA_DIR, 'app.db'))
db.pragma('journal_mode = WAL')

// jeeflow 引擎表（列对齐 JdbcRepository 核心 SQL）
db.exec(`
CREATE TABLE IF NOT EXISTS wf_process_define (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  display_name TEXT,
  type TEXT,
  state INTEGER,
  content TEXT,
  version INTEGER,
  create_time TEXT,
  create_user TEXT,
  update_time TEXT,
  update_user TEXT
);
CREATE TABLE IF NOT EXISTS wf_process_instance (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  process_define_id TEXT,
  state INTEGER,
  parent_node_name TEXT,
  business_no TEXT,
  operator TEXT,
  expire_time TEXT,
  variable TEXT,
  create_time TEXT,
  create_user TEXT,
  update_time TEXT,
  update_user TEXT
);
CREATE TABLE IF NOT EXISTS wf_process_task (
  id TEXT PRIMARY KEY,
  process_instance_id TEXT,
  task_name TEXT,
  display_name TEXT,
  task_type INTEGER,
  perform_type INTEGER,
  task_state INTEGER,
  operator TEXT,
  finish_time TEXT,
  expire_time TEXT,
  form_key TEXT,
  task_parent_id TEXT,
  variable TEXT,
  create_time TEXT,
  create_user TEXT,
  update_time TEXT,
  update_user TEXT
);
CREATE TABLE IF NOT EXISTS wf_process_task_actor (
  id TEXT PRIMARY KEY,
  process_task_id TEXT,
  actor_id TEXT,
  create_time TEXT,
  create_user TEXT
);
CREATE TABLE IF NOT EXISTS wf_process_cc_instance (
  id TEXT PRIMARY KEY,
  process_instance_id TEXT,
  actor_id TEXT,
  state INTEGER,
  create_time TEXT,
  create_user TEXT,
  update_time TEXT,
  update_user TEXT
);
`)

// 宿主应用表
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  phone TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  form_json TEXT NOT NULL,
  flow_json TEXT NOT NULL,
  created_at TEXT,
  created_by TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS ai_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS qca_bindings (
  lock_key TEXT PRIMARY KEY,
  state_json TEXT NOT NULL,
  token TEXT,
  updated_at TEXT
);
`)

export const q = {
  upsertUser(phone, name) {
    db.prepare('INSERT INTO users (phone, name, created_at) VALUES (?,?,?)')
      .run(phone, name, new Date().toISOString())
  },
  findUser(phone) {
    return db.prepare('SELECT * FROM users WHERE phone = ?').get(phone)
  },
  updateUser(phone, name) {
    db.prepare('UPDATE users SET name = ? WHERE phone = ?').run(name, phone)
  },
  createSession(token, phone) {
    db.prepare('INSERT INTO sessions (token, phone, created_at) VALUES (?,?,?)')
      .run(token, phone, new Date().toISOString())
  },
  findSession(token) {
    return db.prepare('SELECT * FROM sessions WHERE token = ?').get(token)
  },
  listTemplates() {
    return db.prepare('SELECT * FROM templates ORDER BY created_at DESC').all()
  },
  findTemplate(id) {
    return db.prepare('SELECT * FROM templates WHERE id = ?').get(id)
  },
  findTemplateByName(name) {
    return db.prepare('SELECT * FROM templates WHERE name = ?').get(name)
  },
  insertTemplate(t) {
    db.prepare(`INSERT INTO templates (id, name, display_name, form_json, flow_json, created_at, created_by, updated_at)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(t.id, t.name, t.display_name, t.form_json, t.flow_json, new Date().toISOString(), t.created_by, new Date().toISOString())
  },
  updateTemplate(t) {
    db.prepare(`UPDATE templates SET name=?, display_name=?, form_json=?, flow_json=?, updated_at=? WHERE id=?`)
      .run(t.name, t.display_name, t.form_json, t.flow_json, new Date().toISOString(), t.id)
  },
}
