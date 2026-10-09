import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID, createHmac } from 'node:crypto';
import { hash } from 'bcryptjs';
import sharp from 'sharp';
import { WebSocket } from 'ws';
import { createApp } from '../src/app';
import { Db } from '../src/db';
import { Auth, Actor } from '../src/auth';
import { Catalog } from '../src/catalog';
import { Trading } from '../src/trading';
import { PaymentProvider, MockPaymentProvider, providerFactory } from '../src/payments';
import { Chat } from '../src/chat';
import { Admin } from '../src/admin';
import { Storage } from '../src/storage';
import { Worker } from '../src/worker';
import { validateConfig } from '../src/config';
import { Legal } from '../src/legal';
let app: INestApplication,
  db: Db,
  auth: Auth,
  catalog: Catalog,
  trading: Trading,
  provider: MockPaymentProvider,
  chat: Chat,
  admin: Admin,
  storage: Storage,
  worker: Worker;
beforeAll(async () => {
  if (!process.env.DATABASE_URL?.includes('/market_test_'))
    throw new Error(
      'Tests require an isolated market_test database; run npm test from repository root',
    );
  app = await createApp();
  await app.listen(0, '127.0.0.1');
  db = app.get(Db);
  auth = app.get(Auth);
  catalog = app.get(Catalog);
  trading = app.get(Trading);
  provider = app.get(PaymentProvider) as MockPaymentProvider;
  chat = app.get(Chat);
  admin = app.get(Admin);
  storage = app.get(Storage);
  worker = app.get(Worker);
});
afterAll(async () => {
  await app?.close();
});
async function user(verified = true, role = 'USER') {
  const created = await db.user.create({
    data: { openid: `test:${randomUUID()}`, nickname: '测试用户', verified, role },
  });
  await app.get(Legal).accept(created.id, app.get(Legal).versions());
  return created;
}
async function book(seller: Actor, status = 'ACTIVE') {
  const [topic, category, location, front, back] = await Promise.all([
    db.dictionary.create({ data: { kind: 'TOPIC', name: `微积分-${randomUUID()}` } }),
    db.dictionary.create({ data: { kind: 'CATEGORY', name: `通用-${randomUUID()}` } }),
    db.dictionary.create({ data: { kind: 'LOCATION', name: `中心城区-${randomUUID()}` } }),
    db.media.create({
      data: {
        ownerId: seller.id,
        purpose: 'PRODUCT',
        key: `public/${randomUUID()}.webp`,
        mime: 'image/webp',
        bytes: 100,
        reviewState: 'APPROVED',
        reviewSource: 'mock',
      },
    }),
    db.media.create({
      data: {
        ownerId: seller.id,
        purpose: 'PRODUCT',
        key: `public/${randomUUID()}.webp`,
        mime: 'image/webp',
        bytes: 100,
        reviewState: 'APPROVED',
        reviewSource: 'mock',
      },
    }),
  ]);
  return db.product.create({
    data: {
      sellerId: seller.id,
      title: '微积分 教材',
      topicId: topic.id,
      categoryId: category.id,
      locationId: location.id,
      condition: '八成新',
      handoff: '公共交付点',
      price: 1800,
      frontMediaId: front.id,
      backMediaId: back.id,
      status,
    },
  });
}
async function fixture() {
  const seller = await user(),
    buyer = await user(),
    product = await book(seller);
  return { seller, buyer, product };
}
async function paidOrder() {
  const f = await fixture();
  const order = await trading.create(f.buyer, f.product.id);
  await trading.mockPay(f.buyer, order.id);
  return { ...f, order };
}
function bearer(actor: Actor) {
  return `Bearer ${auth.token(actor).token}`;
}
async function png() {
  return sharp({ create: { width: 16, height: 16, channels: 3, background: '#246b59' } })
    .png()
    .toBuffer();
}
async function image(actor: Actor, purpose = 'IDENTITY') {
  const buffer = await png();
  return storage.upload(
    actor,
    { buffer, size: buffer.length, mimetype: 'image/png' } as Express.Multer.File,
    purpose,
  );
}

