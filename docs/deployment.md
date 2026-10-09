# 部署说明

## 本地和容器开发

README 给出 Windows 无 Docker 的启动方式。也提供 `Dockerfile`、`compose.yaml` 和后台 Nginx 配置，方便在具备 Docker 的环境复现。当前机器未安装 Docker，容器构建未在本机验证；已验证的是直接运行的 Node 服务和 PostgreSQL。

```sh
cp .env.example .env
docker compose up --build -d
docker compose run --rm seed
```

后台在 `http://127.0.0.1:8080`，API 在 `http://127.0.0.1:3000`。容器中的后台 Nginx 代理 API 和图片。数据库使用独立卷，图片使用媒体卷；不要执行 `docker compose down -v` 删除业务数据。

## 生产配置

真实支付适配器完成前，生产启动会失败，这是上线门槛的预期行为。接入完成后配置：

- `NODE_ENV=production`、`DEV_LOGIN_ENABLED=false`、`PAYMENT_PROVIDER=wechat-platform`、`PAYMENT_CAPABILITIES_VERIFIED=true`。
- 独立 PostgreSQL 账号与密码；`JWT_SECRET` 和 `MEDIA_SIGNING_SECRET` 至少 32 位随机值，替换所有 local-only 示例值。
- 真实 `WX_APP_ID`、`WX_APP_SECRET`、获准订阅模板及 `WX_SUBSCRIBE_FIELDS` 的字段映射。
- `STORAGE_DRIVER=s3`，独立公共和私有桶，最小权限访问凭据；禁止私有桶匿名读取。
- 两个媒体桶都禁止直接匿名读取，由服务按内容审核与权限提供图片；填写 `OPERATOR_NAME`、`SUPPORT_CONTACT` 和协议版本，审阅正式文本后设置 `LEGAL_APPROVED=true`。
- 配置 `WX_CONTENT_SAFETY=wechat`、JSON 加密消息推送 token 与 EncodingAESKey；配置 `WX_ORDER_SYNC=wechat` 并联调真实交易单号及发货管理权限。
- HTTPS `PUBLIC_API_URL` 和 `ADMIN_ORIGIN`，小程序的 request、uploadFile、downloadFile、socket 域名。
- 后端 `HOST=0.0.0.0` 用于容器内监听，外部入口使用 TLS 代理；不直接公开数据库端口。

迁移必须先于新服务启动。只使用 `prisma migrate deploy`，不在生产运行 `db push` 或重置数据库。首次管理员初始化使用构建阶段工具镜像运行 `npm run db:seed`，设置独立 `ADMIN_PASSWORD` 和 `SEED_DEMO=false`。已有账号的密码不会被重新 seed 覆盖。

订阅消息需核对模板字段，未取得授权的用户依然可查看站内通知。微信 code 登录及真实订阅消息没有在本机以正式账号验证。

## 运行监控与发布

`GET /v1/health` 检查数据库可达性；当前版本始终返回 `productionReady=false`。管理工作台展示异常任务；后端记录处理失败日志。生产部署应收集进程错误和任务 DEAD 状态，运营方每日执行资金对账。任何未解释的资金差异先暂停新交易。

迁移之前做完整备份；先部署兼容的后端，再更新后台与小程序。小程序上传前运行生产构建、核对 AppID、确认不包含开发登录配置。回滚应用版本时保留订单和任务数据，不撤销已经成功的渠道交易。

## 数据库备份与恢复

可在数据库容器执行标准 PostgreSQL 工具。以下文件写入容器临时目录，再由 `docker cp` 取回；备份包含真实交易和身份审核结果，应按私有资料保存。

```sh
docker compose exec db pg_dump -U market -Fc -f /tmp/market.dump market
docker compose cp db:/tmp/market.dump ./market.dump
docker compose exec db createdb -U market market_restore_check
docker compose cp ./market.dump db:/tmp/market.dump
docker compose exec db pg_restore -U market -d market_restore_check /tmp/market.dump
```

恢复到新数据库后核对用户、商品、订单、资金流水数量、唯一索引、未处理任务和对账结果。不得将未经核对的恢复库直接切为生产库。本地测试报告会区分已执行的数据库迁移／测试与未执行的 Docker 及正式环境恢复演练。
