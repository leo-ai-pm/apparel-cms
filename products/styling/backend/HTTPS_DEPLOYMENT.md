# 穿搭 HTTPS 公网独立演示部署

本入口承接显式公网发布，与 PORTABLE_DEMO.md 的本机离线启动分开。Python 仅监听 127.0.0.1:8190，Next/BFF 处理 /v2/styling 前缀与精确 HTTPS Origin。源码和许可素材可打包；私人库、照片、供应商 ledger、旧 .env 和本机账户不得复制。Linux 安装 requirements-linux.txt 并记录解析版本。本轮只在 macOS 已装环境验证独立源码与真实 TCP，不声称 Linux 安装、真实网关/TLS 或云页面已验。

## 首次初始化与正常启动

在新发布版本的 backend 目录和独立 Linux venv 执行。根提供 pairing-input.json，必须为服务用户可读的 0600 文件。持久化 styling 目录必须尚不存在；初始化脚本创建 0700 目录，不覆盖已有目录。

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-linux.txt
.venv/bin/python scripts/start_https_demo.py --pairing-file /srv/contest/secrets/three-agent-public-20261010/pairing-input.json --data-dir /srv/contest/data/three-agent-public-20261010/styling --initialize
.venv/bin/python scripts/start_https_demo.py --pairing-file /srv/contest/secrets/three-agent-public-20261010/pairing-input.json --data-dir /srv/contest/data/three-agent-public-20261010/styling --port 8190
```

只使用配对文件的 session_secret、styling_sender、styling_product_verifier，派生新 direct-auth.json；不另生成服务 token，不输出值。穿搭发送目标 http://127.0.0.1:8191，proof 回调直接 8190，verifier subject 精确为 product-public-verifier。8291 仅服务设计访问 Next 的 prefix 适配，不含穿搭接收路由。核验 Bearer 仅保存摘要，管理 Cookie 不授服务身份。其他四个配对字段不参与本产品权限。重启要求原 direct 配置与配对相同，不自动轮换、重置资料或累计额度。初始化与启动均不批准或发送需求。

穿搭实际接收路由为 POST /api/integrations/styling/v1/handoffs、GET 同前缀 /lookup、POST 同前缀 /{direct_receive_id}/supplements，由产品 Python app/api/partner.py 承担。若新公网目录已按早期8291配对初始化，根仅修该新目录 direct-auth.json 的 base_url 和 verifier subject，保持原秘密/库/额度；不能重建库或重新 initialize。本脚本仍拒绝静默修改配对。

默认 Origin 为 https://s357brv8j8f9gdhvbu9a9.apigateway-cn-beijing.volceapi.com。管理 subject/instance 为 styling-public-20261010、scope 为 public-three-agent-20261010；消费者 scope 为 styling-public-20261010。Cookie 名分别 styling_admin_public_20261010、styling_consumer_6481dfa30d55，均 Secure/HttpOnly/SameSite=Strict/path=/。Uvicorn proxy_headers=False，Forwarded 不决定身份、scheme 或 Cookie 安全。仅接受 loopback BFF，写请求须精确 Origin；网关不能将 Python 全量 API 或机器 callback 直接开放给公众。

## 可选能力与私有配置

可额外提供 --config-file /srv/contest/secrets/three-agent-public-20261010/styling-runtime.json，内容是扁平 JSON 字符串字段，文件 0600，拒绝未声明字段。启用根配对时不要另配置 STYLING_ADMIN_SECRET/STYLING_DIRECT_AUTH_FILE。默认明确离线解析，本人图 disabled；已有四套固定图和三张商品单图可读。

| 能力 | 服务端字段与边界 |
| --- | --- |
| 官方实时文本 | STYLING_FIXED_OFFLINE_DEMO=0、DEEPSEEK_API_KEY、DEEPSEEK_MODEL=deepseek-v4-flash、DEEPSEEK_BASE_URL=https://api.deepseek.com、YIXU_MODEL_PROVIDER=deepseek。没有 key 时启动失败，不暗退离线；真实模型本轮未调用 |
| 文本限额 | STYLING_FIXED_MODEL_CALL_LIMIT=1～12，默认12，持久累计主/guard HTTP；DAILY_CALL_LIMIT 默认12，主库持久日额度；MAX_CONCURRENCY 默认1。初始化不生成，重启不重置固定累计额度 |
| 受控本人图 | STYLING_PERSONAL_PREVIEW_ENABLED=1、STYLING_PERSONAL_PREVIEW_REAL_AUTHORIZED=1、RUNNINGHUB_API_KEY、STYLING_PERSONAL_PREVIEW_WORKER_AUTORUN=1。模型 rhart-image-n-pro-official/edit，全实例累计1任务、daily1，跨身份/日期/删除/重启不重置。不是持续无限生成模式 |
| 普通认证恢复 | STYLING_DEMO_ACCESS_ENABLED=0，加单独 STYLING_ADMIN_PASSWORD，重启本次新服务；保持同库、scope、配对。旧 demo context 不复活，旧 pending 不自动迁移。真实云端恢复未执行 |

本人照片只存 private-preview/0700 和独立 SQLite/provider-ledger，通过当前 owner 的私有任务 API 读取，不放 tryon-results 或静态商品目录。仅 LOOK-101 的三参考图齐全；其他 Look 缺参考图真实拒绝，不替图。原本机 unknown 不导入或重发。真实本人图/模型配置存在不等于已生成或已验证质量。

STYLING_ADMIN_PUBLIC_ORIGIN 可在私有配置精确修改，消费者 Origin 自动同步；拒绝 HTTP、本机、路径、通配配置。公网 GET demo-access 返回 mode=public_demo；前端严格枚举须适配。entry_path 仍 / 或 /admin，由前端补 /v2/styling。八类浏览事件、资料 prepare/binding、SAC 和 direct 协议不加认证字段；合成管理者须显著标注，不宣称自然人身份验证。

## 资源、存储与费用门禁

app.db 初始化21条合成 P 商品及21许可 PNG，与 M1 六商品目录分开。fixed-resources 来自23公开资源和 visual_specs；库存初次由既有 factory 创建12小时窗口并持久至 fixed-outfits.sqlite3，重启不刷新已加载库存或累计模型预算。过期时真实不可售/无匹配，更新库存须另行受控，不能通过重建库恢复费用额度。

product-image.sqlite3 按三许可 JPG 的原 SHA 登记，保持 agent_checked_preview/user_review=pending，不扩 SKU/尺码/Look 或声称用户已视觉确认。deployment-state.json 记录新实例、实际库存时窗和原合成库存来源摘要。运行 DB、动态 fixed-resources/reports、private-preview、direct-auth 均为私有持久状态，不进公开源码包。源 demo_resources 与 deploy_resources 各有显式 SHA 清单，没有个人图或旧库。

公开模式所有 /api/v1 写请求先核 loopback 和精确 Origin。旧 POST /api/v1/tryon 在上传解析/供应商线程之前返回403 PUBLIC_DEMO_LEGACY_GENERATION_DISABLED；normal/local 旧行为和 GET 历史保持。公网照片仅使用受控 personal-preview 链路。部署验收不调用付费模型，不借新身份/初始化重试原 unknown。

回退由根停止新 unit、撤回 /v2/styling 代理并保留新数据；旧云 /styling 和本机服务保持。不覆盖旧库，不自动删除资料或重建额度。代码/HTTP/云/页面/真实模型证据分别记录。
