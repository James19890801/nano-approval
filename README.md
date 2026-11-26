# nano-approval · 轻审批

极轻量的自托管审批平台：一份 JSON 同时描述表单与流程，姓名 + 手机号登录即注册，审批人可直接写死，AI 能力以普通节点存在。

复刻自 [jeeflow](https://github.com/mldong/jeeflow-node) 引擎规范（Apache-2.0），配 SQLite 适配器实现单文件持久化，无需安装数据库。

## 特性

- **登录即注册**：姓名 + 11 位手机号，首次进入自动建户
- **一份 JSON 配全部**：`form` 定义表单字段，`flow` 定义审批链（`snaker:task` 节点）
- **写死审批人**：节点 `assignee` 直接填手机号；填变量名则按表单值动态解析
- **AI 节点**：`type: "snaker:custom"` + `clazz: "ai_review"`，注册一个处理器即接入；当前为规则占位，替换成 LLM 调用即可，流程定义零改动
- **移动端优先** H5：发起 / 待办 / 已办 / 我的、审批时间线、同意 / 拒绝
- 多人协同，SQLite 单文件持久化，重启不丢数据

## 快速开始

```bash
npm install
npm run seed   # 可选：演示用户 张三/李四 + 「请假审批」模板（含 AI 初审节点）
npm start      # http://localhost:3000
```

## 模板配置示例

```json
{
  "name": "leave",
  "displayName": "请假审批",
  "form": [
    { "key": "days", "label": "请假天数", "type": "number", "required": true },
    { "key": "reason", "label": "事由", "type": "textarea" }
  ],
  "flow": {
    "nodes": [
      { "id": "start", "type": "snaker:start", "properties": {} },
      { "id": "apply", "type": "snaker:task", "properties": { "assignee": "applicant" } },
      { "id": "ai", "type": "snaker:custom", "properties": { "clazz": "ai_review", "val": "aiOpinion" } },
      { "id": "approve", "type": "snaker:task", "properties": { "assignee": "13800000002" } },
      { "id": "end", "type": "snaker:end", "properties": {} }
    ],
    "edges": [
      { "id": "e1", "sourceNodeId": "start", "targetNodeId": "apply" },
      { "id": "e2", "sourceNodeId": "apply", "targetNodeId": "ai" },
      { "id": "e3", "sourceNodeId": "ai", "targetNodeId": "approve" },
      { "id": "e4", "sourceNodeId": "approve", "targetNodeId": "end" }
    ]
  }
}
```

在页面右上角「配置」粘贴保存即生效。节点还支持会签（`performType`/`countersignType`）、条件分支（`snaker:decision`）、并行（fork/join）等 [jeeflow 引擎](https://jeeflow-doc.mldong.com)原生语义。

## 目录结构

```
server.js             # 全部 API：登录/模板/实例/审批
src/db.js             # SQLite 建表（引擎 5 张 + 宿主 users/sessions/templates/ai_notes）
src/sqlite-adapter.js # jeeflow SqlAdapter 的 SQLite 实现
src/engine.js         # 引擎装配 + AI 节点处理器注册
public/index.html     # 移动端 H5（单文件，无构建步骤）
seed.js               # 演示数据
```

## AI 一句话生成模板（QCA）

配置页输入一句话（如「采购申请，先主管审再财务审」），由 [Qoder Cloud Agents](https://docs.qoder.com/zh/cloud-agents/overview) 生成模板 JSON，人工确认 assignee 手机号后保存。首次调用自动创建 Environment/Agent（幂等，重启不重复建）。

```bash
cp qca.env.example data/qca.env   # 填入你的 QODER PAT（qoder.com 控制台 → 设置 → 个人访问令牌）
npm start
```

`data/` 已被 .gitignore 排除，PAT 不会进入仓库。

## 接入 AI（下一步路线）

1. **AI 初审节点**：替换 `src/engine.js` 里 `ai_review` 处理器的占位实现为 QCA 调用（入参已含完整表单变量）

## License

引擎依赖 @mldong/jeeflow（Apache-2.0）。本项目代码 MIT。
