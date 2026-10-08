import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Db } from './db';
import { Actor, requireVerified } from './auth';
import { Events } from './events';
import { Storage } from './storage';
@Injectable()
export class Chat {
  constructor(
    @Inject(Db) private db: Db,
    @Inject(Events) private events: Events,
    @Inject(Storage) private storage: Storage,
  ) {}
  async start(actor: Actor, productId: string) {
    requireVerified(actor);
    const product = await this.db.product.findUnique({ where: { id: productId } });
    if (!product || !['ACTIVE', 'RESERVED', 'SOLD'].includes(product.status))
      throw new NotFoundException('教材不可咨询');
    if (product.sellerId === actor.id) throw new BadRequestException('不能联系自己');
    const seller = await this.db.user.findUniqueOrThrow({ where: { id: product.sellerId } });
    if (!seller.verified || seller.banned) throw new BadRequestException('卖家暂不可交流');
    return this.db.conversation.upsert({
      where: {
        buyerId_sellerId_productId: { buyerId: actor.id, sellerId: product.sellerId, productId },
      },
      create: { buyerId: actor.id, sellerId: product.sellerId, productId },
      update: {},
    });
  }
  async owned(actor: Actor, id: string) {
    const conversation = await this.db.conversation.findUnique({ where: { id } });
    if (!conversation || ![conversation.buyerId, conversation.sellerId].includes(actor.id))
      throw new ForbiddenException('无权访问会话');
    return conversation;
  }
  async list(actor: Actor) {
    requireVerified(actor);
    const rows = await this.db.conversation.findMany({
      where: { OR: [{ buyerId: actor.id }, { sellerId: actor.id }] },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });
    return Promise.all(
      rows.map(async (c) => {
        const otherId = c.buyerId === actor.id ? c.sellerId : c.buyerId;
        const [other, product, last, receipt] = await Promise.all([
          this.db.user.findUnique({ where: { id: otherId }, select: { id: true, nickname: true } }),
          this.db.product.findUnique({ where: { id: c.productId }, select: { title: true } }),
          this.db.message.findFirst({
            where: { conversationId: c.id },
            orderBy: { createdAt: 'desc' },
          }),
          this.db.readReceipt.findUnique({
            where: { conversationId_userId: { conversationId: c.id, userId: actor.id } },
          }),
        ]);
        return {
          ...c,
          other,
          product,
          last,
          unread: await this.db.message.count({
            where: {
              conversationId: c.id,
              senderId: { not: actor.id },
              createdAt: { gt: receipt?.readAt || new Date(0) },
            },
          }),
        };
      }),
    );
  }
  async messages(actor: Actor, id: string, beforeId?: string) {
    requireVerified(actor);
    await this.owned(actor, id);
    if (
      beforeId &&
      !(await this.db.message.findFirst({ where: { id: beforeId, conversationId: id } }))
    )
      throw new BadRequestException('消息游标无效');
    return this.db.message.findMany({
      where: { conversationId: id },
      ...(beforeId ? { cursor: { id: beforeId }, skip: 1 } : {}),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 50,
    });
  }
  async orderConversation(actor: Actor, orderId: string) {
    requireVerified(actor);
    const order = await this.db.order.findUniqueOrThrow({ where: { id: orderId } });
    if (![order.buyerId, order.sellerId].includes(actor.id))
      throw new ForbiddenException('无权联系订单交易双方');
    return this.db.conversation.upsert({
      where: {
        buyerId_sellerId_productId: {
          buyerId: order.buyerId,
          sellerId: order.sellerId,
          productId: order.productId,
        },
      },
      create: { buyerId: order.buyerId, sellerId: order.sellerId, productId: order.productId },
      update: {},
    });
  }
  async send(actor: Actor, id: string, kind: string, body: string, clientId: string) {
    requireVerified(actor);
    const conversation = await this.owned(actor, id);
    const other = await this.db.user.findUniqueOrThrow({
      where: {
        id: conversation.buyerId === actor.id ? conversation.sellerId : conversation.buyerId,
      },
    });
    if (other.banned) throw new ForbiddenException('对方账号已封禁');
    if (kind === 'IMAGE') await this.storage.own(actor.id, [body], 'CHAT');
    if (kind === 'PRODUCT' && body !== conversation.productId)
      throw new BadRequestException('仅可发送本会话的教材卡片');
    const message = await this.db.$transaction(
      async (tx) => {
        // Serialize only this conversation. ReadCommitted plus an explicit row
        // lock avoids rollback storms when many distinct messages arrive at once.
        await tx.$queryRaw`SELECT "id" FROM "Conversation" WHERE "id"=${id} FOR UPDATE`;
        const duplicate = await tx.message.findUnique({
          where: { senderId_clientId: { senderId: actor.id, clientId } },
        });
        if (duplicate) {
          if (duplicate.conversationId !== id || duplicate.body !== body || duplicate.kind !== kind)
            throw new BadRequestException('消息重试标识冲突');
          return duplicate;
        }
        const message = await tx.message.create({
          data: {
            conversationId: id,
            senderId: actor.id,
            kind,
            body,
            clientId,
            createdAt: new Date(),
          },
        });
        await tx.conversation.update({ where: { id }, data: { updatedAt: new Date() } });
        return message;
      },
      { maxWait: 15000, timeout: 15000, isolationLevel: 'ReadCommitted' },
    );
    this.events.emit(conversation.buyerId, { event: 'message', data: message });
    this.events.emit(conversation.sellerId, { event: 'message', data: message });
    return message;
  }
  async read(actor: Actor, id: string) {
    const conversation = await this.owned(actor, id);
    const receipt = await this.db.readReceipt.upsert({
      where: { conversationId_userId: { conversationId: id, userId: actor.id } },
      create: { conversationId: id, userId: actor.id },
      update: { readAt: new Date() },
    });
    this.events.emit(
      conversation.buyerId === actor.id ? conversation.sellerId : conversation.buyerId,
      { event: 'read', data: receipt },
    );
    return receipt;
  }
}
