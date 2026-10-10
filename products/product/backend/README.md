# 知需 · 受控接收后端

当前入口是 `app.main:app`，使用 FastAPI 提供穿搭需求交接接收、原件保存与受限内部读取。人员工作台、账号/角色、需求审批、反馈研判及面向设计的交接包/事件接口由 `../frontend/` 的 Next 服务提供。

本入口不加载旧 CMS、DeepSeek、旧数据库编排或静态验收页。源码中保留的旧模块不代表当前能力；`/health` 明确返回 managed 模式，付费模型、公开检索、旧 CMS 和商品探针均关闭。无需先启动集中 CMS。

## 本机启动

推荐 Python 3.12、Node.js 24。完整安装及 Next 启动见 [项目说明](../README.md) 和 [本机角色演示](../LOCAL_DEMO.md)。从本产品根目录首次安装：

```sh
cd backend
python3.12 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
cd ../frontend
npm ci
node scripts/init-local-demo.mjs
npm run build
```

在 `frontend/` 目录运行 `node scripts/run-local.mjs python`，另一个终端同目录运行 `node scripts/run-local.mjs next`。启动器从仓库外的私有 JSON 装载配置，默认 Python 地址为 `http://127.0.0.1:8000`、Next 为 `http://localhost:3000`。打开 Next 的 `/demo/staff` 或 `/demo/manager`；Python `/health` 仅为健康检查，不是人员工作台。

初始化器仅建立本机 reader 配对，不开放穿搭写入或设计服务。跨产品联调须另外配置明确用途、来源/目标实例、scope 与服务凭据，不能使用旧 CMS key 代替。

## 当前接口

| 方法 | 路径 | 职责 |
| --- | --- | --- |
| GET | `/health` | managed 服务健康与能力声明 |
| POST | `/api/integrations/styling/v1/handoffs` | 验证穿搭批准来源并接收冻结交接，保留原件及幂等结果 |
| GET | `/api/integrations/styling/v1/handoffs/lookup` | 按原 handoff 与 revision 查询回执 |
| POST | `/api/integrations/styling/v1/handoffs/{direct_receive_id}/supplements` | 接收受控补充原件 |
| GET | `/api/internal/signals` | 供产品工作台按 reader 用途读取来源列表 |
| GET | `/api/internal/signals/{signal_id}` | 读取单条来源 |
| GET | `/api/internal/receipts/{direct_receive_id}/{kind}` | 授权读取原始 payload 或 supplement |

除健康检查外，上述业务接口要求相应用途凭据；免登录页面并未取消后台鉴权。直接提交裸信号不能代替来源批准。旧 `/api/pull`、`/api/drafts`、`/api/packages` 等路由在本入口禁用；设计应使用 Next 提供的受控接口。

## 公网配置与持久化

当前公网产品前缀是 `/v2/product`，员工与管理者完整链接见 [项目说明](../README.md)。公开初始化脚本使用三个独立内部角色：Next 3191、Python 接收服务 8191，以及把设计请求适配至 Next `/v2/product` 的 8291 适配层。8291 适配层由部署环境提供，不能作为穿搭 intake receiver；穿搭交接目标是 Python 8191。

`frontend/scripts/configure-public-demo.mjs` 读取外部私有配对输入，生成 Next 与 Python 的运行 JSON。Next 数据库初始化由 `frontend/scripts/init-public-databases.cjs` 执行；Python 接收库初始化由 `backend/scripts/init_public_database.py --env-file /absolute/private/path/python-runtime-env.json` 执行。后者须使用已安装依赖的 Python，并传入初始化器生成的真实私有路径；不会导入业务资料或调用模型。运行 JSON 不是 shell 环境文件，不应通过 `source` 加载。

Python 配置项为 `PARTNER_MODE=managed`、`PARTNER_CONFIG_FILE` 与 `PARTNER_DB_PATH`。持久化数据库、完整回执、秘密与普通账户资料均在仓库外。公开快照只包含源码、测试与安全配置模板；不要复制既有运行库、真实 `.env`、私有照片或凭据作为初始化材料。数据迁移或清理需单独核定，日常验证使用隔离目录。

## 验证边界

离线测试可在 `backend/` 执行 `.venv/bin/python -m pytest -q`；本说明不固定测试条数，也不把测试通过等同于公网业务完成。当前文档修订仅核对源码和启动脚本，未重新构建、运行服务或调用模型。人员审批、发送与设计审查仍须由用户明确操作。
