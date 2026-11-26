import { EngineImpl, HandlerRegistry } from '@mldong/jeeflow'
import { JdbcRepository, TsIDGenerator } from '@mldong/jeeflow/jdbc'
import { SqliteAdapter } from './sqlite-adapter.js'
import { db, q } from './db.js'

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
