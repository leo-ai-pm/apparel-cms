# 穿搭后端

FastAPI 后端提供消费者会话/资料、固定搭配、商品与单图、管理者来源核对、版本批准和直接交接能力。消费者身份、管理人员会话和机器交接用途分离；传输成功不等于业务批准。

## 启动

本机独立演示以 [PORTABLE_DEMO.md](PORTABLE_DEMO.md) 为准；Linux HTTPS 部署以 [HTTPS_DEPLOYMENT.md](HTTPS_DEPLOYMENT.md) 为准。仅在新建的私有数据目录运行初始化，不覆盖既有 SQLite 或个人资料。

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python scripts/start_public_demo.py --demo-access --public-origin http://localhost:3010
```

本机 API 默认只绑定 `127.0.0.1:8000`。前端需配置相同的后端地址，浏览器 Origin 必须与启动参数完全一致。显式免登录演示使用合成主体，不是生产身份验证。启动默认使用受限离线规则，不需要供应商 Key，也不请求收费模型。可选模型配置字段见 `.env.example`，凭据只能写入运行环境或仓库外受限文件。

## 自包含资源

- `demo_resources/PUBLIC_MANIFEST.json`：固定搭配引擎、合成目录/库存/规则/词表与四张授权 AI 固定模特图。
- `deploy_resources/DEPLOY_ASSETS_MANIFEST.json`：21 张合成商品图、三张 LOOK-101 商品单图与公开映射。
- `deploy_resources/single-products/product-image-manifest-v1.json`：三张单图的来源、SHA、SKU 对应及仍待用户视觉确认的状态。

不含用户照片、本人效果图、原人物参考图、运行数据库、私有账户、机器令牌或供应商任务账本。合成库存会过期；不能通过重建库重置累计额度或伪造持续可售。

## 测试与限制

```sh
.venv/bin/python -m pytest tests/test_demo_access.py tests/test_public_demo_portability.py
```

这些命令供独立演示复核，本轮发布未重新执行。全部旧测试中仍有原工程夹具路径依赖，不能据此承诺任意新克隆完整回归。公网链路、真实模型质量和人工视觉评分的证据各自独立，不以合成演示替代。
