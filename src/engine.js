import { EngineImpl, HandlerRegistry } from '@mldong/jeeflow'
import { JdbcRepository, TsIDGenerator } from '@mldong/jeeflow/jdbc'
import { SqliteAdapter } from './sqlite-adapter.js'
import { db, q } from './db.js'
import { askAgent, ensureAgentSynced, qcaConfigured } from './qca/index.js'

export const repo = new JdbcRepository(new SqliteAdapter(db), new TsIDGenerator())

const userProvider = {
  async getUser(phone) {
    const u = q.findUser(phone)
    return u ? { userId: u.phone, realName: u.name } : null
  },
}

export const registry = new HandlerRegistry()

// AI 节点处理器：流程 JSON 里 type=snaker:custom、properties.clazz='ai_review' 的节点会走到这里。
// 引擎只在同一次执行上下文内传递返回值（不写回实例变量），所以意见同时落宿主侧 ai_notes 表，
// 供详情页时间线展示。V2 换成 LLM 调用即可（入参已带完整表单变量），流程定义不用改。
registry.registerCustom('ai_review', {
  async handle(node, inst, operator, vars) {
    const form = Object.fromEntries(
      Object.entries(vars ?? {}).filter(([k]) => !k.startsWith('tf_') && !k.startsWith('u_'))
    )
    const days = Number(form.days ?? 0)
    const opinion = days <= 3
      ? `[AI初审] 请假 ${days} 天（${form.reason ?? ''}）。规则占位意见：在阈值内，建议通过。`
      : `[AI初审] 请假 ${days} 天（${form.reason ?? ''}）。规则占位意见：超过 3 天，建议人工重点复核。`
    db.prepare('INSERT INTO ai_notes (instance_id, node_id, text, created_at) VALUES (?,?,?,?)')
      .run(inst.id, node.id, opinion, new Date().toISOString())
    return opinion
  },
})

// 用户智能体节点：流程 JSON 里 type=snaker:custom、properties.clazz='qca_agent'、
// properties.agentId=宿主侧智能体 id（管理界面维护）。执行时按快照哈希自动同步到 QCA，
// 表单变量发给该智能体，意见落 ai_notes 供时间线展示。
registry.registerCustom('qca_agent', {
  async handle(node, inst, operator, vars) {
    const agentId = node.properties?.agentId
    const agent = agentId ? q.findAgent(agentId) : null
    if (!agent) {
      db.prepare('INSERT INTO ai_notes (instance_id, node_id, text, created_at) VALUES (?,?,?,?)')
        .run(inst.id, node.id, `[智能体] 配置错误：找不到 agentId=${agentId}`, new Date().toISOString())
      return `[智能体配置错误：${agentId}]`
    }
    const form = Object.fromEntries(
      Object.entries(vars ?? {}).filter(([k]) => !k.startsWith('tf_') && !k.startsWith('u_'))
    )
    const task = `${node.text?.value ?? agent.name}`
    const prompt = `审批流程节点「${task}」收到一份申请，请按你的职责处理并给出意见。\n表单数据：${JSON.stringify(form)}\n请直接输出处理意见（一两段话）。`
    let opinion
    try {
      if (!qcaConfigured()) throw new Error('QCA 未配置')
      await ensureAgentSynced(agent)
      opinion = await askAgent(agent, prompt)
    } catch (err) {
      opinion = `[${agent.name}] 执行失败：${String(err.message || err).slice(0, 200)}`
    }
    db.prepare('INSERT INTO ai_notes (instance_id, node_id, text, created_at) VALUES (?,?,?,?)')
      .run(inst.id, node.id, opinion, new Date().toISOString())
    return opinion
  },
})

export const engine = new EngineImpl(repo, userProvider)
engine.setRegistry(registry)

export function deployTemplate(tpl) {
  const flow = JSON.parse(tpl.flow_json)
  const def = {
    id: tpl.id,
    name: flow.name ?? tpl.name,
    displayName: flow.displayName ?? tpl.display_name,
    type: flow.type ?? 'approval',
    state: 1,
    content: tpl.flow_json,
    version: 1,
    createTime: new Date(),
    createUser: tpl.created_by ?? 'admin',
    updateTime: new Date(),
    updateUser: tpl.created_by ?? 'admin',
  }
  // JdbcRepository.saveDefine 是 INSERT；重复部署走 updateDefine
  return repo.findDefineById(tpl.id).then((existing) => (existing ? repo.updateDefine(def) : repo.saveDefine(def)))
}

export async function startInstance(user, tpl, values) {
  const vars = { ...values }
  const inst = await engine.startProcessInstanceById(tpl.id, user.phone, vars)
  // 流程第一个任务节点（发起申请）自动提交，表单值随任务落库并推进到下一审批节点
  const doing = await repo.findDoingTasks(inst.id)
  if (doing.length > 0) {
    await engine.executeProcessTask(doing[0].id, user.phone, vars)
  }
  return inst.id
}

export function agree(taskId, phone, comment) {
  return engine.executeProcessTask(taskId, phone, { tf_approvalComment: comment ?? '' })
}

export function reject(taskId, phone, comment) {
  return engine.executeAndJumpToEnd(taskId, phone, { tf_approvalComment: comment ?? '' })
}

export function listTodo(phone) {
  return repo.pageTodoTasks(1, 100, phone).then((r) => r.rows)
}

export function listDone(phone) {
  return repo.pageDoneTasks(1, 100, phone).then((r) => r.rows)
}

export function listMyInstances(phone) {
  return repo.pageInstances(1, 100, phone).then((r) => r.rows)
}

// 管理端查阅：全部实例（绕过归属过滤，直查引擎表）
export function listAllInstances() {
  return db.prepare(`
    SELECT i.id, i.state, i.operator, i.create_time,
           d.display_name AS define_display_name
    FROM wf_process_instance i
    LEFT JOIN wf_process_define d ON d.id = i.process_define_id
    ORDER BY i.create_time DESC LIMIT 200`).all()
}

export async function instanceDetail(instanceId) {
  const inst = await repo.findInstanceById(instanceId)
  if (!inst) return null
  const [history, doing] = await Promise.all([
    repo.findHistoryTasks(instanceId),
    repo.findDoingTasks(instanceId),
  ])
  const tpl = q.findTemplate(inst.defineId)
  const aiNotes = Object.fromEntries(
    db.prepare('SELECT node_id, text FROM ai_notes WHERE instance_id = ?').all(instanceId)
      .map((r) => [r.node_id, r.text])
  )
  return { inst, history, doing, form: tpl ? JSON.parse(tpl.form_json) : [], aiNotes }
}
