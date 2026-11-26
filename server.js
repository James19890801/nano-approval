import express from 'express'
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { db, q } from './src/db.js'
import {
  deployTemplate, startInstance, agree, reject,
  listTodo, listDone, listMyInstances, instanceDetail,
} from './src/engine.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

const COOKIE = 'sid'

// ── 会话 ────────────────────────────────────────────────────────────────────
function currentUser(req) {
  const token = (req.headers.cookie || '').match(/sid=([^;]+)/)?.[1]
  if (!token) return null
  const session = q.findSession(token)
  if (!session) return null
  return q.findUser(session.phone)
}

function requireLogin(req, res, next) {
  const user = currentUser(req)
  if (!user) return res.status(401).json({ error: '未登录' })
  req.user = user
  next()
}

// ── 认证：手机号 + 姓名，登录即注册 ─────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const name = String(req.body.name || '').trim()
  const phone = String(req.body.phone || '').trim()
  if (!name || !/^1\d{10}$/.test(phone)) {
    return res.status(400).json({ error: '请填写姓名和 11 位手机号' })
  }
  const existing = q.findUser(phone)
  if (existing) {
    if (existing.name !== name) q.updateUser(phone, name)
  } else {
    q.upsertUser(phone, name)
  }
  const token = crypto.randomBytes(24).toString('hex')
  q.createSession(token, phone)
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; Max-Age=2592000; SameSite=Lax`)
  res.json({ phone, name })
})

app.post('/api/logout', (req, res) => {
  const token = (req.headers.cookie || '').match(/sid=([^;]+)/)?.[1]
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token)
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; Max-Age=0`)
  res.json({ ok: true })
})

app.get('/api/me', (req, res) => {
  const user = currentUser(req)
  if (!user) return res.status(401).json({ error: '未登录' })
  res.json(user)
})

app.get('/api/users', requireLogin, (req, res) => {
  res.json(db.prepare('SELECT phone, name FROM users ORDER BY created_at').all())
})

// ── 模板：一份 JSON 同时描述表单与流程 ──────────────────────────────────────
function tplFromConfig(config, createdBy) {
  const { name, displayName, form, flow } = config
  if (!name || !displayName || !Array.isArray(form) || !flow || !Array.isArray(flow.nodes)) {
    throw new Error('配置须包含 name、displayName、form(数组)、flow(nodes/edges)')
  }
  flow.name = name
  flow.displayName = displayName
  flow.type = flow.type ?? 'approval'
  return {
    id: q.findTemplateByName(name)?.id ?? 'tpl_' + crypto.randomBytes(6).toString('hex'),
    name, display_name: displayName,
    form_json: JSON.stringify(form),
    flow_json: JSON.stringify(flow),
    created_by: createdBy,
  }
}

app.get('/api/templates', requireLogin, (req, res) => {
  res.json(q.listTemplates().map((t) => ({
    id: t.id, name: t.name, display_name: t.display_name,
    form: JSON.parse(t.form_json),
  })))
})

app.post('/api/templates', requireLogin, async (req, res) => {
  try {
    const tpl = tplFromConfig(req.body, req.user.phone)
    if (q.findTemplate(tpl.id)) q.updateTemplate(tpl)
    else q.insertTemplate(tpl)
    await deployTemplate(tpl)
    res.json({ id: tpl.id, ok: true })
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) })
  }
})

app.get('/api/templates/:id', requireLogin, (req, res) => {
  const t = q.findTemplate(req.params.id)
  if (!t) return res.status(404).json({ error: '模板不存在' })
  res.json({
    id: t.id, name: t.name, display_name: t.display_name,
    form: JSON.parse(t.form_json), flow: JSON.parse(t.flow_json),
  })
})

// ── 流程实例 ────────────────────────────────────────────────────────────────
app.post('/api/instances', requireLogin, async (req, res) => {
  try {
    const tpl = q.findTemplate(req.body.templateId)
    if (!tpl) return res.status(404).json({ error: '模板不存在' })
    const form = JSON.parse(tpl.form_json)
    const values = {}
    for (const f of form) {
      const v = req.body.values?.[f.key]
      if (f.required && (v === undefined || v === null || String(v).trim() === '')) {
        return res.status(400).json({ error: `请填写「${f.label}」` })
      }
      if (v !== undefined && v !== null && String(v).trim() !== '') values[f.key] = v
    }
    const instanceId = await startInstance(req.user, tpl, values)
    res.json({ instanceId })
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) })
  }
})

app.get('/api/todo', requireLogin, async (req, res) => {
  res.json(await listTodo(req.user.phone))
})

app.get('/api/done', requireLogin, async (req, res) => {
  res.json(await listDone(req.user.phone))
})

app.get('/api/my-instances', requireLogin, async (req, res) => {
  res.json(await listMyInstances(req.user.phone))
})

app.get('/api/instances/:id', requireLogin, async (req, res) => {
  const detail = await instanceDetail(req.params.id)
  if (!detail) return res.status(404).json({ error: '实例不存在' })
  const { inst, history, doing, form, aiNotes } = detail
  const stateText = { 10: '进行中', 20: '已通过', 30: '已撤回', 40: '已终止', 45: '已拒绝', 99: '已废弃' }
  res.json({
    id: inst.id,
    state: inst.state,
    stateText: stateText[inst.state] ?? String(inst.state),
    operator: inst.operator,
    operatorName: q.findUser(inst.operator)?.name ?? inst.operator,
    variables: inst.variables,
    createTime: inst.createTime,
    form,
    history: history.map((t) => ({
      id: t.id, displayName: t.displayName, taskName: t.taskName,
      operator: t.operator, actorIds: t.actorIds,
      actorNames: (t.actorIds || []).map((p) => q.findUser(p)?.name ?? p).join('、'),
      taskState: t.taskState, finishTime: t.finishTime,
      comment: aiNotes[t.taskName] ?? t.variables?.tf_approvalComment ?? '',
    })),
    doing: doing.map((t) => ({
      id: t.id, displayName: t.displayName, actorIds: t.actorIds,
      actorNames: (t.actorIds || []).map((p) => q.findUser(p)?.name ?? p).join('、'),
      createTime: t.createTime,
    })),
  })
})

// ── 审批动作 ────────────────────────────────────────────────────────────────
app.post('/api/tasks/:id/agree', requireLogin, async (req, res) => {
  try {
    await agree(req.params.id, req.user.phone, req.body.comment)
    res.json({ ok: true })
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) })
  }
})

app.post('/api/tasks/:id/reject', requireLogin, async (req, res) => {
  try {
    await reject(req.params.id, req.user.phone, req.body.comment)
    res.json({ ok: true })
  } catch (err)    {
    res.status(400).json({ error: String(err.message || err) })
  }
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`nano-approval 已启动: http://localhost:${PORT}`)
})
