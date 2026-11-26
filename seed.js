import { q } from './src/db.js'
import { deployTemplate } from './src/engine.js'

// 演示用户：张三（发起人）、李四（写死的审批人）
for (const [phone, name] of [['13800000001', '张三'], ['13800000002', '李四']]) {
  if (!q.findUser(phone)) q.upsertUser(phone, name)
}

// 演示模板：请假审批，审批人直接写死为李四的手机号
const config = {
  name: 'leave',
  displayName: '请假审批',
  form: [
    { key: 'days', label: '请假天数', type: 'number', required: true },
    { key: 'reason', label: '事由', type: 'textarea', required: true },
  ],
  flow: {
    type: 'approval',
    nodes: [
      { id: 'start', type: 'snaker:start', x: 100, y: 200, properties: {}, text: { value: '开始' } },
      { id: 'apply', type: 'snaker:task', x: 200, y: 200, properties: { assignee: 'applicant' }, text: { value: '发起申请' } },
      { id: 'ai', type: 'snaker:custom', x: 280, y: 200, properties: { clazz: 'ai_review', val: 'aiOpinion' }, text: { value: 'AI 初审' } },
      { id: 'approve', type: 'snaker:task', x: 380, y: 200, properties: { assignee: '13800000002' }, text: { value: '主管审批' } },
      { id: 'end', type: 'snaker:end', x: 480, y: 200, properties: {}, text: { value: '结束' } },
    ],
    edges: [
      { id: 'e1', sourceNodeId: 'start', targetNodeId: 'apply', properties: {} },
      { id: 'e2', sourceNodeId: 'apply', targetNodeId: 'ai', properties: {} },
      { id: 'e3', sourceNodeId: 'ai', targetNodeId: 'approve', properties: {} },
      { id: 'e4', sourceNodeId: 'approve', targetNodeId: 'end', properties: {} },
    ],
  },
}

const existing = q.findTemplateByName('leave')
const tpl = {
  id: existing?.id ?? 'tpl_leave_demo',
  name: config.name,
  display_name: config.displayName,
  form_json: JSON.stringify(config.form),
  flow_json: JSON.stringify(config.flow),
  created_by: '13800000001',
}
if (existing) q.updateTemplate(tpl)
else q.insertTemplate(tpl)
await deployTemplate(tpl)
console.log('种子完成：用户 张三/李四，模板「请假审批」（含 AI 初审节点）')
