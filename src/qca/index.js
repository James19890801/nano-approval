import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'
import { createCloudAgentsClient, ensureCloudResources } from './cloud-agents.mjs'
import { db } from '../db.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ENV_FILE = path.join(__dirname, '..', '..', 'data', 'qca.env')

// PAT 只在进程内使用，绝不打印、绝不入日志
function loadEnvFile(file) {
  try {
    const out = {}
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
      if (m && !m[1].startsWith('#')) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
    return out
  } catch {
    return {}
  }
}

const env = loadEnvFile(ENV_FILE)
export const QCA_ORIGIN = env.QCA_API_ORIGIN || 'https://api.qoder.com'
const PAT = env.QODER_PAT && !env.QODER_PAT.includes('粘贴') ? env.QODER_PAT : ''

export function qcaConfigured() {
  return Boolean(PAT && PAT.trim())
}

export const cloud = createCloudAgentsClient({
  origin: QCA_ORIGIN,
  getToken: () => PAT,
  timeoutMs: 30000,
})

// ── 单进程部署下的持久协调器：进程内互斥 + SQLite 绑定行 ──
const locks = new Map()
const coordinator = {
  withLock(key, callback) {
    const prev = locks.get(key) ?? Promise.resolve()
    const run = prev.then(async () => {
      const token = crypto.randomUUID()
      db.prepare('INSERT OR IGNORE INTO qca_bindings (lock_key, state_json, token, updated_at) VALUES (?,?,?,?)')
        .run(key, JSON.stringify({}), null, new Date().toISOString())
      db.prepare('UPDATE qca_bindings SET token = ?, updated_at = ? WHERE lock_key = ?').run(token, new Date().toISOString(), key)
      const lease = {
        async read() {
          const row = db.prepare('SELECT state_json FROM qca_bindings WHERE lock_key = ?').get(key)
          if (!row) return null
          const state = JSON.parse(row.state_json)
          // 空占位行（无 state 字段）视作无记录，否则 ensureCloudResources 会当成未完成的创建意图
          return state && typeof state === 'object' && 'state' in state ? state : null
        },
        async write(state) {
          db.prepare('UPDATE qca_bindings SET state_json = ?, updated_at = ? WHERE lock_key = ? AND token = ?')
            .run(JSON.stringify(state), new Date().toISOString(), key, token)
        },
        async assertHeld() {
          const row = db.prepare('SELECT token FROM qca_bindings WHERE lock_key = ?').get(key)
          if (row?.token !== token) throw new Error('lease lost')
        },
      }
      return callback(lease)
    })
    locks.set(key, run.catch(() => {}))
    return run
  },
}

const APP_SCOPE = 'nano-approval'
const AGENT_NAME = 'nano-approval 模板生成器'

const SYSTEM_PROMPT = `你是审批平台的模板生成器。根据用户的一句话描述，生成审批模板配置。

只输出一个 JSON 对象，不要 markdown 代码块、不要解释文字。结构：
{
  "name": "英文短标识(如 leave)",
  "displayName": "中文名称",
  "form": [ { "key": "英文小驼峰", "label": "中文标签", "type": "text|number|textarea|select", "required": true, "options": ["仅select需要"] } ],
  "flow": { "nodes": [...], "edges": [...] }
}

flow 节点规范（按顺序线性排列，除非用户明确要求分支）：
1. { "id": "start", "type": "snaker:start", "properties": {}, "text": { "value": "开始" } }
2. { "id": "apply", "type": "snaker:task", "properties": { "assignee": "applicant" }, "text": { "value": "发起申请" } }
3. 若用户提到 AI 初审/智能审核，加一个 { "id": "ai", "type": "snaker:custom", "properties": { "clazz": "ai_review", "val": "aiOpinion" }, "text": { "value": "AI 初审" } }
4. 每个审批人一个节点：{ "id": "approve1", "type": "snaker:task", "properties": { "assignee": "审批人手机号" }, "text": { "value": "XX审批" } }
   用户没有给出手机号时，assignee 填 "13800000000" 占位，并在 text 里带上审批人称呼。
5. { "id": "end", "type": "snaker:end", "properties": {}, "text": { "value": "结束" } }

edges 按节点顺序连接：{ "id": "e1", "sourceNodeId": "start", "targetNodeId": "apply", "properties": {} }

form 的字段从用户的描述里提取，够用即可，不要超过 6 个。`

let bindingPromise = null

