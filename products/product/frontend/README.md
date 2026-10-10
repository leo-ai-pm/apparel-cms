# 知需 · 产品人员工作台

当前页面使用 Next 服务端人员接口。员工核对已分派来源、编辑/保存完整需求与提示词；负责人分派、核对准确版本后审核。设计反馈、历史、返工与反馈研判保留。反馈研判是合成输入的规则辅助测试，批准研判不形成设计交接包。旧 `/demo` 为历史原型，真实角色演示入口是 `/demo/staff` 和 `/demo/manager`。

## 独立克隆本机启动

要求 Node.js ≥22、npm、Python 3.11+。以下从仓库根目录运行，初始化器只在仓库外创建固定本机演示配置；重复执行复用配置，不重置现有库。已有服务应继续使用自己的配置，不运行初始化器覆盖。

```bash
cd backend
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
cd ../frontend
npm ci
node scripts/init-local-demo.mjs
npm run build
```

分别在两个终端的 `frontend` 目录执行：

```bash
node scripts/run-local.mjs python
```

```bash
node scripts/run-local.mjs next
```

打开 [员工演示](http://localhost:3000/demo/staff) 或 [负责人演示](http://localhost:3000/demo/manager)。无需账号、密码或一次码。初次独立克隆没有业务数据，空列表是有效状态；入口不自动导入、分派、批准、出图或重置预算。原实例继续使用既有数据。默认配置不建立跨产品机器交接，连接其他实例须由服务维护者配置用途凭据。

公开配置例见 [.env.example](.env.example)。`WORKBENCH_DEMO_ACCESS` 为**服务端**开关，通常未设置/false；本机初始化器生成的私有运行配置显式为 true。账户和会话秘密留在仓库外，初始化器不输出秘密实值。不要运行历史账号轮换脚本代替此初始化器。

恢复正常认证：停止 Next 终端后执行 `WORKBENCH_DEMO_ACCESS=false node scripts/run-local.mjs next`。演示 cookies/header 不再授权，普通登录和注册恢复，业务数据保留。已有有效普通会话按正常规则使用；启用/关闭不会自动重试未确认写入。

顶栏应用链接为公开构建配置，可在构建时给 `NEXT_PUBLIC_LINK_OUTFIT` 和 `NEXT_PUBLIC_LINK_DESIGN` 设置同机其他产品地址。不要将口令、服务凭据或模型密钥放入 `NEXT_PUBLIC_*`。工作台通过同源 `/api/*` 获取真实服务器访问模式和权限；角色 query/header 不能启用演示模式。

## 检查与页面操作

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

员工：任务 → 来源/证据 → 需求与完整正文 → 保存 → 提交保存版。负责人：收件分派 → 审核 → 查看精确版本、优先级理由 → 明确批准或退回。实际操作仍由用户点击。角色可分别打开标签页，当前页面每次请求固定其角色；模式/身份变化清空旧私有内容。草稿未保存或动作结果未知时离开会提醒；409 要求主动核对，查询/明确重试沿用原动作与身份。

受控原件和图片由人员资源接口授权后读取，不使用公开链接代替。前端构建成功、运行/API 联通、浏览器操作、最终视觉和真实模型出图分别验收；本轮免登录适配不调用模型。旧 CMS/模型原型资料保留在阶段文档，不作为当前页面接口或权限依据。
