import {
  Injectable,
  Inject,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Db } from './db';
import { production, secret } from './config';
export type ChannelResult = {
  state: 'SUCCEEDED' | 'PENDING' | 'FAILED';
  channelId: string;
  amount: number;
  paidAt?: string;
};
export type PaidEvent = {
  eventId: string;
  orderId: string;
  amount: number;
  channelId: string;
  paidAt: string;
};
export abstract class PaymentProvider {
  abstract readonly name: string;
  abstract createPayment(
    orderId: string,
    amount: number,
    openid: string,
  ): Promise<Record<string, unknown>>;
  abstract queryPayment(orderId: string): Promise<ChannelResult>;
  abstract closePayment(orderId: string): Promise<void>;
  abstract refund(refundId: string, orderId: string, amount: number): Promise<ChannelResult>;
  abstract settle(
    settlementId: string,
    orderId: string,
    sellerId: string,
    amount: number,
  ): Promise<ChannelResult>;
  abstract queryOperation(key: string): Promise<ChannelResult>;
  abstract verifyWebhook(raw: Buffer, headers: Record<string, unknown>): Promise<PaidEvent>;
}
@Injectable()
export class MockPaymentProvider extends PaymentProvider {
  readonly name = 'mock';
  constructor(@Inject(Db) private db: Db) {
    super();
    if (production) throw new Error('Mock payments are forbidden in production');
  }
  async createPayment(orderId: string, amount: number) {
    return { mode: 'mock', orderId, amount, notice: '内部模拟支付，不涉及真实资金' };
  }
  async queryPayment(orderId: string): Promise<ChannelResult> {
    const op = await this.db.channelOperation.findUnique({ where: { key: `pay:${orderId}` } });
    return {
      state:
        op?.status === 'SUCCEEDED' ? 'SUCCEEDED' : op?.status === 'CLOSED' ? 'FAILED' : 'PENDING',
      channelId: op?.channelId || '',
      amount: op?.amount || 0,
      paidAt: op?.updatedAt.toISOString(),
    };
  }
  async closePayment(orderId: string) {
    await this.db.channelOperation.upsert({
      where: { key: `pay:${orderId}` },
      create: {
        key: `pay:${orderId}`,
        kind: 'PAY',
        amount: 0,
        status: 'CLOSED',
        channelId: `mock-pay-${orderId}`,
      },
      update: {},
    });
  }
  async paid(orderId: string, amount: number) {
    const op = await this.db.channelOperation.upsert({
      where: { key: `pay:${orderId}` },
      create: {
        key: `pay:${orderId}`,
        kind: 'PAY',
        amount,
        status: 'SUCCEEDED',
        channelId: `mock-pay-${orderId}`,
      },
      update: { status: 'SUCCEEDED', amount },
    });
    return {
      eventId: op.key,
      orderId,
      amount,
      channelId: op.channelId,
      paidAt: new Date().toISOString(),
    };
  }
  private async operation(key: string, kind: string, amount: number): Promise<ChannelResult> {
    const op = await this.db.channelOperation.upsert({
      where: { key },
      create: { key, kind, amount, status: 'SUCCEEDED', channelId: `mock-${key}` },
      update: {},
    });
    return {
      state: op.status as ChannelResult['state'],
      channelId: op.channelId,
      amount: op.amount,
    };
  }
  async refund(refundId: string, _orderId: string, amount: number) {
    return this.operation(`refund:${refundId}`, 'REFUND', amount);
  }
  async settle(settlementId: string, _orderId: string, _sellerId: string, amount: number) {
    return this.operation(`settle:${settlementId}`, 'SETTLE', amount);
  }
  async queryOperation(key: string): Promise<ChannelResult> {
    const op = await this.db.channelOperation.findUnique({ where: { key } });
    return {
      state: (op?.status as ChannelResult['state']) || 'PENDING',
      channelId: op?.channelId || '',
      amount: op?.amount || 0,
    };
  }
  async verifyWebhook(raw: Buffer, headers: Record<string, unknown>) {
    const signature = String(headers['x-mock-signature'] || '');
    const digest = createHmac('sha256', secret('JWT_SECRET')).update(raw).digest('hex');
    if (
      signature.length !== digest.length ||
      !timingSafeEqual(Buffer.from(signature), Buffer.from(digest))
    )
      throw new UnauthorizedException('回调签名无效');
    return JSON.parse(raw.toString()) as PaidEvent;
  }
}
export function providerFactory(db: Db): PaymentProvider {
  if (process.env.PAYMENT_PROVIDER === 'mock' && !production) return new MockPaymentProvider(db);
  throw new ServiceUnavailableException(
    '真实平台支付适配器尚未配置。须按获准的支付产品实现并核验支付、退款和结算能力，禁止上线模拟渠道。',
  );
}