async function ensureBinding() {
  if (!qcaConfigured()) throw new Error('QCA 未配置：请复制 qca.env.example 为 data/qca.env 并填入 QODER_PAT')
  if (bindingPromise) return bindingPromise
  bindingPromise = (async () => {
    const models = await cloud.request('/api/v1/cloud/models')
    const list = (models?.data ?? []).filter((m) => m?.is_enabled)
    const model = (list.find((m) => /高级|Pro/i.test(m.display_name ?? '')) ?? list[0])?.id
    if (!model) throw new Error('QCA 无可用模型')
    return ensureCloudResources({
      client: cloud,
      coordinator,
      applicationScope: APP_SCOPE,
      agent: {
        name: AGENT_NAME,
        model,
        system: SYSTEM_PROMPT,
        tools: [],
        metadata: { app: APP_SCOPE, purpose: 'tpl-gen' },
      },
      environment: {
        name: 'nano-approval environment',
        config: { type: 'cloud' },
        metadata: { app: APP_SCOPE, purpose: 'tpl-gen' },
      },
    })
  })()
  return bindingPromise
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 等待 Agent 回复：轮询事件列表，agent.message 稳定或出现完成态即返回
async function waitForReply(sessionId, { timeoutMs = 120000, intervalMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let lastCount = -1
  let stable = 0
  while (Date.now() < deadline) {
    await sleep(intervalMs)
    const result = await cloud.request(`/api/v1/cloud/sessions/${sessionId}/events?order=asc&limit=100`)
    const events = Array.isArray(result?.data) ? result.data : []
    const reply = events
      .filter((e) => String(e.type ?? '').startsWith('agent.message'))
      .map((e) => (Array.isArray(e.content) ? e.content : []).filter((b) => b?.type === 'text').map((b) => b.text ?? '').join(''))
      .join('')
    const finished = events.some((e) => {
      const t = String(e.type ?? '')
      return /status|state|done|finish|complete/i.test(t) && /idle|completed|finished|done/i.test(JSON.stringify(e))
    })
    if (reply && (finished || events.length === lastCount)) {
      if (finished || ++stable >= 2) return reply
    } else {
      stable = 0
    }
    lastCount = events.length
  }
  throw new Error('AI 响应超时，请稍后重试')
}

function extractJson(text) {
  const stripped = text.replace(/```(?:json)?/g, '').trim()
  const start = stripped.indexOf('{')
  const end = stripped.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('AI 未返回 JSON')
  return JSON.parse(stripped.slice(start, end + 1))
}

function validateTemplateConfig(config) {
  const problems = []
  if (!config.name || !/^[a-z][a-z0-9_-]*$/i.test(config.name)) problems.push('name 须为英文短标识')
  if (!config.displayName) problems.push('缺少 displayName')
  if (!Array.isArray(config.form) || config.form.length === 0) problems.push('form 须为非空数组')
  else {
    for (const f of config.form) {
      if (!f.key || !f.label || !f.type) problems.push(`表单项缺 key/label/type: ${JSON.stringify(f).slice(0, 60)}`)
      if (f.type === 'select' && !Array.isArray(f.options)) problems.push(`select 字段「${f.label}」缺 options`)
    }
  }
  const flow = config.flow
  if (!flow || !Array.isArray(flow.nodes) || !Array.isArray(flow.edges)) problems.push('flow 缺 nodes/edges')
  else {
    const ids = flow.nodes.map((n) => n.id)
    if (ids.filter((i) => i === 'start').length !== 1 || ids.filter((i) => i === 'end').length !== 1) problems.push('flow 必须恰有一个 start 和一个 end')
    if (!ids.includes('apply')) problems.push('flow 第二个节点须为 apply（发起申请）')
    for (const n of flow.nodes) {
      if (n.type === 'snaker:task' && !n.properties?.assignee) problems.push(`任务节点「${n.text?.value ?? n.id}」缺 assignee`)
    }
    for (const e of flow.edges) {
      if (!ids.includes(e.sourceNodeId) || !ids.includes(e.targetNodeId)) problems.push(`边引用了不存在的节点: ${e.id}`)
    }
  }
  return problems
}

// 一句话 → 模板配置 JSON（未经入库，由用户确认后保存）
export async function generateTemplate(sentence) {
  const binding = await ensureBinding()
  const session = await cloud.request('/api/v1/cloud/sessions', {
    method: 'POST',
    body: { ...binding, title: '模板生成', metadata: { app: APP_SCOPE, purpose: 'tpl-gen' } },
  })
  if (!session?.id) throw new Error('QCA 会话创建失败')
  await cloud.request(`/api/v1/cloud/sessions/${session.id}/events`, {
    method: 'POST',
    body: { events: [{ type: 'user.message', content: [{ type: 'text', text: sentence }] }] },
  })
  const reply = await waitForReply(session.id)
  const config = extractJson(reply)
  const problems = validateTemplateConfig(config)
  if (problems.length > 0) {
    const err = new Error('生成的模板未通过校验：' + problems.join('；'))
    err.raw = reply.slice(0, 500)
    throw err
  }
  return config
}
