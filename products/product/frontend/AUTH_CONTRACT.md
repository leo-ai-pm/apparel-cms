# 伙伴产品身份实施契约

2026-10-10，先记录接口再实施。依据共享 API_CONTRACT 与主契约 partner-three-agent/1.0。仅伙伴新副本，运行验收另记。

- WORKBENCH_CONFIG_FILE 为绝对路径普通文件，0600。身份层读取 instance_id/authorized_scope/origin；其它服务字段由服务层校验。精确 HTTPS origin，HTTP 仅显式 loopback。
- WORKBENCH_USERS_DB 必须显式绝对路径，父目录私有。仅创建不存在的新库；已存在库先只读核验 partner_identity_meta 的 owner/schema/instance/scope，未知库拒绝，不迁移旧 users 库。
- bootstrap 沿用 WORKBENCH_STAFF_USERNAME/PASSWORD_HASH 和 WORKBENCH_MANAGER_USERNAME/PASSWORD_HASH。对应 WORKBENCH_*_ENABLED=false 可停用。WORKBENCH_SESSION_SECRET 至少32字符；密码哈希或 secret 变化使旧会话失效。注册只通过一次邀请获得 staff 和配置 scope。
- Cookie zhixu_session：Path=/、HttpOnly、SameSite=Strict；HTTPS Secure。值为32随机字节，数据库仅保存摘要。8小时绝对/30分钟idle；重新登录撤销当前浏览器旧会话，退出持久撤销。公开 session_id 不同于 Cookie 凭证。
- requirePerson(request,write=false) 同步返回 {user:{username,role,scope},context:{subject,session_id,session_revision,instance_id,scope},csrf_token}。拒绝 Cookie 与 Authorization/X-Handoff-Key/X-Signal-Key 混合身份。write=true 要求精确 Origin 和 X-CSRF-Token，成功才刷新 idle。
- recheckPerson(person) 重验账户、期限、撤销和实例/scope，不刷新idle，供业务事务及幂等返回前使用。validateContext(actual,expected) 严格比较，缺/多字段或旧上下文均409 CONTEXT_CONFLICT。每次登录新session_id、session_revision=1。
- readSession(cookie) 保持同步页面读取，返回带scope的user或null；不替代业务路由授权。
- AuthError(code,message,status,retryable) 和 authErrorResponse(error) 返回 {error:{code,message,retryable},request_id}；未知异常安全503，不回显正文、数据库错误或秘密。
- POST login/register 表单必须精确 Origin；register 必须 code 一次邀请码。成功保持303到工作台。邀请码不进URL。
- GET /api/auth/me 返回人员会话及 capabilities:{paid_models:false}；POST logout 必须 Origin/CSRF；POST /api/team/invites 必须 manager/Origin/CSRF，返回 {code,link,expiresAt}，link不含code。
- proxy 覆盖全部API：身份/团队/工作台/受控design-link交各自独立鉴权；旧agent、drafts、packages、pull和未知API关闭。team要求manager，收费模型关闭。

前端需适配邀请码输入、邀请创建、me/CSRF和退出。旧无邀请码注册测试不再代表当前契约；本模块仅做独立临时库测试，不安装/构建/启动服务。

## 已实施与验证

身份模块及路由已实现。`tests/partner-auth.test.ts` 最终 51 项通过：会话原件不落库、连接重开、精确 Origin/CSRF、服务/人员冲突、退出及密码/停用失效、同浏览器重登、上下文五字段、idle/绝对期限、邀请单次与并发、旧库/未来 schema/实例/scope 拒绝、旧通配入口封闭和安全错误。时间边界采用受控时钟，不称实际等待8小时；连接重开不称实际进程重启。

`tsc --noEmit --incremental false` 通过；本任务身份文件及测试的 ESLint 通过。上述身份模块验收未安装、构建、启动服务或做真实HTTP；测试库仅为本任务临时目录。随后另轮联调准备中，伙伴原 `tests/auth.test.ts` 的4项旧预期实际失败并保留原日志；并行协作窗口将它适配为5项，继续保留账号/过期/邀请检查、明确关闭公开注册、补缺配置拒绝。身份负责人未覆盖该并行改动，只读审查并复跑当前5项+本模块51项，15:40:08共56/56通过。首次失败、后续通过及HTTP独立记账，见共享报告 `product-backend/NEXT_HTTP_VERIFICATION.md`。

登录/注册成功与可纠正的凭证/表单错误保持303跳转（错误仅为固定query码）；安全边界/配置/存储错误使用安全JSON。退出返回200 `{logged_out:true}` 并清Cookie。不同本地端口不隔离 Cookie，新实例并行查看需配置独立hostname。
