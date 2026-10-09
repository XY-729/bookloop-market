import { afterAll, afterEach, beforeAll, describe, it, expect, vi } from 'vitest';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createCipheriv, createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { createApp } from '../src/app';
import { Db } from '../src/db';
import { Auth, Actor } from '../src/auth';
import { Legal } from '../src/legal';
import { Storage } from '../src/storage';
import { ContentSafety, decryptWxMessage, verifyWxSignature } from '../src/content-safety';
import { WechatClient } from '../src/wechat-client';
import { WechatOrders } from '../src/wechat-orders';
import { Trading } from '../src/trading';
import { releaseChecks } from '../src/readiness';
let app: INestApplication,
  db: Db,
  legal: Legal,
  safety: ContentSafety,
  wx: WechatClient,
  storage: Storage,
  auth: Auth;
beforeAll(async () => {
  if (!process.env.DATABASE_URL?.includes('/market_test_'))
    throw new Error('Use isolated test database');
  app = await createApp();
  await app.init();
  db = app.get(Db);
  legal = app.get(Legal);
  safety = app.get(ContentSafety);
  wx = app.get(WechatClient);
  storage = app.get(Storage);
  auth = app.get(Auth);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
afterAll(() => app.close());
async function user(consent = true, role = 'USER') {
  const actor = await db.user.create({
    data: { openid: `real-${randomUUID()}`, nickname: '测试用户', verified: true, role },
  });
  if (consent) await legal.accept(actor.id, legal.versions());
  return actor;
}
const bearer = (actor: Actor) => `Bearer ${auth.token(actor).token}`;
async function image(actor: Actor, purpose = 'PRODUCT') {
  const buffer = await sharp({
    create: { width: 24, height: 24, channels: 3, background: '#246b59' },
  })
    .png()
    .toBuffer();
  return storage.upload(
    actor,
    { buffer, size: buffer.length, mimetype: 'image/png' } as Express.Multer.File,
    purpose,
  );
}
async function product(seller: Actor) {
  const dict = await Promise.all(
    ['TOPIC', 'CATEGORY', 'LOCATION'].map((kind) =>
      db.dictionary.create({ data: { kind, name: randomUUID() } }),
    ),
  );
  const front = await image(seller),
    back = await image(seller);
  return db.product.create({
    data: {
      sellerId: seller.id,
      title: '二手教材',
      topicId: dict[0].id,
      categoryId: dict[1].id,
      locationId: dict[2].id,
      price: 1800,
      condition: '无缺页',
      handoff: '双方约定地点',
      frontMediaId: front.id,
      backMediaId: back.id,
      status: 'ACTIVE',
    },
  });
}
function callbackEvent(payload: unknown, appId = 'wx1234567890abcdef') {
  const key = Buffer.alloc(32, 9);
  vi.stubEnv('WX_MESSAGE_TOKEN', 'test-callback-token');
  vi.stubEnv('WX_ENCODING_AES_KEY', key.toString('base64').slice(0, 43));
  vi.stubEnv('WX_APP_ID', 'wx1234567890abcdef');
  const message = Buffer.from(JSON.stringify(payload)),
    size = Buffer.alloc(4);
  size.writeUInt32BE(message.length);
  const packet = Buffer.concat([Buffer.alloc(16, 1), size, message, Buffer.from(appId)]);
  const pad = 32 - (packet.length % 32);
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([
    cipher.update(Buffer.concat([packet, Buffer.alloc(pad, pad)])),
    cipher.final(),
  ]).toString('base64');
  const timestamp = String(Math.floor(Date.now() / 1000)),
    nonce = 'test-nonce';
  const signature = createHash('sha1')
    .update(['test-callback-token', timestamp, nonce, encrypted].sort().join(''))
    .digest('hex');
  return { query: { timestamp, nonce, msg_signature: signature }, body: { Encrypt: encrypted } };
}
describe('隐私与协议', () => {
  it('协议可公开阅读，运营信息未配置时明确显示内测状态', async () => {
    vi.stubEnv('OPERATOR_NAME', '');
    vi.stubEnv('SUPPORT_CONTACT', '');
    const response = await request(app.getHttpServer()).get('/v1/legal');
    expect(response.status).toBe(200);
    expect(response.body.configured).toBe(false);
    expect(response.body.privacy.length).toBeGreaterThan(3);
  });
  it('未同意协议不能下单；明确同意后继续', async () => {
    const buyer = await user(false),
      seller = await user(),
      book = await product(seller);
    const denied = await request(app.getHttpServer())
      .post('/v1/orders')
      .set('Authorization', bearer(buyer))
      .send({ productId: book.id });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('CONSENT_REQUIRED');
    expect(
      (
        await request(app.getHttpServer())
          .post('/v1/me/consent')
          .set('Authorization', bearer(buyer))
          .send({ ...legal.versions(), agree: true })
      ).status,
    ).toBe(201);
    expect(
      (
        await request(app.getHttpServer())
          .post('/v1/orders')
          .set('Authorization', bearer(buyer))
          .send({ productId: book.id })
      ).status,
    ).toBe(201);
  });
  it('不能提交过期版本或伪造同意，版本更新要求重新确认', async () => {
    const actor = await user();
    const response = await request(app.getHttpServer())
      .post('/v1/me/consent')
      .set('Authorization', bearer(actor))
      .send({ ...legal.versions(), agree: false });
    expect(response.status).toBe(400);
    await expect(legal.accept(actor.id, { privacy: 'old', terms: 'old' })).rejects.toThrow(
      '协议已更新',
    );
    vi.stubEnv('PRIVACY_VERSION', '2099-01-01');
    expect((await legal.status(actor.id)).accepted).toBe(false);
  });
  it('撤回后禁止新交易，已有付款订单仍可申请退款', async () => {
    const buyer = await user(),
      seller = await user(),
      book = await product(seller),
      trading = app.get(Trading);
    const order = await trading.create(buyer, book.id);
    await trading.mockPay(buyer, order.id);
    await legal.revoke(buyer.id);
    expect(
      (
        await request(app.getHttpServer())
          .post('/v1/orders')
          .set('Authorization', bearer(buyer))
          .send({ productId: book.id })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app.getHttpServer())
          .post(`/v1/orders/${order.id}/refunds`)
          .set('Authorization', bearer(buyer))
          .send({ reason: '交付问题' })
      ).status,
    ).toBe(201);
  });
});
describe('内容检测与回调', () => {
  it('文字未通过或检测不可用时不放行', async () => {
    vi.stubEnv('WX_CONTENT_SAFETY', 'wechat');
    const actor = await user();
    const spy = vi.spyOn(wx, 'post');
    spy.mockResolvedValueOnce({ errcode: 0, result: { suggest: 'risky' } });
    await expect(safety.text(actor, '需审核内容')).rejects.toThrow('未通过');
    spy.mockResolvedValueOnce({ errcode: 40001 });
    await expect(safety.text(actor, '需审核内容')).rejects.toThrow('暂未完成');
    spy.mockResolvedValueOnce({ errcode: 0, result: { suggest: 'pass' } });
    await expect(safety.text(actor, '合法内容')).resolves.toBeUndefined();
  });
  it('图片审核前不能公开或用于发布，校验链接可供微信读取 JPEG', async () => {
    vi.stubEnv('WX_CONTENT_SAFETY', 'wechat');
    const actor = await user();
    const media = await image(actor);
    expect(media.reviewState).toBe('PENDING');
    await expect(storage.own(actor.id, [media.id], 'PRODUCT')).rejects.toThrow('未通过');
    expect((await request(app.getHttpServer()).get(`/files/public/${media.id}`)).status).toBe(404);
    const url = new URL(safety.checkUrl(media.id));
    const response = await request(app.getHttpServer()).get(url.pathname + url.search);
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('image/jpeg');
  });
  it('认证证明不提交微信图片检测，保留管理员权限', async () => {
    vi.stubEnv('WX_CONTENT_SAFETY', 'wechat');
    const actor = await user();
    const spy = vi.spyOn(wx, 'post');
    const media = await image(actor, 'IDENTITY');
    expect((await db.media.findUniqueOrThrow({ where: { id: media.id } })).reviewSource).toBe(
      'private-document',
    );
    expect(spy).not.toHaveBeenCalled();
    await expect(storage.signed(actor, media.id)).rejects.toThrow('管理员');
  });
  it('加密回调通过后释放图片，重复回调仅记录一次结果', async () => {
    vi.stubEnv('WX_CONTENT_SAFETY', 'wechat');
    const actor = await user();
    const media = await image(actor);
    const check = await db.mediaCheck.findFirstOrThrow({ where: { mediaId: media.id } });
    await db.mediaCheck.update({ where: { id: check.id }, data: { traceId: 'trace-pass' } });
    const event = callbackEvent({
      Event: 'wxa_media_check',
      trace_id: 'trace-pass',
      result: { suggest: 'pass' },
    });
    for (let n = 0; n < 2; n++) {
      const response = await request(app.getHttpServer())
        .post('/v1/wechat/events')
        .query(event.query)
        .send(event.body);
      expect(response.status).toBe(200);
      expect(response.text).toBe('success');
    }
    expect((await storage.status(actor, media.id)).reviewState).toBe('APPROVED');
    expect(
      await db.audit.count({ where: { targetId: media.id, action: 'MEDIA_REVIEW_RESULT' } }),
    ).toBe(1);
  });
  it('回调先于提交响应到达时，保存结果并在关联 trace 后恢复', async () => {
    vi.stubEnv('WX_CONTENT_SAFETY', 'wechat');
    const actor = await user();
    const media = await image(actor);
    const check = await db.mediaCheck.findFirstOrThrow({ where: { mediaId: media.id } });
    const event = callbackEvent({
      Event: 'wxa_media_check',
      trace_id: 'trace-early',
      result: { suggest: 'pass' },
    });
    await safety.event(event.query, event.body);
    vi.spyOn(wx, 'post').mockResolvedValue({ errcode: 0, trace_id: 'trace-early' });
    await safety.submitImage(check.id);
    expect((await storage.status(actor, media.id)).reviewState).toBe('APPROVED');
  });
  it('风险图片与审核超时均保持阻断', async () => {
    vi.stubEnv('WX_CONTENT_SAFETY', 'wechat');
    const actor = await user();
    const media = await image(actor);
    const check = await db.mediaCheck.findFirstOrThrow({ where: { mediaId: media.id } });
    await db.mediaCheck.update({ where: { id: check.id }, data: { traceId: 'trace-risky' } });
    const event = callbackEvent({
      Event: 'wxa_media_check',
      trace_id: 'trace-risky',
      result: { suggest: 'risky' },
    });
    await safety.event(event.query, event.body);
    await expect(storage.own(actor.id, [media.id], 'PRODUCT')).rejects.toThrow('未通过');
    const timed = await image(actor);
    const timeout = await db.mediaCheck.findFirstOrThrow({ where: { mediaId: timed.id } });
    await safety.timeout(timeout.id);
    expect((await storage.status(actor, timed.id)).reviewState).toBe('FAILED');
  });
  it('拒绝错误签名、重放时间、错误接收方及明文消息', async () => {
    const event = callbackEvent({
      Event: 'wxa_media_check',
      trace_id: 'x',
      result: { suggest: 'pass' },
    });
    expect(() =>
      verifyWxSignature({ ...event.query, msg_signature: '中'.repeat(40) }, event.body.Encrypt),
    ).toThrow('签名');
    expect(() => verifyWxSignature({ ...event.query, timestamp: '1' }, event.body.Encrypt)).toThrow(
      '时间',
    );
    const foreign = callbackEvent({ Event: 'wxa_media_check' }, 'wx9999999999999999');
    expect(() => decryptWxMessage(foreign.body.Encrypt)).toThrow('接收方');
    expect(
      (
        await request(app.getHttpServer())
          .post('/v1/wechat/events')
          .query(event.query)
          .send({ Event: 'wxa_media_check' })
      ).status,
    ).toBe(400);
  });
  it('图片审核状态只允许所有者或管理员读取', async () => {
    const owner = await user(),
      other = await user();
    const media = await image(owner);
    expect(
      (
        await request(app.getHttpServer())
          .get(`/v1/media/${media.id}/status`)
          .set('Authorization', bearer(other))
      ).status,
    ).toBe(403);
  });
});
describe('微信接入与上线检查', () => {
  it('微信返回非法 JSON 结构时拒绝继续，不泄露凭证', async () => {
    vi.stubEnv('WX_APP_ID', 'wx1234567890abcdef');
    vi.stubEnv('WX_APP_SECRET', 'sensitive-test-secret');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('null'));
    await expect(new WechatClient().token()).rejects.toThrow('返回格式无效');
  });
  it('access token 并发获取共用请求，失效时仅重试一次并刷新', async () => {
    vi.stubEnv('WX_APP_ID', 'wx1234567890abcdef');
    vi.stubEnv('WX_APP_SECRET', 'test-secret');
    const client = new WechatClient();
    const calls = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'cached-token', expires_in: 7200 })),
      );
    expect(await Promise.all([client.token(), client.token(), client.token()])).toEqual([
      'cached-token',
      'cached-token',
      'cached-token',
    ]);
    expect(calls).toHaveBeenCalledTimes(1);
    calls
      .mockResolvedValueOnce(new Response(JSON.stringify({ errcode: 40001 })))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'refreshed-token', expires_in: 7200 })),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ errcode: 0 })));
    expect(await client.post('/wxa/msg_sec_check', {})).toEqual({ errcode: 0 });
    expect(calls).toHaveBeenCalledTimes(4);
  });
  it('交付同步先进入任务，模拟订单明确标为跳过', async () => {
    const seller = await user(),
      buyer = await user(),
      book = await product(seller),
      trading = app.get(Trading);
    const order = await trading.create(buyer, book.id);
    await trading.mockPay(buyer, order.id);
    await trading.deliver(seller, order.id);
    expect(
      await db.task.count({ where: { key: `shipping:${order.id}`, kind: 'WECHAT_SHIPPING' } }),
    ).toBe(1);
    await app.get(WechatOrders).shipping(order.id);
    expect(
      (await db.setting.findUniqueOrThrow({ where: { key: `shipping:${order.id}` } })).value,
    ).toBe('SKIPPED_MOCK');
  });
  it('真实单号的线下自提同步成功后幂等，失败时不标成功', async () => {
    const seller = await user(),
      buyer = await user(),
      book = await product(seller),
      trading = app.get(Trading);
    const order = await trading.create(buyer, book.id);
    await trading.mockPay(buyer, order.id);
    await trading.deliver(seller, order.id);
    await db.payment.update({
      where: { orderId: order.id },
      data: { provider: 'wechat-platform', channelId: '4200001234567890123456789012' },
    });
    vi.stubEnv('WX_ORDER_SYNC', 'wechat');
    const spy = vi
      .spyOn(wx, 'post')
      .mockResolvedValueOnce({ errcode: 40001 })
      .mockResolvedValueOnce({ errcode: 0 });
    await expect(app.get(WechatOrders).shipping(order.id)).rejects.toThrow('同步失败');
    expect(await db.setting.findUnique({ where: { key: `shipping:${order.id}` } })).toBeNull();
    await app.get(WechatOrders).shipping(order.id);
    await app.get(WechatOrders).shipping(order.id);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1][1]).toMatchObject({
      logistics_type: 4,
      payer: { openid: buyer.openid },
      order_key: { order_number_type: 2 },
    });
  });
  it('配置检查不暴露秘密，也不会把环境变量当作支付适配器实现', async () => {
    const marker = 'DO_NOT_LEAK_SECRET_MARKER';
    const checks = releaseChecks({
      WX_APP_SECRET: marker,
      JWT_SECRET: marker,
      MEDIA_SIGNING_SECRET: marker,
      PAYMENT_PROVIDER: 'wechat-platform',
      PAYMENT_CAPABILITIES_VERIFIED: 'true',
    });
    expect(JSON.stringify(checks)).not.toContain(marker);
    expect(checks.find((c) => c.id === 'payments')?.status).toBe('BLOCKED');
    const admin = await user(true, 'ADMIN');
    expect(
      (
        await request(app.getHttpServer())
          .get('/v1/admin/readiness')
          .set('Authorization', bearer(admin))
      ).body.ready,
    ).toBe(false);
  });
});
