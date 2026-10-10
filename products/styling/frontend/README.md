# 穿搭前端

Next.js 消费者工作区和管理者后台。自然语言驱动搭配沟通，商品与搭配展示使用明确的合成来源；管理端支持来源核对、具体版本批准和发送状态查看。当前系列管理样式、公网前缀与免登录演示适配已包含在源码中。

## 本机安装与启动

先按 [后端本机演示](../backend/PORTABLE_DEMO.md) 启动独立后端，并将其 `--public-origin` 设为 `http://localhost:3010`。

```sh
npm ci
BACKEND_URL=http://127.0.0.1:8000 npm run build
BACKEND_URL=http://127.0.0.1:8000 HOSTNAME=127.0.0.1 PORT=3010 npm start
```

消费者入口 `http://localhost:3010/`；管理入口 `http://localhost:3010/admin`。后端显式启用演示时页面自动建立对应合成角色上下文，不在文档中提供共享密码。所有写操作仍受服务端身份、版本、用途与精确 Origin 检查。

开发模式可执行 `BACKEND_URL=http://127.0.0.1:8000 npm run dev`。生产构建默认为 standalone；`scripts/prepare-standalone.mjs` 复制必要静态文件，`scripts/start.mjs` 运行构建后的服务。`.next*`、`next-env.d.ts`、依赖目录与运行环境值不随源码发布。

## 公网前缀

`NEXT_PUBLIC_BASE_PATH=/v2/styling` 必须在构建时确定，并在同一运行配置中保持一致；`BACKEND_URL` 指向受信任的本产品后端。BFF 会透传必要 Cookie/Origin 并保留接口错误，不把免登录角色当作机器交接凭据。部署参数、存储与模型额度见 [HTTPS_DEPLOYMENT.md](../backend/HTTPS_DEPLOYMENT.md)。

## 素材与个人照片

`public/showcase-products/` 的 21 图为既有 AI 合成商品；`public/look-examples/` 的四图是授权固定模特搭配；`public/images/editorial-styling.png` 是原创 AI 风格意向图，不是商品实拍。公开源码不包含上传照片、个人结果或历史试穿证据图片。本人效果功能默认依赖后端显式启用和有界授权，缺配置时真实显示不可用。

## 静态与自动检查

```sh
npm run test
npm run lint
npm run typecheck
```

本次快照整理没有重跑上述检查或浏览器，不新增已验证视觉/模型质量结论。
