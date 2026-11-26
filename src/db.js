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
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  owner_phone TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  system_prompt TEXT NOT NULL,
  skills_json TEXT NOT NULL DEFAULT '[]',
  mode TEXT NOT NULL DEFAULT 'assist',
  tools_json TEXT NOT NULL DEFAULT '[]',
  mcp_json TEXT NOT NULL DEFAULT '[]',
  snapshot_hash TEXT,
  qca_agent_id TEXT,
  qca_version INTEGER,
  sync_note TEXT,
  sync_error TEXT,
  synced_at TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS ai_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  text TEXT NOT NULL,
  decision TEXT,
  created_at TEXT
);
`)

// 存量库迁移：CREATE IF NOT EXISTS 不会补列，逐个兜底加
for (const ddl of [
  "ALTER TABLE agents ADD COLUMN mode TEXT NOT NULL DEFAULT 'assist'",
  "ALTER TABLE agents ADD COLUMN tools_json TEXT NOT NULL DEFAULT '[]'",
  "ALTER TABLE agents ADD COLUMN mcp_json TEXT NOT NULL DEFAULT '[]'",
  "ALTER TABLE ai_notes ADD COLUMN decision TEXT",
]) {
  try { db.prepare(ddl).run() } catch { /* 列已存在 */ }
}

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
  listAgents(ownerPhone) {
    return db.prepare('SELECT * FROM agents WHERE owner_phone = ? ORDER BY created_at DESC').all(ownerPhone)
  },
  findAgent(id) {
    return db.prepare('SELECT * FROM agents WHERE id = ?').get(id)
  },
  findAgentByName(ownerPhone, name) {
    return db.prepare('SELECT * FROM agents WHERE owner_phone = ? AND name = ?').get(ownerPhone, name)
  },
  insertAgent(a) {
    db.prepare(`INSERT INTO agents (id, owner_phone, name, description, system_prompt, skills_json, mode, tools_json, mcp_json, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(a.id, a.owner_phone, a.name, a.description ?? '', a.system_prompt, JSON.stringify(a.skills ?? []), a.mode ?? 'assist', JSON.stringify(a.tools ?? []), JSON.stringify(a.mcpServers ?? []), new Date().toISOString(), new Date().toISOString())
  },
  updateAgent(a) {
    db.prepare(`UPDATE agents SET name=?, description=?, system_prompt=?, skills_json=?, mode=?, tools_json=?, mcp_json=?, updated_at=? WHERE id=?`)
      .run(a.name, a.description ?? '', a.system_prompt, JSON.stringify(a.skills ?? []), a.mode ?? 'assist', JSON.stringify(a.tools ?? []), JSON.stringify(a.mcpServers ?? []), new Date().toISOString(), a.id)
  },
  updateAgentSync(id, fields) {
    const sets = Object.keys(fields).map((k) => `${k}=?`).join(', ')
    db.prepare(`UPDATE agents SET ${sets} WHERE id=?`).run(...Object.values(fields), id)
  },
  deleteAgent(id) {
    db.prepare('DELETE FROM agents WHERE id=?').run(id)
  },
}
