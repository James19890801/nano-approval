import Database from 'better-sqlite3'

// better-sqlite3 不支持 SELECT ... FOR UPDATE（单写者天然串行），剥掉即可
const strip = (sql) => sql.replace(/\s+FOR UPDATE\b/gi, '')
const conv = (args) => args.map((a) => (a instanceof Date ? a.toISOString() : a === undefined ? null : a))

class SqliteConnection {
  constructor(db) {
    this.db = db
  }
  async execute(sql, args = []) {
    this.db.prepare(strip(sql)).run(...conv(args))
  }
  async fetchOne(sql, args = []) {
    return this.db.prepare(strip(sql)).get(...conv(args)) ?? null
  }
  async fetchAll(sql, args = []) {
    return this.db.prepare(strip(sql)).all(...conv(args))
  }
  async begin() {
    this.db.exec('BEGIN')
  }
  async commit() {
    this.db.exec('COMMIT')
  }
  async rollback() {
    try {
      this.db.exec('ROLLBACK')
    } catch {
      // 无活动事务时静默
    }
  }
}

export class SqliteAdapter {
  constructor(db) {
    this.db = db
    this.placeholder = '?'
  }
  async acquire() {
    return new SqliteConnection(this.db)
  }
  async release() {}
}
