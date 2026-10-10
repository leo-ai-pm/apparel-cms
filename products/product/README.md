# 知需 · 产品需求工作台

知需承接穿搭管理者已批准的需求来源，由产品员工核对证据、整理完整需求与设计提示词，再由产品管理者审核具体版本。批准后的需求可供设计管理者接收、分派、审查并回传结果。三个产品各有独立后台，后台之间受控交接；不依赖集中 CMS。

多反馈研判用于展示表达去重、独立来源计数、支持与反例、相反偏好及情境差异。当前采用明确标注的规则辅助方法与合成测试资料；不能据此证明真实市场规模、企业销量或模型泛化能力。研判审批本身不生成设计交接包。

## 当前在线入口

- [产品员工工作台](https://s357brv8j8f9gdhvbu9a9.apigateway-cn-beijing.volceapi.com/v2/product/demo/staff)
- [产品管理者后台](https://s357brv8j8f9gdhvbu9a9.apigateway-cn-beijing.volceapi.com/v2/product/demo/manager)

当前为临时免登录、合成身份的演示环境。角色权限仍由服务端执行，进入页面不自动导入、分派、批准、发送设计或调用模型。审批、设计结果审查等业务决定仍需用户明确操作。

## 独立本机启动

以下命令从本产品目录运行；在合集仓库中先进入 `products/product/`。推荐 Node.js 24、npm 与 Python 3.12；前端使用 Node 原生 SQLite。安装后初始化器只在仓库外建立本机私有配置，复用时不重置既有库。已有实例继续使用原配置，不用新初始化目录替换业务数据。

```sh
cd backend
python3.12 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
cd ../frontend
npm ci
node scripts/init-local-demo.mjs
npm run build
```

随后分别在两个终端的 `frontend/` 目录启动：

```sh
node scripts/run-local.mjs python
```

```sh
node scripts/run-local.mjs next
```

默认打开 [本机员工入口](http://localhost:3000/demo/staff) 或 [本机管理者入口](http://localhost:3000/demo/manager)。Next 监听本机 3000，受控 Python 服务监听本机 8000。新实例没有业务资料，空列表正常；管理者可显式载入公开合成反馈、导入并分派，员工处理提交后再由管理者核看。

关闭演示时，停止 Next 后在同一目录执行：

```sh
WORKBENCH_DEMO_ACCESS=false node scripts/run-local.mjs next
```

普通认证恢复，业务库保持。详细参数与身份隔离见 [本机角色演示](LOCAL_DEMO.md)，页面操作见 [前端说明](frontend/README.md)。本轮仅静态核对这些命令与现有脚本，未因文档更新重新运行构建或服务。

## 部署与数据边界

公网实例需独立设置 HTTPS origin、`NEXT_PUBLIC_BASE_PATH=/v2/product`、public demo 模式、实例及 scope，并配置用途隔离的后台凭据。本机初始化器只支持 loopback origin，不能用作公网部署配置。`frontend/.env.public.example` 只含公开配置示例；`frontend/scripts/configure-public-demo.mjs` 需要维护者在仓库外提供私有输入，生成新的私有配置，不覆盖旧实例。

穿搭交接由本产品 Python 接收服务处理；产品页面与设计交接包/事件由 Next 服务处理，不能把两者端口互换。接口与初始化职责见 [后端说明](backend/README.md)。跨产品联通须另外配对，独立本机启动不伪造上游批准或设计结果。

本源码快照不携带真实环境配置、口令、服务凭据、运行数据库、私人人物照片或历史截图。普通账户资料由初始化器保存在仓库外的私有目录，不写入说明或网页。业务版本、来源、原件、幂等与未知结果恢复仍按服务端规则执行；传输成功不等于业务批准。