describe('订单与资金一致性', () => {
  it('100 名试点用户中 50 个并发 HTTP 请求抢同一本书，只创建一个有效订单', async () => {
    const f = await fixture();
    const buyers = await Promise.all(Array.from({ length: 100 }, () => user()));
    const attempts = await Promise.all(
      buyers
        .slice(0, 50)
        .map((b) =>
          request(app.getHttpServer())
            .post('/v1/orders')
            .set('Authorization', bearer(b))
            .send({ productId: f.product.id }),
        ),
    );
    expect(attempts.filter((x) => x.status === 201)).toHaveLength(1);
    expect(attempts.every((x) => [201, 400, 409].includes(x.status))).toBe(true);
    expect(await db.order.count({ where: { productId: f.product.id, status: 'UNPAID' } })).toBe(1);
    expect((await db.product.findUniqueOrThrow({ where: { id: f.product.id } })).status).toBe(
      'RESERVED',
    );
  });
  it('下单保存价格快照，卖家改价不影响旧订单', async () => {
    const f = await fixture();
    const order = await trading.create(f.buyer, f.product.id);
    await catalog.price(f.seller, f.product.id, 2500);
    expect((await trading.detail(f.buyer, order.id)).amount).toBe(1800);
    expect((await db.product.findUniqueOrThrow({ where: { id: f.product.id } })).price).toBe(2500);
  });
  it('禁止购买自己的书和未认证用户交易', async () => {
    const f = await fixture();
    await expect(trading.create(f.seller, f.product.id)).rejects.toThrow('不能购买自己的教材');
    await expect(trading.create(await user(false), f.product.id)).rejects.toThrow('认证审核');
  });
  it('未付款订单超过 15 分钟取消并释放教材', async () => {
    const f = await fixture();
    const order = await trading.create(f.buyer, f.product.id);
    await db.order.update({
      where: { id: order.id },
      data: { expiresAt: new Date(Date.now() - 1) },
    });
    await trading.expire(order.id);
    expect((await trading.detail(f.buyer, order.id)).status).toBe('CANCELLED');
    expect((await db.product.findUniqueOrThrow({ where: { id: f.product.id } })).status).toBe(
      'ACTIVE',
    );
  });
  it('迟到支付全额退款，不影响已经重新锁定的教材', async () => {
    const f = await fixture();
    const old = await trading.create(f.buyer, f.product.id);
    await trading.cancel(f.buyer, old.id);
    const secondBuyer = await user();
    const current = await trading.create(secondBuyer, f.product.id);
    await trading.paid(await provider.paid(old.id, old.amount));
    const refunded = await trading.detail(f.buyer, old.id);
    expect(refunded.status).toBe('LATE_PAYMENT_REFUNDING');
    await trading.executeRefund(refunded.refund!.id);
    expect((await db.product.findUniqueOrThrow({ where: { id: f.product.id } })).status).toBe(
      'RESERVED',
    );
    expect((await trading.detail(secondBuyer, current.id)).status).toBe('UNPAID');
  });
  it('重复支付通知只产生一次待结算记录和一组任务', async () => {
    const f = await fixture();
    const order = await trading.create(f.buyer, f.product.id);
    const event = await provider.paid(order.id, order.amount);
    await Promise.all(Array.from({ length: 8 }, () => trading.paid(event)));
    expect(await db.ledger.count({ where: { orderId: order.id, kind: 'PENDING' } })).toBe(1);
    expect(await db.task.count({ where: { key: `handoff:${order.id}` } })).toBe(1);
  });
  it('金额不符的支付通知不改变订单或支付状态', async () => {
    const f = await fixture();
    const order = await trading.create(f.buyer, f.product.id);
    await expect(
      trading.paid({
        eventId: 'bad',
        orderId: order.id,
        amount: 1,
        channelId: 'bad',
        paidAt: new Date().toISOString(),
      }),
    ).rejects.toThrow('金额不匹配');
    expect((await trading.detail(f.buyer, order.id)).status).toBe('UNPAID');
  });
  it('付款 72 小时未交付自动全额退款且处理可重试', async () => {
    const f = await paidOrder();
    await db.order.update({
      where: { id: f.order.id },
      data: { paidAt: new Date(Date.now() - 73 * 3600000) },
    });
    await trading.handoffTimeout(f.order.id);
    const order = await trading.detail(f.buyer, f.order.id);
    expect(order.status).toBe('REFUNDING');
    await trading.executeRefund(order.refund!.id);
    await trading.executeRefund(order.refund!.id);
    expect((await trading.detail(f.buyer, f.order.id)).status).toBe('REFUNDED');
    expect(await db.channelOperation.count({ where: { key: `refund:${order.refund!.id}` } })).toBe(
      1,
    );
  });
  it('超过交付期限后禁止卖家补标记交付', async () => {
    const f = await paidOrder();
    await db.order.update({
      where: { id: f.order.id },
      data: { paidAt: new Date(Date.now() - 73 * 3600000) },
    });
    await expect(trading.deliver(f.seller, f.order.id)).rejects.toThrow('交付时限');
  });
  it('买家提前确认收货后显示处理中，渠道成功才显示已结算', async () => {
    const f = await paidOrder();
    await trading.deliver(f.seller, f.order.id);
    await trading.confirm(f.buyer, f.order.id);
    let o = await trading.detail(f.buyer, f.order.id);
    expect(o.status).toBe('SETTLING');
    expect((await trading.funds(f.seller)).settled).toBe(0);
    await trading.executeSettlement(o.settlement!.id);
    o = await trading.detail(f.buyer, f.order.id);
    expect(o.status).toBe('SETTLED');
    expect((await trading.funds(f.seller)).settled).toBe(1800);
  });
  it('付款满 7 天、已交付且无纠纷时自动进入结算', async () => {
    const f = await paidOrder();
    await trading.deliver(f.seller, f.order.id);
    await db.order.update({
      where: { id: f.order.id },
      data: { paidAt: new Date(Date.now() - 8 * 24 * 3600000) },
    });
    await trading.settleDue(f.order.id);
    expect((await trading.detail(f.buyer, f.order.id)).status).toBe('SETTLING');
  });
  it('未交付订单满 7 天也不进入结算', async () => {
    const f = await paidOrder();
    await db.order.update({
      where: { id: f.order.id },
      data: { paidAt: new Date(Date.now() - 8 * 24 * 3600000) },
    });
    await trading.settleDue(f.order.id);
    expect((await trading.detail(f.buyer, f.order.id)).settlement).toBeNull();
  });
  it('退款申请暂停结算，需退书的订单确认退书后才退款', async () => {
    const f = await paidOrder();
    const reviewer = await user(true, 'ADMIN');
    await trading.deliver(f.seller, f.order.id);
    const refund = await trading.requestRefund(f.buyer, f.order.id, '教材版本不符');
    await trading.settleDue(f.order.id, new Date(Date.now() + 8 * 24 * 3600000));
    expect((await trading.detail(f.buyer, f.order.id)).settlement).toBeNull();
    await trading.reviewRefund(reviewer, refund.id, true, '已核实，先退书', true);
    await expect(trading.executeRefund(refund.id)).rejects.toThrow('尚未获准');
    await trading.confirmReturn(f.seller, refund.id);
    await trading.executeRefund(refund.id);
    expect((await trading.detail(f.buyer, f.order.id)).status).toBe('REFUNDED');
  });
  it('退款驳回恢复原时间规则，到期即可结算', async () => {
    const f = await paidOrder();
    const reviewer = await user(true, 'ADMIN');
    await trading.deliver(f.seller, f.order.id);
    await db.order.update({
      where: { id: f.order.id },
      data: { paidAt: new Date(Date.now() - 8 * 24 * 3600000) },
    });
    const refund = await trading.requestRefund(f.buyer, f.order.id, '申请退书');
    await trading.reviewRefund(reviewer, refund.id, false, '未提供相应证据', false);
    expect((await trading.detail(f.buyer, f.order.id)).status).toBe('SETTLING');
  });
  it('退款与确认收货并发时只能进入一个资金分支', async () => {
    const f = await paidOrder();
    await trading.deliver(f.seller, f.order.id);
    await Promise.allSettled([
      trading.requestRefund(f.buyer, f.order.id, '版本不符'),
      trading.confirm(f.buyer, f.order.id),
    ]);
    const order = await trading.detail(f.buyer, f.order.id);
    expect(['REFUND_REQUESTED', 'SETTLING']).toContain(order.status);
    expect(Boolean(order.refund) && Boolean(order.settlement)).toBe(false);
  });
  it('结算后保留投诉入口，禁止平台自动退款', async () => {
    const f = await paidOrder();
    await trading.deliver(f.seller, f.order.id);
    await trading.confirm(f.buyer, f.order.id);
    let order = await trading.detail(f.buyer, f.order.id);
    await trading.executeSettlement(order.settlement!.id);
    await expect(trading.requestRefund(f.buyer, order.id, '事后退款')).rejects.toThrow('投诉入口');
    expect((await admin.complaint(f.buyer, order.id, '需要人工协调', [])).status).toBe('OPEN');
  });
  it('投诉暂停结算，处理全部投诉后恢复到期结算', async () => {
    const f = await paidOrder();
    await trading.deliver(f.seller, f.order.id);
    await db.order.update({
      where: { id: f.order.id },
      data: { paidAt: new Date(Date.now() - 8 * 24 * 3600000) },
    });
    const a = await admin.complaint(f.buyer, f.order.id, '教材问题', []),
      b = await admin.complaint(f.buyer, f.order.id, '交付问题', []);
    await trading.settleDue(f.order.id);
    expect((await trading.detail(f.buyer, f.order.id)).status).toBe('DELIVERED');
    const reviewer = await user(true, 'ADMIN');
    await admin.resolveComplaint(reviewer, a.id, '已协调教材问题');
    expect((await trading.detail(f.buyer, f.order.id)).disputed).toBe(true);
    await admin.resolveComplaint(reviewer, b.id, '已协调交付问题');
    expect((await trading.detail(f.buyer, f.order.id)).status).toBe('SETTLING');
  });
});

