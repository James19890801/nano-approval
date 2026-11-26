import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import AdmZip from 'adm-zip'
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
5. 智能体节点后如果该智能体是自动审批模式（auto），必须紧跟一个隐藏审批节点：
   { "id": "auto1", "type": "snaker:task", "properties": { "assignee": "auto_agent" }, "text": { "value": "智能体审批" } }
   该节点由平台按智能体判定自动通过/驳回，人工待办不可见。
6. { "id": "end", "type": "snaker:end", "properties": {}, "text": { "value": "结束" } }

edges 按节点顺序连接：{ "id": "e1", "sourceNodeId": "start", "targetNodeId": "apply", "properties": {} }

form 的字段从用户的描述里提取，够用即可，不要超过 6 个。`

let bindingPromise = null

async function pickModel() {
  const models = await cloud.request('/api/v1/cloud/models')
  const list = (models?.data ?? []).filter((m) => m?.is_enabled)
  const model = (list.find((m) => /高级|Pro/i.test(m.display_name ?? '')) ?? list[0])?.id
  if (!model) throw new Error('QCA 无可用模型')
  return model
}

// 全平台共享一个云端 Environment（cloud 类型，session 级隔离）
let envPromise = null
async function ensureEnvironment() {
  if (envPromise) return envPromise
  envPromise = (async () => {
    const found = await cloud.findResources('environments', { app: APP_SCOPE, purpose: 'runtime' })
    if (found.length > 0) return found[0].id
    const env = await cloud.request('/api/v1/cloud/environments', {
      method: 'POST',
      body: { name: 'nano-approval runtime', config: { type: 'cloud' }, metadata: { app: APP_SCOPE, purpose: 'runtime' } },
    })
    if (!env?.id) throw new Error('QCA 环境创建失败')
    return env.id
  })()
  return envPromise
}

async function ensureBinding() {
  if (!qcaConfigured()) throw new Error('QCA 未配置：请复制 qca.env.example 为 data/qca.env 并填入 QODER_PAT')
  if (bindingPromise) return bindingPromise
  bindingPromise = (async () => {
    const model = await pickModel()
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
// agents：调用者已配置的智能体清单，供生成器插入 qca_agent 节点
export async function generateTemplate(sentence, agents = []) {
  const binding = await ensureBinding()
  let prompt = sentence
  if (agents.length > 0) {
    const list = agents.map((a) => `- id=${a.id} 名称「${a.name}」 模式：${a.mode === 'auto' ? '自动审批' : '辅助'} 职责：${(a.description || a.system_prompt || '').slice(0, 80)}`).join('\n')
    prompt += `\n\n用户已配置以下智能体（若描述中的某环节与其职责匹配，插入节点 { "type": "snaker:custom", "properties": { "clazz": "qca_agent", "agentId": "<该id>", "val": "agentOpinion" }, "text": { "value": "<智能体名>" } }；自动审批模式的智能体其后必须再插入 assignee 为 "auto_agent" 的隐藏审批节点）：\n${list}`
  }
  const session = await cloud.request('/api/v1/cloud/sessions', {
    method: 'POST',
    body: { ...binding, title: '模板生成', metadata: { app: APP_SCOPE, purpose: 'tpl-gen' } },
  })
  if (!session?.id) throw new Error('QCA 会话创建失败')
  await cloud.request(`/api/v1/cloud/sessions/${session.id}/events`, {
    method: 'POST',
    body: { events: [{ type: 'user.message', content: [{ type: 'text', text: prompt }] }] },
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

// ── 用户智能体：快照（提示词 + skills）→ QCA Cloud Agent ───────────────────

function snapshotHash(agent) {
  const skills = (JSON.parse(agent.skills_json || '[]') || [])
    .map((s) => [s.title, s.content])
  const tools = JSON.parse(agent.tools_json || '[]')
  const mcp = JSON.parse(agent.mcp_json || '[]').map((m) => [m.name, m.url])
  return crypto.createHash('sha256')
    .update(JSON.stringify([agent.name, agent.description, agent.system_prompt, agent.mode, skills, tools, mcp]))
    .digest('hex')
}

function skillSlug(title) {
  const slug = String(title).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
  return slug || 'skill'
}

function skillZipBuffer(title, content) {
  const slug = skillSlug(title)
  const md = `---\nname: ${slug}\ndescription: ${title}\n---\n\n# ${title}\n\n${content}\n`
  const zip = new AdmZip()
  zip.addFile(`${slug}/SKILL.md`, Buffer.from(md, 'utf8'))
  return zip.toBuffer()
}

// multipart/raw 通道：官方客户端只白名单 JSON 路径，skills 走这里。
// latest_version 是 16 位 epoch 微秒数（>2^53），JSON.parse 会丢精度，
// 必须从原始文本按字符串提取；创建版本响应里的 id 是 skillver_（版本 id），
// 不能当 skill id 用。
async function rawSkillCall(url, { method = 'GET', buffer } = {}) {
  if (!qcaConfigured()) throw new Error('QCA 未配置')
  let body
  const headers = { Authorization: `Bearer ${PAT}` }
  if (buffer !== undefined) {
    const form = new FormData()
    form.append('files', new Blob([buffer], { type: 'application/zip' }), 'skill.zip')
    body = form
  }
  const res = await fetch(new URL(url, QCA_ORIGIN), { method, headers, body })
  const text = await res.text()
  if (!res.ok) throw new Error(`skill 请求失败(${res.status})`)
  return {
    id: text.match(/"id"\s*:\s*"([^"]+)"/)?.[1],
    latest_version: text.match(/"latest_version"\s*:\s*"?(\d+)"?/)?.[1],
  }
}

