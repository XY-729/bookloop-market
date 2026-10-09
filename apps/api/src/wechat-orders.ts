import { Inject, Injectable } from '@nestjs/common';
import { Db } from './db';
import { WechatClient } from './wechat-client';
import { production } from './config';
@Injectable()
export class WechatOrders {
  constructor(
    @Inject(Db) private db: Db,
    @Inject(WechatClient) private wx: WechatClient,
  ) {}
  async shipping(orderId: string) {
    const order = await this.db.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { payment: true, buyer: { select: { openid: true } } },
    });
    if (!order.deliveredAt || !order.payment?.channelId || order.payment.status !== 'PAID')
      throw new Error('订单尚不具备发货同步条件');
    const key = `shipping:${orderId}`;
    if ((await this.db.setting.findUnique({ where: { key } }))?.value === 'SYNCED') return;
    if (order.payment.provider === 'mock') {
      if (production) throw new Error('正式交易不能跳过微信发货同步');
      await this.db.setting.upsert({
        where: { key },
        create: { key, value: 'SKIPPED_MOCK' },
        update: { value: 'SKIPPED_MOCK' },
      });
      return;
    }
    if (process.env.WX_ORDER_SYNC !== 'wechat') throw new Error('真实订单必须启用微信发货同步');
    // Must be verified against the approved payment product's actual transaction ID.
    if (!/^\d{20,64}$/.test(order.payment.channelId) || order.buyer.openid.startsWith('dev:'))
      throw new Error('缺少可用于微信订单管理的真实交易单号或付款人');
    const snapshot = order.snapshot as { title: string };
    const result = await this.wx.post('/wxa/sec/order/upload_shipping_info', {
      order_key: { order_number_type: 2, transaction_id: order.payment.channelId },
      logistics_type: 4,
      delivery_mode: 1,
      shipping_list: [{ item_desc: snapshot.title.slice(0, 120) }],
      upload_time: order.deliveredAt.toISOString(),
      payer: { openid: order.buyer.openid },
    });
    if (result.errcode !== 0) throw new Error(`微信发货同步失败（${result.errcode || 'invalid'}）`);
    await this.db.atomic(async (tx) => {
      await tx.setting.upsert({
        where: { key },
        create: { key, value: 'SYNCED' },
        update: { value: 'SYNCED' },
      });
      await tx.audit.create({
        data: {
          action: 'WECHAT_SHIPPING_SYNCED',
          targetId: orderId,
          details: { transactionId: order.payment!.channelId },
        },
      });
    });
  }
}
