import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Actor, requireAdmin } from './auth';
import { Db } from './db';
import { Events } from './events';
import { Storage } from './storage';
import { Trading } from './trading';
@Injectable()
export class Admin {
  constructor(
    @Inject(Db) private db: Db,
    @Inject(Events) private events: Events,
    @Inject(Storage) private storage: Storage,
    @Inject(Trading) private trading: Trading,
  ) {}
  async dashboard(actor: Actor) {
    requireAdmin(actor);
    const [
      users,
      products,
      orders,
      pendingVerifications,
      pendingProducts,
      pendingRefunds,
      openComplaints,
      deadTasks,
      recentOrders,
      paused,
    ] = await Promise.all([
      this.db.user.count({ where: { role: 'USER' } }),
      this.db.product.count({ where: { status: 'ACTIVE' } }),
      this.db.order.count(),
      this.db.verification.count({ where: { status: 'PENDING' } }),
      this.db.product.count({ where: { status: 'PENDING' } }),
      this.db.refund.count({ where: { status: 'REQUESTED' } }),
      this.db.complaint.count({ where: { status: 'OPEN' } }),
      this.db.task.count({ where: { state: 'DEAD' } }),
      this.db.order.findMany({ orderBy: { createdAt: 'desc' }, take: 8 }),
      this.db.setting.findUnique({ where: { key: 'tradingPaused' } }),
    ]);
    return {
      users,
      products,
      orders,
      pendingVerifications,
      pendingProducts,
      pendingRefunds,
      openComplaints,
      deadTasks,
      recentOrders,
      paused: paused?.value === true,
      paymentMode: process.env.PAYMENT_PROVIDER,
      productionReady: false,
    };
  }
  async list(actor: Actor, entity: string, page = 1, status?: string) {
    requireAdmin(actor);
    const paging = { skip: (page - 1) * 20, take: 20 };
    let items: unknown[], total: number;
    switch (entity) {
      case 'verifications': {
        const where = status ? { status } : {};
        [items, total] = await Promise.all([
          this.db.verification.findMany({ where, ...paging, orderBy: { createdAt: 'desc' } }),
          this.db.verification.count({ where }),
        ]);
        break;
      }
      case 'products': {
        const where = status ? { status } : {};
        [items, total] = await Promise.all([
          this.db.product.findMany({ where, ...paging, orderBy: { createdAt: 'desc' } }),
          this.db.product.count({ where }),
        ]);
        break;
      }
      case 'orders': {
        const where = status ? { status } : {};
        [items, total] = await Promise.all([
          this.db.order.findMany({ where, ...paging, orderBy: { createdAt: 'desc' } }),
          this.db.order.count({ where }),
        ]);
        break;
      }
      case 'refunds': {
        const where = status ? { status } : {};
        [items, total] = await Promise.all([
          this.db.refund.findMany({ where, ...paging, orderBy: { createdAt: 'desc' } }),
          this.db.refund.count({ where }),
        ]);
        break;
      }
      case 'settlements': {
        const where = status ? { status } : {};
        [items, total] = await Promise.all([
          this.db.settlement.findMany({ where, ...paging, orderBy: { createdAt: 'desc' } }),
          this.db.settlement.count({ where }),
        ]);
        break;
      }
      case 'complaints': {
        const where = status ? { status } : {};
        [items, total] = await Promise.all([
          this.db.complaint.findMany({ where, ...paging, orderBy: { createdAt: 'desc' } }),
          this.db.complaint.count({ where }),
        ]);
        break;
      }
      case 'users':
        [items, total] = await Promise.all([
          this.db.user.findMany({
            ...paging,
            orderBy: { createdAt: 'desc' },
            select: {
              id: true,
              nickname: true,
              role: true,
              verified: true,
              banned: true,
              createdAt: true,
            },
          }),
          this.db.user.count(),
        ]);
        break;
      case 'dictionaries':
        [items, total] = await Promise.all([
          this.db.dictionary.findMany({ ...paging, orderBy: [{ kind: 'asc' }, { name: 'asc' }] }),
          this.db.dictionary.count(),
        ]);
        break;
      case 'announcements':
        [items, total] = await Promise.all([
          this.db.announcement.findMany({ ...paging, orderBy: { createdAt: 'desc' } }),
          this.db.announcement.count(),
        ]);
        break;
      case 'tasks': {
        const where = status ? { state: status } : {};
        [items, total] = await Promise.all([
          this.db.task.findMany({ where, ...paging, orderBy: { createdAt: 'desc' } }),
          this.db.task.count({ where }),
        ]);
        break;
      }
      case 'audits':
        [items, total] = await Promise.all([
          this.db.audit.findMany({ ...paging, orderBy: { createdAt: 'desc' } }),
          this.db.audit.count(),
        ]);
        break;
      default:
        throw new BadRequestException('未知管理模块');
    }
    return { items, total, page };
  }
  async verify(actor: Actor, id: string, approve: boolean, reason: string) {
    requireAdmin(actor);
    return this.db.atomic(async (tx) => {
      const row = await tx.verification.findUniqueOrThrow({ where: { id } });
      if (row.status !== 'PENDING') throw new BadRequestException('申请已审核');
      const reviewedAt = new Date(),
        purgeAt = new Date(Date.now() + 7 * 24 * 3600000);
      await tx.verification.update({
        where: { id },
        data: { status: approve ? 'APPROVED' : 'REJECTED', reason, reviewedAt, purgeAt },
      });
      await tx.user.update({ where: { id: row.userId }, data: { verified: approve } });
      await tx.audit.create({
        data: {
          actorId: actor.id,
          action: approve ? 'VERIFY_APPROVE' : 'VERIFY_REJECT',
          targetId: id,
          details: { reason },
        },
      });
      await this.events.task(
        tx,
        `purge:${id}`,
        'PURGE_IDENTITY',
        { mediaId: row.mediaId },
        purgeAt,
      );
      await this.events.notify(
        tx,
        row.userId,
        '',
        '用户认证审核结果',
        approve ? '身份审核通过，可以发布、购买及聊天' : reason,
      );
      return { ok: true };
    });
  }
  async productReview(actor: Actor, id: string, approve: boolean, reason: string) {
    requireAdmin(actor);
    return this.db.atomic(async (tx) => {
      const row = await tx.product.findUniqueOrThrow({ where: { id } });
      if (row.status !== 'PENDING') throw new BadRequestException('商品已审核或不可审核');
      await tx.product.update({
        where: { id },
        data: { status: approve ? 'ACTIVE' : 'REJECTED', reviewReason: reason },
      });
      await tx.audit.create({
        data: {
          actorId: actor.id,
          action: approve ? 'PRODUCT_APPROVE' : 'PRODUCT_REJECT',
          targetId: id,
          details: { reason },
        },
      });
      return { ok: true };
    });
  }
  async offline(actor: Actor, id: string, reason: string) {
    requireAdmin(actor);
    await this.db.atomic(async (tx) => {
      const product = await tx.product.findUniqueOrThrow({ where: { id } });
      if (product.status === 'SOLD') throw new BadRequestException('已售教材需通过订单售后处理');
      await tx.product.update({ where: { id }, data: { status: 'OFFLINE', reviewReason: reason } });
      await tx.audit.create({
        data: { actorId: actor.id, action: 'PRODUCT_OFFLINE', targetId: id, details: { reason } },
      });
    });
    return { ok: true };
  }
  async ban(actor: Actor, id: string, banned: boolean, reason: string) {
    requireAdmin(actor);
    if (id === actor.id) throw new BadRequestException('不能封禁自己的管理账号');
    await this.db.atomic(async (tx) => {
      await tx.user.update({ where: { id }, data: { banned } });
      await tx.audit.create({
        data: {
          actorId: actor.id,
          action: banned ? 'USER_BAN' : 'USER_UNBAN',
          targetId: id,
          details: { reason },
        },
      });
    });
    return { ok: true };
  }
  async dictionary(
    actor: Actor,
    input: { id?: string; kind: string; name: string; active: boolean },
  ) {
    requireAdmin(actor);
    return this.db.atomic(async (tx) => {
      const { id, ...data } = input;
      if (id && (await tx.dictionary.findUniqueOrThrow({ where: { id } })).kind !== data.kind)
        throw new BadRequestException('已有条目的类别不能修改，请创建新条目');
      const row = id
        ? await tx.dictionary.update({ where: { id }, data })
        : await tx.dictionary.create({ data });
      await tx.audit.create({
        data: { actorId: actor.id, action: 'DICTIONARY_SAVE', targetId: row.id, details: data },
      });
      return row;
    });
  }
  async announcement(
    actor: Actor,
    input: { id?: string; title: string; content: string; active: boolean },
  ) {
    requireAdmin(actor);
    return this.db.atomic(async (tx) => {
      const { id, ...data } = input;
      const row = id
        ? await tx.announcement.update({ where: { id }, data })
        : await tx.announcement.create({ data });
      await tx.audit.create({
        data: { actorId: actor.id, action: 'ANNOUNCEMENT_SAVE', targetId: row.id, details: data },
      });
      return row;
    });
  }
  async pause(actor: Actor, paused: boolean, reason: string) {
    requireAdmin(actor);
    return this.db.atomic(async (tx) => {
      await tx.setting.upsert({
        where: { key: 'tradingPaused' },
        create: { key: 'tradingPaused', value: paused },
        update: { value: paused },
      });
      await tx.audit.create({
        data: {
          actorId: actor.id,
          action: paused ? 'TRADING_PAUSE' : 'TRADING_RESUME',
          targetId: 'platform',
          details: { reason },
        },
      });
      return { paused };
    });
  }
  async complaint(actor: Actor, orderId: string, content: string, evidence: string[]) {
    await this.trading.detail(actor, orderId);
    await this.storage.own(actor.id, evidence, 'EVIDENCE');
    return this.db.atomic(async (tx) => {
      const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
      if (
        ![
          'PAID',
          'DELIVERED',
          'REFUND_REQUESTED',
          'WAIT_RETURN',
          'REFUNDING',
          'SETTLING',
          'SETTLED',
          'REFUNDED',
        ].includes(order.status)
      )
        throw new BadRequestException('该订单不可投诉');
      const complaint = await tx.complaint.create({
        data: { userId: actor.id, orderId, content, evidence },
      });
      if (['PAID', 'DELIVERED', 'REFUND_REQUESTED', 'WAIT_RETURN'].includes(order.status))
        await tx.order.update({ where: { id: orderId }, data: { disputed: true } });
      return complaint;
    });
  }
  async resolveComplaint(actor: Actor, id: string, resolution: string) {
    requireAdmin(actor);
    let orderId = '';
    await this.db.atomic(async (tx) => {
      const complaint = await tx.complaint.findUniqueOrThrow({ where: { id } });
      if (complaint.status !== 'OPEN') throw new BadRequestException('投诉已处理');
      orderId = complaint.orderId;
      await tx.complaint.update({ where: { id }, data: { status: 'RESOLVED', resolution } });
      const remaining = await tx.complaint.count({
        where: { orderId, status: 'OPEN', id: { not: id } },
      });
      if (!remaining) await tx.order.update({ where: { id: orderId }, data: { disputed: false } });
      await tx.audit.create({
        data: {
          actorId: actor.id,
          action: 'COMPLAINT_RESOLVE',
          targetId: id,
          details: { resolution },
        },
      });
    });
    await this.trading.settleDue(orderId);
    return { ok: true };
  }
  async orderEvidence(actor: Actor, orderId: string) {
    requireAdmin(actor);
    if (!(await this.db.complaint.count({ where: { orderId } })))
      throw new ForbiddenException('仅可查阅存在投诉的订单证据');
    const order = await this.trading.detail(actor, orderId);
    const conversations = await this.db.conversation.findMany({
      where: { buyerId: order.buyerId, sellerId: order.sellerId, productId: order.productId },
      select: { id: true },
    });
    const rows = await this.db.message.findMany({
      where: { conversationId: { in: conversations.map((x) => x.id) } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 200,
      include: { sender: { select: { nickname: true } } },
    });
    const messages = await Promise.all(
      rows.reverse().map(async (m) => ({
        ...m,
        imageUrl: m.kind === 'IMAGE' ? (await this.storage.signed(actor, m.body)).url : null,
      })),
    );
    await this.db.audit.create({
      data: {
        actorId: actor.id,
        action: 'COMPLAINT_EVIDENCE_VIEW',
        targetId: orderId,
        details: { messageCount: messages.length },
      },
    });
    return { messages };
  }
  async retry(actor: Actor, id: string) {
    requireAdmin(actor);
    return this.db.atomic(async (tx) => {
      const task = await tx.task.findUniqueOrThrow({ where: { id } });
      if (task.state !== 'DEAD') throw new BadRequestException('仅可重试失败任务');
      await tx.task.update({
        where: { id },
        data: {
          state: 'PENDING',
          attempts: 0,
          runAt: new Date(),
          lastError: null,
          lockToken: null,
          lockedAt: null,
        },
      });
      await tx.audit.create({
        data: {
          actorId: actor.id,
          action: 'TASK_RETRY',
          targetId: id,
          details: { kind: task.kind },
        },
      });
      return { ok: true };
    });
  }
  async reconcile(actor: Actor) {
    requireAdmin(actor);
    const report = await this.trading.reconcile();
    await this.db.audit.create({
      data: {
        actorId: actor.id,
        action: 'RECONCILE',
        targetId: 'platform',
        details: JSON.parse(JSON.stringify(report)),
      },
    });
    return report;
  }
}
