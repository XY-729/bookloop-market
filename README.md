# BookLoop 二手教材交易

通用二手教材交易平台，包含原生微信小程序、Vue 管理后台、NestJS 后端和 PostgreSQL 数据库。支持用户认证、教材审核、下单、聊天、线下交付、退款与结算；当前可运行的内部测试版本使用模拟支付。

**真实平台支付适配器尚未实现。生产启动会主动拒绝模拟支付，也会拒绝未配置的真实渠道；当前不能对外开展真实资金试运营。**

## 本地启动

需要 Node.js 22.12 或更新版本。以下命令在项目根目录执行。首次安装后的构建脚本仅涉及已声明的 npm 依赖；如本机 npm 提示脚本待批准，按下面命令执行。

```powershell
npm ci
npm approve-scripts @prisma/engines @prisma/client prisma sharp esbuild @embedded-postgres/windows-x64
npm rebuild @prisma/engines @prisma/client prisma sharp esbuild @embedded-postgres/windows-x64
Copy-Item .env.example .env  # 仅首次配置，不要覆盖已有 .env
npm run db:generate
```

打开一个终端启动本地数据库，无需 Docker：

```powershell
npm run dev:db
```

在另一个终端初始化表和演示资料：

```powershell
npm run db:migrate
npm run db:seed
npm run build
```

分别启动后端和后台开发服务器：

```powershell
npm run dev:api
npm run dev:admin
```

- 管理后台：<http://127.0.0.1:5173>
- API 文档：<http://127.0.0.1:3000/v1/docs>
- OpenAPI JSON：<http://127.0.0.1:3000/v1/openapi.json>
- 本地默认管理员：`admin`，密码见 `.env` 的 `ADMIN_PASSWORD`；示例值为 `local-admin-change-me`，仅用于本地。

Windows 的数据库数据及二进制缓存位于 `%LOCALAPPDATA%/bookloop-market/`，避免 PostgreSQL 二进制位于中文路径时的编码错误。媒体位于项目 `.local/media`。本地数据库只监听回环地址，退出数据库终端时正常停止服务。

## 微信小程序

用微信开发者工具导入 `apps/miniprogram`，开发配置为 `project.config.json`，代码目录为编译后的 `dist`。先运行 `npm run build -w apps/miniprogram`。本地模拟环境可在“我的”页切换买家、卖家；演示身份仅由开发接口创建，生产配置禁止该接口。

开发环境使用 `127.0.0.1:3000`。模拟器可以使用本地服务；手机真机需使用可访问的 HTTPS 域名，并在小程序后台配置 request、uploadFile、downloadFile、socket 合法域名。`127.0.0.1` 在手机上指手机自身，不能用于访问电脑。

生产构建必须显式提供自己的域名和 AppID：

```powershell
$env:MINI_API_URL = 'https://你的接口域名'
$env:MINI_APP_ID = '你的微信小程序AppID'
npm run build:production -w apps/miniprogram
```

该命令清除生成代码里的开发登录配置并生成 `project.production.config.json`。需由开发者工具加载该配置对应的产物；不要在生产构建后执行普通开发构建并上传覆盖产物。

## 校验

```powershell
npm run typecheck
npm run build
npm test
npm run check:release
```

`npm test` 自动启动独立的 PostgreSQL 测试实例（55433），创建 `market_test_时间戳` 数据库，应用全部迁移，运行测试后删除该测试数据库并停止实例。不会清空或改动开发数据库。测试覆盖交易竞争、资金状态、审核、图片隐私、消息和任务重试。

## 代码与文档

| 目录               | 内容                                      |
| ------------------ | ----------------------------------------- |
| `apps/api`         | API、支付契约、事务、任务、媒体和聊天服务 |
| `apps/api/prisma`  | 数据模型、数据库迁移、初始化资料          |
| `apps/admin`       | 审核、订单、退款、投诉和运营工作台        |
| `apps/miniprogram` | 原生 TypeScript、WXML、WXSS 小程序        |
| `scripts`          | 本地数据库、隔离测试、迁移辅助命令        |
| `docs`             | 架构、部署、运营、支付接入与测试报告      |

详细说明见 [架构说明](docs/architecture.md)、[部署说明](docs/deployment.md)、[运营操作手册](docs/operations.md)、[支付接入前置条件](docs/payment-readiness.md)、[测试报告](docs/test-report.md)。

另见 [微信小程序上线准备](docs/launch-guide.md)。小程序提供协议页与隐私授权流程，后台提供“上线准备”检查。真实内容检测、加密回调及发货同步已经接入代码流程，仍需正式账号联调。条件未齐备时 `check:release` 返回退出码 1，这是正常的发布阻断。
