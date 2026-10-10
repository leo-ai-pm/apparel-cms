# 独立克隆的本机演示

本后端包含必要的m2固定搭配代码、合成目录/库存/规则/词表及四张已授权公开展示的AI固定模特搭配图。`demo_resources/PUBLIC_MANIFEST.json`记录精确文件/SHA。不含人物参考原图、本人照片/结果、私有账号、供应商任务或运行SQLite。商品/库存是合成演示，图片不代表真实试穿或尺码效果，也不证明经营收益。

在独立personal-styling-agent克隆的backend目录执行：

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python scripts/start_public_demo.py --demo-access --public-origin http://localhost:3000
```

服务只绑定127.0.0.1:8000。前端BACKEND_URL使用http://127.0.0.1:8000，浏览器必须使用与public-origin完全一致的地址；消费者Cookie名和管理Cookie名由启动元数据输出，代理须精确放行及透传Set-Cookie/Origin，不向JS返回凭据。前端按demo-access契约先GET模式，再POST enter对应角色；管理者me必须支持auth_method=demo_server。没有前端适配时后端可通过/docs与API验证，但不称页面免登录已完成。

默认源码开关`STYLING_DEMO_ACCESS_ENABLED=0`；上述命令显式开启本机演示。关闭服务后以`--no-demo-access`启动同一数据目录恢复普通认证，旧demo Cookie/context失效，消费者资料归属保持；原密码保存在该目录0600的local-auth.json，仅维护者本地查看，不提交或截图。8小时管理会话正常过期，显式enter可建同一合成主体的新会话；旧pending要重新核对，不换context自动重放。

默认运行目录为用户本机`~/.local/share/personal-styling-agent-demo`；可用`--data-dir`指定新的0700私有目录。该启动脚本只使用这份自己的库，不复制任何现有服务数据，不应指向他人/生产数据目录。启动不需要模型Key，不读取.env；报价/尺码/图覆盖沿四套M/M/38、最低737元。解析器是有限规则演示（offline_controlled_no_model_http），不是新真实模型成功；示例“预算800元，上衣M，裤子M，鞋38，秋天通勤”，也支持资料保存后复用和“换搭”。任意语言/复杂偏好泛化仍需另行授权真实模型验收。

脚本关闭本人照片和伙伴发送、不启收费模型，免登录不授额外额度。普通集成启动仍支持显式STYLING_FIXED_ROOT/STYLING_FIXED_DB；缺省ROOT仅定位本仓库demo_resources，固定库须显式且与业务库分离。既有运行服务配置不被这个示例脚本修改。

发布只提交源代码和PUBLIC_MANIFEST列出的合法资源，不提交`data/`运行数据、`.env`实值、local-auth.json、SQLite/WAL、日志、私人照片或任一现有实例目录。原验收日志涉及机器路径，公开clone可运行的新隔离测试为`tests/test_demo_access.py`及`tests/test_public_demo_portability.py`；早期集成测试可能依赖原项目夹具，不据此承诺全部旧测试在任意clone无配置可跑。
