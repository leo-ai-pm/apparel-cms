# 本机角色演示

临时免登录采用服务端`WORKBENCH_DEMO_ACCESS=true`，普通构建缺省关闭。只绑定本机origin；员工和负责人为合成身份，页面、API与业务事务使用同一真实角色上下文。它不自动批准、发送设计或调用模型。

需要Node.js 24（原生SQLite）、Python 3.12。首次配置只生成仓库外的私有配置/秘密，复用时不改既有文件，不导入业务资料；不用填写账号或领取一次码。

```sh
cd frontend
npm ci
node scripts/init-local-demo.mjs
npm run build
node scripts/run-local.mjs next
```

另一个终端启动受控Python服务：

```sh
cd backend
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt
node ../frontend/scripts/run-local.mjs python
```

进入员工`http://localhost:3000/demo/staff`或负责人`http://localhost:3000/demo/manager`。本机新库默认空，负责人可在“反馈研判”显式载入公开合成输入、导入并分派，员工计算后提交，再由负责人核看本版。已有穿搭来源/设计服务须另外做目的绑定配对；快速启动不伪造上游批准包或设计结果。staff与manager标签页分别使用独立cookie及固定`X-Workbench-Demo-Role`，不能以另一个标签页角色替代本页身份。

初始化目录缺省为用户私有数据目录的`product-agent-demo`。可用`--directory /absolute/private/path`指定其他全新目录，两条run命令也传同一参数。可用初始化参数`--origin http://localhost:3000 --backend-url http://127.0.0.1:8000`指定本机端口；不对当前正在运行的旧实例执行初始化。真正的口令、会话秘密和机器token只在私有目录，禁止提交这些文件或运行库。

关闭演示：停止Next后用同一私有配置启动普通认证，不回滚业务数据。

```sh
WORKBENCH_DEMO_ACCESS=false node scripts/run-local.mjs next
```

旧demo cookie/header与事务上下文立即失效，普通登录恢复；原有效普通会话不被清理。新初始化实例的普通账户资料仅在私有`normal-accounts.json`，维护者需要时本地读取，不放浏览器bundle、文档或Git。现有主实例继续用它原有配置与账号，不用新初始化目录代替旧业务库。

测试：在frontend运行`npm test`。独立合成期望在`tests/fixtures/reasoning-expected-v1.json`，只用于测试，不由lib/页面/分析器导入；运行只含原反馈样例。根负责GitHub提交发布，源码不包括真实env、数据库、本人照片/私有资产。本说明不是当前主入口已切换或GitHub已发布的证据。
