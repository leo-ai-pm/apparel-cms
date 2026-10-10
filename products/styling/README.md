# 个性化穿搭 Agent

面向消费者的穿搭工作区与企业管理后台。消费者以自然语言描述场景、预算和尺码，查看固定模特的完整搭配与商品；管理者核对来源证据，批准具体需求版本，再通过受控接口交接给独立的产品管理 Agent。

本目录是公开展示与本机演示所需的源码快照，可独立放置，也可放在合集的 `products/styling/`。原组织仓库的历史材料没有随本快照公开。旧集中 CMS 不是当前三产品业务流的必经节点。

- [本机后端与合成演示启动](backend/PORTABLE_DEMO.md)
- [前端安装、构建与运行](frontend/README.md)
- [公网部署配置和持久化边界](backend/HTTPS_DEPLOYMENT.md)
- [后端说明与素材清单](backend/README.md)

## 本地运行

使用 Python 3.12 与支持当前 Next.js 依赖的 Node.js。在 `backend/` 创建独立 venv，安装 `requirements.txt`，运行：

```sh
.venv/bin/python scripts/start_public_demo.py --demo-access --public-origin http://localhost:3010
```

然后在 `frontend/` 安装依赖并构建，确保构建与启动时后端地址一致：

```sh
npm ci
BACKEND_URL=http://127.0.0.1:8000 npm run build
BACKEND_URL=http://127.0.0.1:8000 HOSTNAME=127.0.0.1 PORT=3010 npm start
```

浏览器使用 `http://localhost:3010/`，管理入口为 `/admin`。本机演示显式启用免登录模式，使用独立合成主体；它不代表真实企业身份认证。默认源码认证开关仍关闭免登录，公共部署需要独立配置。

## 数据与模型边界

随仓库提供的是合成商品、库存、规则和授权的 AI 展示素材，不能作为真实成交或市场需求证据。固定模特图与 SKU 映射，不承诺真实试穿或尺码效果。本人照片效果功能的代码保留，但本机公开演示默认关闭本人图与伙伴发送，不调用收费模型。

`backend/demo_resources/` 和 `backend/deploy_resources/` 各自带精确素材清单；`frontend/public/` 仅保留获授权的合成商品、固定搭配及原创风格意向图。私人照片、人物参考原图、个人效果图、运行 SQLite、Cookie、供应商凭据、日志和历史阶段截图未纳入本快照。运行数据在独立私有目录初始化，不导入既有用户数据。

## 验证范围

源码包含后端 pytest 与前端 Vitest 测试。历史少量后端测试仍依赖原工程夹具，详见 `backend/PORTABLE_DEMO.md`，不能把这份发布快照视为已在全新机器重新跑完全部测试。生产源码与已登记上线冻结一致；此次公开整理未运行服务、模型、业务写入或浏览器验收。