describe('身份、权限和隐私', () => {
  it('登录接口不允许提交 verified 或 role 绕过审核', async () => {
    const response = await request(app.getHttpServer()).post('/v1/auth/dev').send({
      openid: 'attacker',
      nickname: '测试',
      key: 'local-development-only',
      verified: true,
      role: 'ADMIN',
    });
    expect(response.status).toBe(400);
  });
  it('用户无权访问他人订单，非管理员无权读取后台', async () => {
    const f = await paidOrder(),
      other = await user();
    expect(
      (
        await request(app.getHttpServer())
          .get(`/v1/orders/${f.order.id}`)
          .set('Authorization', bearer(other))
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app.getHttpServer())
          .get('/v1/admin/dashboard')
          .set('Authorization', bearer(other))
      ).status,
    ).toBe(403);
  });
  it('封禁后旧 token 立即失效', async () => {
    const target = await user(),
      reviewer = await user(true, 'ADMIN');
    const token = bearer(target);
    await admin.ban(reviewer, target.id, true, '测试封禁');
    expect(
      (await request(app.getHttpServer()).get('/v1/me').set('Authorization', token)).status,
    ).toBe(403);
  });
  it('认证材料只有管理员可查看，公开路径不能读取', async () => {
    const member = await user(false),
      reviewer = await user(true, 'ADMIN');
    const media = await image(member);
    await expect(storage.signed(member, media.id)).rejects.toThrow('管理员');
    const link = await storage.signed(reviewer, media.id);
    const url = new URL(link.url);
    expect((await request(app.getHttpServer()).get(`/files/public/${media.id}`)).status).toBe(404);
    expect((await request(app.getHttpServer()).get(url.pathname + url.search)).status).toBe(200);
    expect(
      (await request(app.getHttpServer()).get(`/files/private/${media.id}?exp=1&sig=bad`)).status,
    ).toBe(403);
  });
  it('认证审核后安排 7 天删除，删除后旧签名链接不可访问', async () => {
    const member = await user(false),
      reviewer = await user(true, 'ADMIN');
    const media = await image(member);
    const verification = await catalog.verification(member, media.id);
    await admin.verify(reviewer, verification.id, true, '已核对测试证明');
    const task = await db.task.findUniqueOrThrow({ where: { key: `purge:${verification.id}` } });
    expect(task.runAt.getTime() - Date.now()).toBeGreaterThan(6.99 * 24 * 3600000);
    const link = await storage.signed(reviewer, media.id);
    await worker.execute(task);
    const url = new URL(link.url);
    expect((await request(app.getHttpServer()).get(url.pathname + url.search)).status).toBe(404);
    expect((await db.user.findUniqueOrThrow({ where: { id: member.id } })).verified).toBe(true);
  });
  it('伪装成图片的文件被拒绝', async () => {
    const actor = await user();
    await expect(
      storage.upload(
        actor,
        {
          buffer: Buffer.from('not an image'),
          size: 12,
          mimetype: 'image/png',
        } as Express.Multer.File,
        'IDENTITY',
      ),
    ).rejects.toThrow('图片内容无效');
  });
  it('教材图文修改需要重新审核，单独改价保持上架', async () => {
    const f = await fixture();
    await catalog.price(f.seller, f.product.id, 2000);
    expect((await db.product.findUniqueOrThrow({ where: { id: f.product.id } })).status).toBe(
      'ACTIVE',
    );
    const p = f.product;
    await catalog.edit(f.seller, p.id, {
      title: '微积分 修订版',
      price: 2000,
      condition: p.condition,
      handoff: p.handoff,
      topicId: p.topicId,
      categoryId: p.categoryId,
      locationId: p.locationId,
      frontMediaId: p.frontMediaId,
      backMediaId: p.backMediaId,
    });
    expect((await db.product.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('PENDING');
  });
  it('暂停新交易仍允许存量订单退款', async () => {
    const f = await paidOrder(),
      reviewer = await user(true, 'ADMIN');
    await admin.pause(reviewer, true, '测试暂停');
    try {
      await expect(trading.create(f.buyer, (await book(f.seller)).id)).rejects.toThrow('暂停');
      expect((await trading.requestRefund(f.buyer, f.order.id, '暂停期间售后')).status).toBe(
        'REQUESTED',
      );
    } finally {
      await admin.pause(reviewer, false, '测试恢复');
    }
  });
  it('管理员登录校验密码，不向客户端返回密码散列或 openid', async () => {
    const username = `test-${randomUUID()}`;
    await db.user.create({
      data: {
        openid: `admin:${username}`,
        nickname: '管理员',
        role: 'ADMIN',
        passwordHash: await hash('test-admin-password', 4),
      },
    });
    await expect(auth.adminLogin(username, 'wrong-password')).rejects.toThrow('账号或密码');
    const result = await auth.adminLogin(username, 'test-admin-password');
    expect(result.user).not.toHaveProperty('passwordHash');
    expect(result.user).not.toHaveProperty('openid');
  });
});

describe('消息、任务及接口', () => {
  it('聊天仅交易双方可见，重发相同 clientId 不重复写入', async () => {
    const f = await fixture();
    const conversation = await chat.start(f.buyer, f.product.id);
    const clientId = randomUUID();
    const first = await chat.send(f.buyer, conversation.id, 'TEXT', '请问教材版本？', clientId);
    const duplicate = await chat.send(f.buyer, conversation.id, 'TEXT', '请问教材版本？', clientId);
    expect(duplicate.id).toBe(first.id);
    await expect(chat.messages(await user(), conversation.id)).rejects.toThrow('无权');
    await expect(chat.send(f.buyer, conversation.id, 'TEXT', '不同内容', clientId)).rejects.toThrow(
      '标识冲突',
    );
  });
  it('50 个并发发送请求不丢消息，相同标识并发重试仍只记录一次', async () => {
    const f = await fixture();
    const c = await chat.start(f.buyer, f.product.id);
    const responses = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        request(app.getHttpServer())
          .post(`/v1/conversations/${c.id}/messages`)
          .set('Authorization', bearer(f.buyer))
          .send({ kind: 'TEXT', body: `并发消息 ${i}`, clientId: randomUUID() }),
      ),
    );
    expect(responses.every((r) => r.status === 201)).toBe(true);
    expect(await db.message.count({ where: { conversationId: c.id } })).toBe(50);
    const key = randomUUID();
    const repeated = await Promise.all(
      Array.from({ length: 8 }, () => chat.send(f.buyer, c.id, 'TEXT', '重复重试', key)),
    );
    expect(new Set(repeated.map((x) => x.id)).size).toBe(1);
  });
  it('消息游标在相同时间戳下仍不漏消息', async () => {
    const f = await fixture();
    const c = await chat.start(f.buyer, f.product.id);
    const when = new Date();
    await db.message.createMany({
      data: Array.from({ length: 65 }, (_, i) => ({
        conversationId: c.id,
        senderId: f.buyer.id,
        clientId: randomUUID(),
        kind: 'TEXT',
        body: `消息 ${i}`,
        createdAt: when,
      })),
    });
    const first = await chat.messages(f.seller, c.id);
    const second = await chat.messages(f.seller, c.id, first[first.length - 1].id);
    expect(first).toHaveLength(50);
    expect(second).toHaveLength(15);
    expect(new Set([...first, ...second].map((x) => x.id)).size).toBe(65);
  });
  it('聊天图片私有，仅会话成员和管理员可获取链接', async () => {
    const f = await fixture();
    const c = await chat.start(f.buyer, f.product.id);
    const media = await image(f.buyer, 'CHAT');
    await chat.send(f.buyer, c.id, 'IMAGE', media.id, randomUUID());
    expect((await storage.signed(f.seller, media.id)).url).toContain('/files/private/');
    await expect(storage.signed(await user(), media.id)).rejects.toThrow('无权');
  });
  it('WebSocket 鉴权后接收已持久化的新消息', async () => {
    const f = await fixture();
    const c = await chat.start(f.buyer, f.product.id);
    const address = app.getHttpServer().address();
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/ws`, {
      headers: { Authorization: bearer(f.seller) },
    });
    await new Promise<void>((resolve, reject) => {
      socket.on('message', (data) => {
        if (JSON.parse(String(data)).event === 'ready') resolve();
      });
      socket.on('error', reject);
    });
    const received = new Promise<any>((resolve) =>
      socket.on('message', (data) => {
        const event = JSON.parse(String(data));
        if (event.event === 'message') resolve(event);
      }),
    );
    const m = await chat.send(f.buyer, c.id, 'TEXT', '公共交付点见', randomUUID());
    expect((await received).data.id).toBe(m.id);
    socket.close();
  });
  it('回调验签：拒绝无签名事件，接受有效签名且重复通知幂等', async () => {
    const f = await fixture();
    const order = await trading.create(f.buyer, f.product.id);
    const event = await provider.paid(order.id, order.amount);
    const body = JSON.stringify(event);
    const signature = createHmac('sha256', process.env.JWT_SECRET!).update(body).digest('hex');
    expect(
      (
        await request(app.getHttpServer())
          .post('/v1/payments/webhook')
          .set('Content-Type', 'application/json')
          .send(body)
      ).status,
    ).toBe(401);
    for (let i = 0; i < 2; i++)
      expect(
        (
          await request(app.getHttpServer())
            .post('/v1/payments/webhook')
            .set('Content-Type', 'application/json')
            .set('x-mock-signature', signature)
            .send(body)
        ).status,
      ).toBe(200);
    expect(await db.ledger.count({ where: { orderId: order.id, kind: 'PENDING' } })).toBe(1);
  });
  it('渠道失败保留处理中，任务退避重试；异常任务可审计后重试', async () => {
    const f = await paidOrder();
    await trading.deliver(f.seller, f.order.id);
    await trading.confirm(f.buyer, f.order.id);
    const o = await trading.detail(f.buyer, f.order.id);
    const task = await db.task.findUniqueOrThrow({
      where: { key: `settlement:${o.settlement!.id}` },
    });
    const mocked = vi.spyOn(provider, 'settle').mockRejectedValueOnce(new Error('渠道超时'));
    await expect(trading.executeSettlement(o.settlement!.id)).rejects.toThrow('渠道超时');
    expect((await trading.detail(f.buyer, f.order.id)).status).toBe('SETTLING');
    mocked.mockRestore();
    await db.task.update({
      where: { id: task.id },
      data: { state: 'DEAD', lastError: '渠道超时' },
    });
    await admin.retry(await user(true, 'ADMIN'), task.id);
    expect((await db.task.findUniqueOrThrow({ where: { id: task.id } })).state).toBe('PENDING');
    await trading.executeSettlement(o.settlement!.id);
    await trading.executeSettlement(o.settlement!.id);
    expect(await db.ledger.count({ where: { orderId: o.id, kind: 'SETTLED' } })).toBe(1);
  });
  it('失去工作进程后过期租约可恢复，未知任务进入退避状态', async () => {
    const task = await db.task.create({
      data: {
        key: randomUUID(),
        kind: 'UNSUPPORTED_TEST',
        payload: {},
        runAt: new Date(0),
        state: 'RUNNING',
        lockedAt: new Date(Date.now() - 6 * 60000),
        lockToken: 'abandoned',
      },
    });
    await worker.tick(1);
    const current = await db.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(current.state).toBe('PENDING');
    expect(current.lastError).toContain('Unknown task');
    expect(current.lockToken).toBeNull();
  });
  it('OpenAPI 包含商品输入字段、金额单位与审核接口', async () => {
    const response = await request(app.getHttpServer()).get('/v1/openapi.json');
    expect(response.status).toBe(200);
    expect(
      response.body.paths['/v1/products'].post.requestBody.content['application/json'].schema
        .properties,
    ).toHaveProperty('frontMediaId');
    expect(response.body.paths).toHaveProperty('/v1/admin/refunds/{id}/review');
  });
  it('对账可检测渠道缺失流水', async () => {
    const f = await paidOrder();
    await db.channelOperation.update({
      where: { key: `pay:${f.order.id}` },
      data: { status: 'FAILED' },
    });
    const report = await trading.reconcile();
    expect(report.differences.some((x) => x.kind === 'PAYMENT')).toBe(true);
  });
  it('对账可检测渠道金额差异，不能仅核对成功状态', async () => {
    const f = await paidOrder();
    await db.channelOperation.update({ where: { key: `pay:${f.order.id}` }, data: { amount: 1 } });
    const report = await trading.reconcile();
    expect(report.differences.some((x) => x.kind === 'PAYMENT' && x.id)).toBe(true);
  });
  it('投诉关联聊天仅管理员可查看，并保留访问审计', async () => {
    const f = await paidOrder();
    const c = await chat.orderConversation(f.seller, f.order.id);
    await chat.send(f.buyer, c.id, 'TEXT', '教材版本与描述不符', randomUUID());
    await admin.complaint(f.buyer, f.order.id, '请求核实版本', []);
    const reviewer = await user(true, 'ADMIN');
    await expect(admin.orderEvidence(f.buyer, f.order.id)).rejects.toThrow('管理员');
    expect((await admin.orderEvidence(reviewer, f.order.id)).messages[0].body).toBe(
      '教材版本与描述不符',
    );
    expect(
      await db.audit.count({ where: { targetId: f.order.id, action: 'COMPLAINT_EVIDENCE_VIEW' } }),
    ).toBe(1);
  });
  it('重复使用旧证明材料被拒绝，避免旧清理任务删除新申请', async () => {
    const member = await user(false),
      reviewer = await user(true, 'ADMIN');
    const media = await image(member);
    const application = await catalog.verification(member, media.id);
    await admin.verify(reviewer, application.id, false, '需补充认证信息');
    await expect(catalog.verification(member, media.id)).rejects.toThrow('重新上传');
    expect((await catalog.verification(member, (await image(member)).id)).status).toBe('PENDING');
  });
  it('未配置的真实支付渠道阻止启动', () => {
    const prev = process.env.PAYMENT_PROVIDER;
    try {
      process.env.PAYMENT_PROVIDER = 'wechat-platform';
      expect(() => providerFactory(db)).toThrow('真实平台支付适配器尚未配置');
    } finally {
      process.env.PAYMENT_PROVIDER = prev;
    }
  });
});
