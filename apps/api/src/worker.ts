import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Task } from '@prisma/client';
import { Db } from './db';
import { Trading } from './trading';
import { Events } from './events';
import { Storage } from './storage';
import { PaymentProvider } from './payments';
import { ContentSafety } from './content-safety';
import { WechatOrders } from './wechat-orders';
@Injectable()
export class Worker implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running = false;
  private logger = new Logger('TaskWorker');
  constructor(
    @Inject(Db) private db: Db,
    @Inject(Trading) private trading: Trading,
    @Inject(Events) private events: Events,
    @Inject(Storage) private storage: Storage,
    @Inject(PaymentProvider) private provider: PaymentProvider,
    @Inject(ContentSafety) private safety: ContentSafety,
    @Inject(WechatOrders) private orders: WechatOrders,
  ) {}
  onModuleInit() {
    if (process.env.WORKER_DISABLED !== 'true')
      this.timer = setInterval(
        () => void this.tick().catch((e) => this.logger.error(String(e))),
        2000,
      );
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  async tick(limit = 10) {
    if (this.running) return;
    this.running = true;
    try {
      for (let n = 0; n < limit; n++) {
        const token = randomUUID();
        const rows = await this.db.$queryRaw<Task[]>`
      UPDATE "Task" SET "state"='RUNNING', "lockedAt"=NOW(), "lockToken"=${token}, "attempts"="attempts"+1
      WHERE "id"=(SELECT "id" FROM "Task" WHERE ("state"='PENDING' AND "runAt"<=NOW()) OR ("state"='RUNNING' AND "lockedAt"<NOW()-INTERVAL '5 minutes') ORDER BY "runAt" ASC FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING *`;
        const task = rows[0];
        if (!task) break;
        try {
          await this.execute(task);
          await this.db.task.updateMany({
            where: { id: task.id, lockToken: token },
            data: { state: 'DONE', lockedAt: null, lockToken: null, lastError: null },
          });
        } catch (error) {
          const lastError = String(error).slice(0, 1000);
          const state = task.attempts >= 8 ? 'DEAD' : 'PENDING';
          await this.db.task.updateMany({
            where: { id: task.id, lockToken: token },
            data: {
              state,
              lockedAt: null,
              lockToken: null,
              lastError,
              runAt: new Date(Date.now() + Math.min(1800000, 2 ** task.attempts * 5000)),
            },
          });
          this.logger.error(`${task.kind} ${task.id}: ${lastError}`);
        }
      }
    } finally {
      this.running = false;
    }
  }
  async execute(task: Task) {
    const p = task.payload as Record<string, string>;
    switch (task.kind) {
      case 'EXPIRE':
        return this.trading.expire(p.orderId);
      case 'CLOSE_PAYMENT':
        return this.provider.closePayment(p.orderId);
      case 'HANDOFF_TIMEOUT':
        return this.trading.handoffTimeout(p.orderId);
      case 'SETTLE_DUE':
        return this.trading.settleDue(p.orderId);
      case 'REFUND':
        return this.trading.executeRefund(p.refundId);
      case 'SETTLEMENT':
        return this.trading.executeSettlement(p.settlementId);
      case 'NOTIFY':
        return this.events.sendNotification(p.notificationId);
      case 'PURGE_IDENTITY':
        return this.storage.purge(p.mediaId);
      case 'MEDIA_CHECK':
        return this.safety.submitImage(p.checkId);
      case 'MEDIA_CHECK_TIMEOUT':
        return this.safety.timeout(p.checkId);
      case 'WECHAT_SHIPPING':
        await this.orders.shipping(p.orderId);
        return this.trading.settleDue(p.orderId);
      default:
        throw new Error(`Unknown task kind ${task.kind}`);
    }
  }
}