export async function syncAgentToQca(agent) {
  if (!qcaConfigured()) throw new Error('QCA 未配置：请复制 qca.env.example 为 data/qca.env 并填入 QODER_PAT')
  const model = await pickModel()
  const skills = JSON.parse(agent.skills_json || '[]') || []
  const notes = []
  const bindings = []
  let system = agent.system_prompt
  for (const s of skills) {
    if (!s.title || !s.content) continue
    try {
      const buffer = skillZipBuffer(s.title, s.content)
      if (s.qca_skill_id) {
        await rawSkillCall(`/api/v1/cloud/skills/${s.qca_skill_id}/versions`, { method: 'POST', buffer })
      } else {
        const created = await rawSkillCall('/api/v1/cloud/skills', { method: 'POST', buffer })
        if (!/^skill_/.test(created.id ?? '')) throw new Error('响应缺少 skill id')
        s.qca_skill_id = created.id
      }
      // 回查详情拿最新版本号，绑定钉住刚上传的版本
      const detail = await rawSkillCall(`/api/v1/cloud/skills/${s.qca_skill_id}`)
      s.qca_version = detail.latest_version
      if (!s.qca_skill_id || !s.qca_version) throw new Error('缺少 id/version')
      bindings.push({ type: 'custom', skill_id: s.qca_skill_id, version: String(s.qca_version) })
      notes.push(`skill「${s.title}」已上传云端`)
    } catch (e) {
      // 云端 Skills 未开通/配额不足时降级：内容并入 system 提示词
      system += `\n\n# 技能：${s.title}\n${s.content}`
      notes.push(`skill「${s.title}」以内联提示词生效`)
    }
  }
  const body = {
    name: `nano-approval/${agent.name}`.slice(0, 256),
    model,
    system,
    description: agent.description ?? '',
    metadata: { app: APP_SCOPE, hostAgentId: agent.id, owner: agent.owner_phone },
  }
  // 工具集与 MCP 服务器：让 skill 具备调接口/调 MCP 的能力
  const tools = JSON.parse(agent.tools_json || '[]')
  if (Array.isArray(tools) && tools.length > 0) {
    body.tools = [{ type: 'agent_toolset_20260401', enabled_tools: tools.slice(0, 20) }]
  }
  const mcp = JSON.parse(agent.mcp_json || '[]')
  if (Array.isArray(mcp) && mcp.length > 0) {
    body.mcp_servers = mcp
      .filter((m) => m.name && m.url && /^https?:\/\//.test(m.url))
      .slice(0, 20)
      .map((m) => ({ type: 'url', name: m.name, url: m.url }))
  }
  if (bindings.length > 0) body.skills = bindings
  let res
  if (agent.qca_agent_id) {
    const bodyWithVersion = { ...body, version: agent.qca_version }
    try {
      res = await cloud.request(`/api/v1/cloud/agents/${agent.qca_agent_id}`, { method: 'POST', body: bodyWithVersion })
    } catch (err) {
      // OCC 版本落后（例如云端被其它途径更新过）：拉当前版本重试一次
      if (err.code !== 'ai_conflict') throw err
      const current = await cloud.request(`/api/v1/cloud/agents/${agent.qca_agent_id}`)
      res = await cloud.request(`/api/v1/cloud/agents/${agent.qca_agent_id}`, {
        method: 'POST',
        body: { ...bodyWithVersion, version: current?.version },
      })
    }
  } else {
    res = await cloud.request('/api/v1/cloud/agents', {
      method: 'POST',
      body,
      idempotencyKey: `nano-agent-${agent.id}`,
    })
  }
  if (!res?.id || !Number.isInteger(res.version)) throw new Error('QCA Agent 同步失败')
  db.prepare(`UPDATE agents SET qca_agent_id=?, qca_version=?, skills_json=?, snapshot_hash=?, sync_note=?, sync_error=NULL, synced_at=? WHERE id=?`)
    .run(res.id, res.version, JSON.stringify(skills), snapshotHash(agent), notes.join('；'), new Date().toISOString(), agent.id)
  return { qca_agent_id: res.id, qca_version: res.version, note: notes.join('；') }
}

// 快照有漂移（用户改了提示词/skill 未同步）时执行前自动对账
export async function ensureAgentSynced(agent) {
  if (!agent.qca_agent_id || agent.snapshot_hash !== snapshotHash(agent)) {
    return syncAgentToQca(agent)
  }
  return { qca_agent_id: agent.qca_agent_id, qca_version: agent.qca_version }
}

// 用某个用户智能体处理一次请求（每次新建 Session，钉当前 Agent 版本）
export async function askAgent(agent, userText, { timeoutMs = 150000 } = {}) {
  const binding = await ensureAgentSynced(agent)
  const environmentId = await ensureEnvironment()
  const session = await cloud.request('/api/v1/cloud/sessions', {
    method: 'POST',
    body: {
      agent: { type: 'agent', id: binding.qca_agent_id, version: binding.qca_version },
      environment_id: environmentId,
      title: `节点执行 ${agent.name}`,
      metadata: { app: APP_SCOPE, purpose: 'agent-node', hostAgentId: agent.id },
    },
  })
  if (!session?.id) throw new Error('QCA 会话创建失败')
  await cloud.request(`/api/v1/cloud/sessions/${session.id}/events`, {
    method: 'POST',
    body: { events: [{ type: 'user.message', content: [{ type: 'text', text: userText }] }] },
  })
  return waitForReply(session.id, { timeoutMs })
}
