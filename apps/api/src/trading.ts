import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Db, Tx } from './db';
import { Actor, requireAdmin, requireVerified } from './auth';
import { Events } from './events';
import { MockPaymentProvider, PaidEvent, PaymentProvider } from './payments';
import { Prisma } from '@prisma/client';
const HOUR = 3600000;
@Injectable()
export class Trading {
  constructor(
    @Inject(Db) private db: Db,
    @Inject(Events) private events: Events,
    @Inject(PaymentProvider) private provider: PaymentProvider,
  ) {}
  private async owned(tx: Tx, id: string, actor: Actor) {
    const order = await tx.order.findUnique({ where: { id } });
    if (!order) throw new NotFoundException('订单不存在');
    if (actor.role !== 'ADMIN' && actor.id !== order.buyerId && actor.id !== order.sellerId)
      throw new ForbiddenException('无权访问订单');
    return order;
  }
  async create(actor: Actor, productId: string) {
    requireVerified(actor);
    return this.db.atomic(async (tx) => {
      if ((await tx.setting.findUnique({ where: { key: 'tradingPaused' } }))?.value === true)
        throw new ForbiddenException('平台暂停新交易');
      const product = await tx.product.findUnique({ where: { id: productId } });
      if (!product || product.status !== 'ACTIVE') throw new BadRequestException('教材不可购买');
      if (product.sellerId === actor.id) throw new BadRequestException('不能购买自己的教材');
      const seller = await tx.user.findUniqueOrThrow({ where: { id: product.sellerId } });
      if (seller.banned || !seller.verified) throw new BadRequestException('卖家暂不可交易');
      const reserved = await tx.product.updateMany({
        where: { id: productId, status: 'ACTIVE' },
        data: { status: 'RESERVED' },
      });
      if (!reserved.count) throw new BadRequestException('教材已被其他买家锁定');
      const order = await tx.order.create({
        data: {
          buyerId: actor.id,
          sellerId: product.sellerId,
          productId,
          amount: product.price,
          fee: 0,
          snapshot: JSON.parse(JSON.stringify(product)),
          expiresAt: new Date(Date.now() + 15 * 60000),
        },
      });
      await tx.payment.create({
        data: { orderId: order.id, provider: this.provider.name, amount: order.amount },
      });
      await this.events.task(
        tx,
        `expire:${order.id}`,
        'EXPIRE',
        { orderId: order.id },
        order.expiresAt,
      );
      return order;
    });
  }
  async detail(actor: Actor, id: string) {
    const order = await this.owned(this.db, id, actor);
    const [payment, refund, settlement] = await Promise.all([
      this.db.payment.findUnique({ where: { orderId: id } }),
      this.db.refund.findUnique({ where: { orderId: id } }),
      this.db.settlement.findUnique({ where: { orderId: id } }),
    ]);
    return { ...order, payment, refund, settlement };
  }
  async list(actor: Actor, role: string, page = 1) {
    const where = role === 'seller' ? { sellerId: actor.id } : { buyerId: actor.id };
    return {
      items: await this.db.order.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 20,
        skip: (page - 1) * 20,
      }),
      total: await this.db.order.count({ where }),
      page,
    };
  }
  async intent(actor: Actor, id: string) {
    requireVerified(actor);
    const order = await this.owned(this.db, id, actor);
    if (order.buyerId !== actor.id || order.status !== 'UNPAID' || order.expiresAt <= new Date())
      throw new BadRequestException('订单不可支付');
    if ((await this.db.setting.findUnique({ where: { key: 'tradingPaused' } }))?.value === true)
      throw new ForbiddenException('平台暂停新支付');
    return this.provider.createPayment(id, order.amount, actor.openid);
  }
  async mockPay(actor: Actor, id: string) {
    await this.intent(actor, id);
    if (!(this.provider instanceof MockPaymentProvider))
      throw new ForbiddenException('模拟支付未开放');
    const order = await this.owned(this.db, id, actor);
    const event = await this.provider.paid(id, order.amount);
    await this.paid(event);
    return this.detail(actor, id);
  }
  async paid(event: PaidEvent) {
    const paidAt = new Date(event.paidAt);
    if (
      !event.channelId ||
      !Number.isInteger(event.amount) ||
      !Number.isFinite(paidAt.getTime()) ||
      paidAt.getTime() > Date.now() + 5 * 60000
    )
      throw new BadRequestException('支付回调数据无效');
    return this.db.atomic(async (tx) => {
      const order = await tx.order.findUnique({ where: { id: event.orderId } });
      if (!order) throw new BadRequestException('未知支付订单');
      if (paidAt < order.createdAt) throw new BadRequestException('付款时间早于订单创建时间');
      const payment = await tx.payment.findUniqueOrThrow({ where: { orderId: order.id } });
      if (event.amount !== order.amount) throw new BadRequestException('支付金额不匹配');
      if (payment.status === 'PAID') {
        if (payment.channelId !== event.channelId) throw new BadRequestException('支付流水冲突');
        return order;
      }
      if (!['UNPAID', 'CANCELLED'].includes(order.status))
        throw new BadRequestException('订单状态不可收款');
      await tx.payment.update({
        where: { id: payment.id },
        data: { status: 'PAID', channelId: event.channelId },
      });
      const product = await tx.product.findUniqueOrThrow({ where: { id: order.productId } });
      if (
        order.status === 'CANCELLED' ||
        paidAt > order.expiresAt ||
        product.status !== 'RESERVED'
      ) {
        if (order.status === 'UNPAID')
          await tx.product.updateMany({
            where: { id: order.productId, status: 'RESERVED' },
            data: { status: 'ACTIVE' },
          });
        await tx.order.update({
          where: { id: order.id },
          data: { status: 'LATE_PAYMENT_REFUNDING', paidAt },
        });
        const refund = await tx.refund.create({
          data: {
            orderId: order.id,
            amount: order.amount,
            reason: '订单取消或锁定失效后的迟到支付，自动原路退款',
            status: 'PROCESSING',
          },
        });
        await this.events.task(tx, `refund:${refund.id}`, 'REFUND', { refundId: refund.id });
        await this.events.notify(
          tx,
          order.buyerId,
          order.id,
          '迟到支付退款',
          '订单锁定已失效，已发起全额退款',
        );
        return order;
      }
      await tx.order.update({ where: { id: order.id }, data: { status: 'PAID', paidAt } });
      await tx.product.update({ where: { id: order.productId }, data: { status: 'SOLD' } });
      await tx.ledger.create({
        data: {
          userId: order.sellerId,
          orderId: order.id,
          kind: 'PENDING',
          amount: order.amount - order.fee,
        },
      });
      await this.events.task(
        tx,
        `handoff:${order.id}`,
        'HANDOFF_TIMEOUT',
        { orderId: order.id },
        new Date(paidAt.getTime() + 72 * HOUR),
      );
      await this.events.task(
        tx,
        `settle-due:${order.id}`,
        'SETTLE_DUE',
        { orderId: order.id },
        new Date(paidAt.getTime() + 7 * 24 * HOUR),
      );
      await this.events.notify(
        tx,
        order.sellerId,
        order.id,
        '教材已付款',
        '请在付款后 72 小时内完成交付',
      );
      await this.events.notify(
        tx,
        order.buyerId,
        order.id,
        '付款成功',
        '请通过聊天约定线下交付地点',
      );
      return order;
    });
  }
  async expire(id: string, now = new Date()) {
    const order = await this.db.order.findUnique({ where: { id } });
    if (!order || order.status !== 'UNPAID' || order.expiresAt > now) return;
    // Close/query outside the database transaction. A concurrent callback is resolved by atomic state checks.
    const channel = await this.provider.queryPayment(id);
    if (channel.state === 'SUCCEEDED') {
      if (!channel.paidAt) throw new Error('渠道查单缺少付款时间');
      await this.paid({
        eventId: `query:${id}`,
        orderId: id,
        amount: channel.amount,
        channelId: channel.channelId,
        paidAt: channel.paidAt,
      });
      return;
    }
    await this.provider.closePayment(id);
    await this.db.atomic(async (tx) => {
      const current = await tx.order.findUniqueOrThrow({ where: { id } });
      if (current.status !== 'UNPAID' || current.expiresAt > now) return;
      await tx.order.update({ where: { id }, data: { status: 'CANCELLED' } });
      await tx.payment.update({ where: { orderId: id }, data: { status: 'CLOSED' } });
      await tx.product.updateMany({
        where: { id: current.productId, status: 'RESERVED' },
        data: { status: 'ACTIVE' },
      });
    });
  }
  async cancel(actor: Actor, id: string) {
    const order = await this.owned(this.db, id, actor);
    if (order.buyerId !== actor.id || order.status !== 'UNPAID')
      throw new BadRequestException('仅可取消自己的未付款订单');
    await this.db.atomic(async (tx) => {
      const current = await this.owned(tx, id, actor);
      if (current.status !== 'UNPAID') throw new BadRequestException('订单已支付');
      await tx.order.update({ where: { id }, data: { status: 'CANCELLED' } });
      await tx.product.updateMany({
        where: { id: order.productId, status: 'RESERVED' },
        data: { status: 'ACTIVE' },
      });
      await this.events.task(tx, `close:${id}`, 'CLOSE_PAYMENT', { orderId: id });
    });
    return { ok: true };
  }
  async deliver(actor: Actor, id: string) {
    requireVerified(actor);
    return this.db.atomic(async (tx) => {
      const order = await this.owned(tx, id, actor);
      if (order.sellerId !== actor.id) throw new ForbiddenException('仅卖家可标记交付');
      if (
        order.status !== 'PAID' ||
        !order.paidAt ||
        Date.now() >= order.paidAt.getTime() + 72 * HOUR
      )
        throw new BadRequestException('订单不可交付或已超过交付时限');
      await this.events.notify(
        tx,
        order.buyerId,
        id,
        '卖家已标记交付',
        '请核实教材，未收到或存在问题请申请退款',
      );
      await this.events.task(tx, `shipping:${id}`, 'WECHAT_SHIPPING', { orderId: id });
      return tx.order.update({
        where: { id },
        data: { status: 'DELIVERED', deliveredAt: new Date() },
      });
    });
  }
  async confirm(actor: Actor, id: string) {
    requireVerified(actor);
    await this.db.atomic(async (tx) => {
      const order = await this.owned(tx, id, actor);
      if (order.buyerId !== actor.id) throw new ForbiddenException('仅买家可确认收货');
      if (order.status !== 'DELIVERED' || order.disputed)
        throw new BadRequestException('订单尚未交付或正在处理纠纷');
      await tx.order.update({ where: { id }, data: { confirmedAt: new Date() } });
      await this.queueSettlement(tx, id);
    });
    return this.detail(actor, id);
  }
  private async queueSettlement(tx: Tx, id: string, now = new Date()) {
    const order = await tx.order.findUniqueOrThrow({ where: { id } });
    if (order.status !== 'DELIVERED' || order.disputed || !order.paidAt || !order.deliveredAt)
      return;
    if (!order.confirmedAt && now.getTime() < order.paidAt.getTime() + 7 * 24 * HOUR) return;
    const refund = await tx.refund.findUnique({ where: { orderId: id } });
    if (refund && !['REJECTED'].includes(refund.status)) return;
    if (
      process.env.NODE_ENV === 'production' &&
      (await tx.setting.findUnique({ where: { key: `shipping:${id}` } }))?.value !== 'SYNCED'
    )
      return;
    const settlement = await tx.settlement.upsert({
      where: { orderId: id },
      create: { orderId: id, amount: order.amount - order.fee },
      update: {},
    });
    await tx.order.update({ where: { id }, data: { status: 'SETTLING' } });
    await tx.ledger.upsert({
      where: { orderId_kind: { orderId: id, kind: 'PROCESSING' } },
      create: {
        userId: order.sellerId,
        orderId: id,
        kind: 'PROCESSING',
        amount: settlement.amount,
      },
      update: {},
    });
    await this.events.task(tx, `settlement:${settlement.id}`, 'SETTLEMENT', {
      settlementId: settlement.id,
    });
  }
  async settleDue(id: string, now = new Date()) {
    await this.db.atomic((tx) => this.queueSettlement(tx, id, now));
  }
  async requestRefund(actor: Actor, id: string, reason: string) {
    return this.db.atomic(async (tx) => {
      const order = await this.owned(tx, id, actor);
      if (order.buyerId !== actor.id) throw new ForbiddenException('仅买家可申请退款');
      if (!['PAID', 'DELIVERED'].includes(order.status))
        throw new BadRequestException('订单已进入结算、退款或尚未付款，请使用投诉入口');
      const refund = await tx.refund.upsert({
        where: { orderId: id },
        create: { orderId: id, amount: order.amount, reason },
        update: {
          reason,
          status: 'REQUESTED',
          reviewedAt: null,
          returnRequired: false,
          returnConfirmedAt: null,
          reviewReason: null,
        },
      });
      await tx.order.update({ where: { id }, data: { status: 'REFUND_REQUESTED' } });
      await this.events.notify(
        tx,
        order.sellerId,
        id,
        '买家申请退款',
        '结算已暂停，等待管理员审核',
      );
      return refund;
    });
  }
  async handoffTimeout(id: string, now = new Date()) {
    await this.db.atomic(async (tx) => {
      const order = await tx.order.findUnique({ where: { id } });
      if (
        !order ||
        !order.paidAt ||
        order.deliveredAt ||
        !['PAID', 'REFUND_REQUESTED'].includes(order.status) ||
        now.getTime() < order.paidAt.getTime() + 72 * HOUR
      )
        return;
      const refund = await tx.refund.upsert({
        where: { orderId: id },
        create: {
          orderId: id,
          amount: order.amount,
          reason: '付款后 72 小时未交付，自动退款',
          status: 'PROCESSING',
        },
        update: {
          status: 'PROCESSING',
          returnRequired: false,
          reason: '付款后 72 小时未交付，自动退款',
        },
      });
      await tx.order.update({ where: { id }, data: { status: 'REFUNDING' } });
      await this.events.task(tx, `refund:${refund.id}`, 'REFUND', { refundId: refund.id });
      await this.events.notify(
        tx,
        order.buyerId,
        id,
        '未交付自动退款',
        '已超过 72 小时交付时限，正在全额退款',
      );
    });
  }
  async reviewRefund(
    actor: Actor,
    refundId: string,
    approve: boolean,
    reason: string,
    returnRequired: boolean,
  ) {
    requireAdmin(actor);
    await this.db.atomic(async (tx) => {
      const refund = await tx.refund.findUniqueOrThrow({ where: { id: refundId } });
      if (refund.status !== 'REQUESTED') throw new BadRequestException('退款申请已处理');
      const order = await tx.order.findUniqueOrThrow({ where: { id: refund.orderId } });
      if (order.status !== 'REFUND_REQUESTED') throw new BadRequestException('订单状态已变更');
      await tx.audit.create({
        data: {
          actorId: actor.id,
          action: approve ? 'REFUND_APPROVE' : 'REFUND_REJECT',
          targetId: refundId,
          details: { reason, returnRequired },
        },
      });
      if (!approve) {
        await tx.refund.update({
          where: { id: refundId },
          data: { status: 'REJECTED', reviewedAt: new Date(), reviewReason: reason },
        });
        await tx.order.update({
          where: { id: order.id },
          data: { status: order.deliveredAt ? 'DELIVERED' : 'PAID' },
        });
        if (!order.deliveredAt && order.paidAt && Date.now() >= order.paidAt.getTime() + 72 * HOUR)
          await this.events.task(
            tx,
            `handoff-recheck:${refundId}:${Date.now()}`,
            'HANDOFF_TIMEOUT',
            { orderId: order.id },
          );
        else await this.queueSettlement(tx, order.id);
      } else {
        if (returnRequired && !order.deliveredAt)
          throw new BadRequestException('未交付订单无需退书');
        await tx.refund.update({
          where: { id: refundId },
          data: {
            status: returnRequired ? 'WAIT_RETURN' : 'PROCESSING',
            returnRequired,
            reviewedAt: new Date(),
            reviewReason: reason,
          },
        });
        await tx.order.update({
          where: { id: order.id },
          data: { status: returnRequired ? 'WAIT_RETURN' : 'REFUNDING' },
        });
        if (!returnRequired)
          await this.events.task(tx, `refund:${refundId}`, 'REFUND', { refundId });
      }
      await this.events.notify(
        tx,
        order.buyerId,
        order.id,
        approve ? '退款审核通过' : '退款申请驳回',
        reason,
      );
    });
  }
  async confirmReturn(actor: Actor, refundId: string) {
    await this.db.atomic(async (tx) => {
      const refund = await tx.refund.findUniqueOrThrow({ where: { id: refundId } });
      const order = await this.owned(tx, refund.orderId, actor);
      if (actor.id !== order.sellerId && actor.role !== 'ADMIN')
        throw new ForbiddenException('由卖家或管理员确认退书');
      if (refund.status !== 'WAIT_RETURN') throw new BadRequestException('退款无需确认退书');
      await tx.refund.update({
        where: { id: refundId },
        data: { status: 'PROCESSING', returnConfirmedAt: new Date() },
      });
      await tx.order.update({ where: { id: order.id }, data: { status: 'REFUNDING' } });
      await tx.audit.create({
        data: { actorId: actor.id, action: 'RETURN_CONFIRMED', targetId: refundId, details: {} },
      });
      await this.events.task(tx, `refund:${refundId}`, 'REFUND', { refundId });
    });
  }
  async executeRefund(refundId: string) {
    const refund = await this.db.refund.findUniqueOrThrow({ where: { id: refundId } });
    if (refund.status === 'SUCCEEDED') return;
    if (refund.status !== 'PROCESSING') throw new Error('退款尚未获准');
    const result = await this.provider.refund(refundId, refund.orderId, refund.amount);
    if (result.state !== 'SUCCEEDED') throw new Error(`退款渠道状态 ${result.state}`);
    if (result.amount !== refund.amount) throw new Error('渠道退款金额与订单不一致');
    await this.db.atomic(async (tx) => {
      const current = await tx.refund.findUniqueOrThrow({ where: { id: refundId } });
      if (current.status === 'SUCCEEDED') return;
      const order = await tx.order.findUniqueOrThrow({ where: { id: refund.orderId } });
      if (!['REFUNDING', 'LATE_PAYMENT_REFUNDING'].includes(order.status))
        throw new Error('退款订单状态冲突');
      await tx.refund.update({
        where: { id: refundId },
        data: { status: 'SUCCEEDED', channelId: result.channelId },
      });
      await tx.order.update({ where: { id: order.id }, data: { status: 'REFUNDED' } });
      await tx.audit.create({
        data: {
          action: 'REFUND_CONFIRMED',
          targetId: refundId,
          details: { orderId: order.id, amount: refund.amount, channelId: result.channelId },
        },
      });
      // A late refund never touches inventory that may now belong to a new order.
      if (order.status !== 'LATE_PAYMENT_REFUNDING')
        await tx.product.updateMany({
          where: { id: order.productId, status: 'SOLD' },
          data: { status: 'OFFLINE' },
        });
      await tx.ledger.upsert({
        where: { orderId_kind: { orderId: order.id, kind: 'REFUNDED' } },
        create: {
          userId: order.sellerId,
          orderId: order.id,
          kind: 'REFUNDED',
          amount: refund.amount,
        },
        update: {},
      });
      await this.events.notify(
        tx,
        order.buyerId,
        order.id,
        '退款完成',
        '款项已按支付渠道结果原路退回',
      );
    });
  }
  async executeSettlement(settlementId: string) {
    const settlement = await this.db.settlement.findUniqueOrThrow({ where: { id: settlementId } });
    if (settlement.status === 'SUCCEEDED') return;
    const order = await this.db.order.findUniqueOrThrow({ where: { id: settlement.orderId } });
    if (order.status !== 'SETTLING' || order.disputed) throw new Error('订单不可结算');
    const result = await this.provider.settle(
      settlementId,
      order.id,
      order.sellerId,
      settlement.amount,
    );
    if (result.state !== 'SUCCEEDED') throw new Error(`结算渠道状态 ${result.state}`);
    if (result.amount !== settlement.amount) throw new Error('渠道结算金额与订单不一致');
    await this.db.atomic(async (tx) => {
      const current = await tx.settlement.findUniqueOrThrow({ where: { id: settlementId } });
      if (current.status === 'SUCCEEDED') return;
      await tx.settlement.update({
        where: { id: settlementId },
        data: { status: 'SUCCEEDED', channelId: result.channelId },
      });
      await tx.order.update({ where: { id: order.id }, data: { status: 'SETTLED' } });
      await tx.audit.create({
        data: {
          action: 'SETTLEMENT_CONFIRMED',
          targetId: settlementId,
          details: { orderId: order.id, amount: settlement.amount, channelId: result.channelId },
        },
      });
      await tx.ledger.upsert({
        where: { orderId_kind: { orderId: order.id, kind: 'SETTLED' } },
        create: {
          userId: order.sellerId,
          orderId: order.id,
          kind: 'SETTLED',
          amount: settlement.amount,
        },
        update: {},
      });
      await this.events.notify(
        tx,
        order.sellerId,
        order.id,
        '结算完成',
        '支付渠道已确认结算成功，请核对到账记录',
      );
    });
  }
  async funds(actor: Actor) {
    const orders = await this.db.order.findMany({ where: { sellerId: actor.id } });
    const sum = (statuses: string[]) =>
      orders.filter((x) => statuses.includes(x.status)).reduce((n, x) => n + x.amount - x.fee, 0);
    return {
      pending: sum(['PAID', 'DELIVERED', 'REFUND_REQUESTED', 'WAIT_RETURN']),
      processing: sum(['SETTLING', 'REFUNDING']),
      settled: sum(['SETTLED']),
      ledger: await this.db.ledger.findMany({
        where: { userId: actor.id },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      mode: this.provider.name,
    };
  }
  async reconcile() {
    const [payments, refunds, settlements] = await Promise.all([
      this.db.payment.findMany({ where: { status: 'PAID' } }),
      this.db.refund.findMany({ where: { status: 'SUCCEEDED' } }),
      this.db.settlement.findMany({ where: { status: 'SUCCEEDED' } }),
    ]);
    const differences: Array<{ kind: string; id: string; reason: string }> = [];
    for (const p of payments) {
      const channel = await this.provider.queryPayment(p.orderId);
      if (
        channel.state !== 'SUCCEEDED' ||
        channel.channelId !== p.channelId ||
        channel.amount !== p.amount
      )
        differences.push({ kind: 'PAYMENT', id: p.id, reason: '渠道付款状态或流水不一致' });
    }
    for (const r of refunds) {
      const channel = await this.provider.queryOperation(`refund:${r.id}`);
      if (
        channel.state !== 'SUCCEEDED' ||
        channel.channelId !== r.channelId ||
        channel.amount !== r.amount
      )
        differences.push({ kind: 'REFUND', id: r.id, reason: '渠道退款状态或流水不一致' });
    }
    for (const s of settlements) {
      const channel = await this.provider.queryOperation(`settle:${s.id}`);
      if (
        channel.state !== 'SUCCEEDED' ||
        channel.channelId !== s.channelId ||
        channel.amount !== s.amount
      )
        differences.push({ kind: 'SETTLEMENT', id: s.id, reason: '渠道结算状态或流水不一致' });
    }
    return {
      checkedAt: new Date(),
      mode: this.provider.name,
      payments: payments.length,
      refunds: refunds.length,
      settlements: settlements.length,
      differences,
    };
  }
}
