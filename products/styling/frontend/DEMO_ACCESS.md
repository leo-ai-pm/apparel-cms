# 本机临时免登录演示

`/` 是消费者，`/admin` 是穿搭管理者。前端先 GET 服务端能力；仅 `local_demo` 时 POST 本角色 enter，确认成功后进入原页面。管理者身份显著标为共享合成管理者，人工核对、批准和发送保持原规则。消费者与管理员 Cookie 分开，不认领其他访客照片或历史。

## 独立克隆后的无费用启动

需要 Node.js 22、Python 3.11+。穿搭仓库包含 `backend/` 与 `frontend/`；不需要原开发机器项目路径、运行库、密钥或私人照片。

先在 backend 安装依赖并用公开脚本启动**新独立演示库**：

```sh
cd backend
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python scripts/start_public_demo.py --port 8010 --public-origin http://localhost:3010 --demo-access
```

脚本输出公开 Cookie 名及 Origin，无模型 HTTP 调用，采用离线规则与仓库内合成商品/已授权完整图；本人照片和伙伴发送默认关闭。消费者 Cookie 应为 `styling_consumer_e4c0ca80a021`，管理员为 `styling_admin_public_demo`。以脚本实际输出为准，若改作用域，修改前端相应配置；这两项为公开 Cookie **名称**，不是 Cookie 值或凭据。

另一个终端启动前端：

```sh
cd frontend
cp .env.example .env.local
npm ci
npm run build
node --env-file=.env.local scripts/start.mjs
```

访问 `http://localhost:3010/` 与 `http://localhost:3010/admin`。必须使用与配置一致的 hostname/port，不将 `localhost` 与 `127.0.0.1` 混用；变更端口须同步后端 public-origin 与两项前端 PUBLIC_ORIGIN。公开 `NEXT_PUBLIC_*` 在构建时固定，修改后重新构建。可用 `npm run dev` 代替最后两行进行开发，默认绑定本机 3010。

## 恢复普通认证

维护者在自身安全点停止公开后端后，以相同 data-dir/public-origin、`--no-demo-access` 重启；既有数据保留。普通管理员密码是脚本首次启动生成的本机私有 `local-auth.json` 中 password，不上传文件、不使用公开默认密码。生产部署的正式密码/配置由维护者另行管理。

前端不修改服务端开关。关闭后拒绝旧 demo_server 会话，页面在聚焦/定期只读探测或身份失败后清除旧私有工作区，回普通管理员认证；消费者仍是原合法匿名入口，不强制账号。旧 `/login`、`/admin/login` 固定到 `/admin`；`/platform/login` 固定回消费者 `/`，不接受任意 return URL。

“结束当前演示会话”须原服务端 logout 成功，然后显示结束状态；只有明确重新进入才建立新会话。过期/换上下文只保留原范围安全动作引用可查询，不自动换 context 重发。能力或 enter 失败真实提示，不降级为已登录。

## 验收范围

四套完整图只覆盖当前 M/M/38，低预算或其他尺码真实无匹配；选资料不产生推荐或成交。离线规则不是实时模型效果，固定模特图不是本人试穿。独立公开启动不配置付费凭据或开放照片/伙伴发送。

工程检查：`npm test`、`npm run typecheck`、`npm run lint`。受控客户端响应测试与真实服务/页面验收分账。主项目 3084/8090 的候选构建另交总控，不由本说明自动重载原服务。GitHub 发布、真实页面与关闭开关联调由总控记录，不以编译通过宣称已验。
