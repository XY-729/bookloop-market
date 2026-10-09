import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Db } from './db';
import { Actor, requireVerified } from './auth';
import { Storage } from './storage';
import { Events } from './events';
import { productInput } from './validation';
import { z } from 'zod';
import { ContentSafety } from './content-safety';
import { Legal } from './legal';
@Injectable()
export class Catalog {
  constructor(
    @Inject(Db) private db: Db,
    @Inject(Storage) private storage: Storage,
    @Inject(Events) private events: Events,
    @Inject(ContentSafety) private safety: ContentSafety,
    @Inject(Legal) private legal: Legal,
  ) {}
  async dictionaries() {
    return this.db.dictionary.findMany({
      where: { active: true },
      orderBy: [{ kind: 'asc' }, { name: 'asc' }],
    });
  }
  async announcements() {
    return this.db.announcement.findMany({
      where: { active: true },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });
  }
  async list(q: string, categoryId: string | undefined, page = 1) {
    const sellers = await this.db.user.findMany({
      where: { verified: true, banned: false },
      select: { id: true },
    });
    const topics = q
      ? await this.db.dictionary.findMany({
          where: { kind: 'TOPIC', name: { contains: q, mode: 'insensitive' } },
          select: { id: true },
        })
      : [];
    const where = {
      status: 'ACTIVE',
      sellerId: { in: sellers.map((x) => x.id) },
      ...(categoryId ? { categoryId } : {}),
      ...(q
        ? {
            OR: [
              { title: { contains: q, mode: 'insensitive' as const } },
              { topicId: { in: topics.map((x) => x.id) } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.db.product.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * 20,
        take: 20,
      }),
      this.db.product.count({ where }),
    ]);
    return {
      items: items.map((x) => ({
        ...x,
        frontUrl: this.storage.publicUrl(x.frontMediaId),
        backUrl: this.storage.publicUrl(x.backMediaId),
      })),
      total,
      page,
    };
  }
  async detail(id: string, actor?: Actor) {
    const product = await this.db.product.findUnique({ where: { id } });
    if (!product) throw new NotFoundException('教材不存在');
    if (
      !['ACTIVE', 'RESERVED', 'SOLD'].includes(product.status) &&
      product.sellerId !== actor?.id &&
      actor?.role !== 'ADMIN'
    )
      throw new NotFoundException('教材已下架');
    const seller = await this.db.user.findUniqueOrThrow({ where: { id: product.sellerId } });
    const dict = await this.dictionaries();
    return {
      ...product,
      frontUrl: this.storage.publicUrl(product.frontMediaId),
      backUrl: this.storage.publicUrl(product.backMediaId),
      topic: dict.find((x) => x.id === product.topicId)?.name,
      category: dict.find((x) => x.id === product.categoryId)?.name,
      location: dict.find((x) => x.id === product.locationId)?.name,
      seller: {
        id: seller.id,
        nickname: seller.nickname,
        verified: seller.verified,
        banned: seller.banned,
      },
    };
  }
  private async validate(actor: Actor, input: z.infer<typeof productInput>) {
    requireVerified(actor);
    await this.safety.text(actor, `${input.title}\n${input.condition}\n${input.handoff}`);
    await this.storage.own(actor.id, [input.frontMediaId, input.backMediaId], 'PRODUCT');
    if (input.frontMediaId === input.backMediaId)
      throw new BadRequestException('请分别上传教材正面和反面照片');
    for (const [kind, id] of [
      ['TOPIC', input.topicId],
      ['CATEGORY', input.categoryId],
      ['LOCATION', input.locationId],
    ])
      if (!(await this.db.dictionary.findFirst({ where: { id, kind, active: true } })))
        throw new BadRequestException('分类、主题或交付区域不存在');
  }
  async create(actor: Actor, input: z.infer<typeof productInput>) {
    await this.validate(actor, input);
    const paused = await this.db.setting.findUnique({ where: { key: 'tradingPaused' } });
    if (paused?.value === true) throw new ForbiddenException('平台暂停新交易');
    return this.db.product.create({ data: { ...input, sellerId: actor.id } });
  }
  async edit(actor: Actor, id: string, input: z.infer<typeof productInput>) {
    await this.validate(actor, input);
    return this.db.atomic(async (tx) => {
      const product = await tx.product.findUniqueOrThrow({ where: { id } });
      if (product.sellerId !== actor.id) throw new ForbiddenException('仅卖家可修改');
      if (['RESERVED', 'SOLD'].includes(product.status))
        throw new BadRequestException('已锁定或已售教材不可修改图文');
      return tx.product.update({
        where: { id },
        data: { ...input, status: 'PENDING', reviewReason: null },
      });
    });
  }
  async price(actor: Actor, id: string, price: number) {
    requireVerified(actor);
    return this.db.atomic(async (tx) => {
      const product = await tx.product.findUniqueOrThrow({ where: { id } });
      if (product.sellerId !== actor.id) throw new ForbiddenException('仅卖家可改价');
      if (product.status === 'SOLD') throw new BadRequestException('教材已出售');
      return tx.product.update({ where: { id }, data: { price } });
    });
  }
  async offline(actor: Actor, id: string) {
    return this.db.atomic(async (tx) => {
      const product = await tx.product.findUniqueOrThrow({ where: { id } });
      if (product.sellerId !== actor.id) throw new ForbiddenException('仅卖家可下架');
      if (['RESERVED', 'SOLD'].includes(product.status))
        throw new BadRequestException('请先处理已有订单');
      return tx.product.update({ where: { id }, data: { status: 'OFFLINE' } });
    });
  }
  async verification(actor: Actor, mediaId: string) {
    await this.storage.own(actor.id, [mediaId], 'IDENTITY');
    return this.db.atomic(async (tx) => {
      if (actor.verified) throw new BadRequestException('用户身份已通过审核');
      if (await tx.verification.findFirst({ where: { mediaId } }))
        throw new BadRequestException('请重新上传证明图片，每次申请使用新的材料');
      if (await tx.verification.findFirst({ where: { userId: actor.id, status: 'PENDING' } }))
        throw new BadRequestException('已有待审核申请');
      return tx.verification.create({ data: { userId: actor.id, mediaId } });
    });
  }
  async me(actor: Actor) {
    return {
      id: actor.id,
      nickname: actor.nickname,
      verified: actor.verified,
      role: actor.role,
      consent: await this.legal.status(actor.id),
      verification: await this.db.verification.findFirst({
        where: { userId: actor.id },
        orderBy: { createdAt: 'desc' },
      }),
      tradingPaused:
        (await this.db.setting.findUnique({ where: { key: 'tradingPaused' } }))?.value === true,
      paymentMode: process.env.PAYMENT_PROVIDER,
    };
  }
  async history(actor: Actor) {
    const rows = await this.db.history.findMany({
      where: { userId: actor.id },
      orderBy: { viewedAt: 'desc' },
      take: 100,
    });
    const products = await this.db.product.findMany({
      where: {
        id: { in: rows.map((x) => x.productId) },
        status: { in: ['ACTIVE', 'RESERVED', 'SOLD'] },
      },
    });
    return rows.flatMap((x) => {
      const product = products.find((p) => p.id === x.productId);
      return product
        ? [
            {
              ...product,
              frontUrl: this.storage.publicUrl(product.frontMediaId),
              viewedAt: x.viewedAt,
            },
          ]
        : [];
    });
  }
  async visit(actor: Actor, productId: string) {
    await this.detail(productId, actor);
    return this.db.history.upsert({
      where: { userId_productId: { userId: actor.id, productId } },
      create: { userId: actor.id, productId },
      update: { viewedAt: new Date() },
    });
  }
}
