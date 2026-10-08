import { Inject, Injectable } from '@nestjs/common';
import { Db, Tx } from './db';
import type { WebSocket } from 'ws';
import { Prisma } from '@prisma/client';
@Injectable()
export class Events {
  private clients = new Map<string, Set<WebSocket>>();
  constructor(@Inject(Db) private db: Db) {}
  attach(userId: string, socket: WebSocket) {
    const clients = this.clients.get(userId) || new Set();
    clients.add(socket);
    this.clients.set(userId, clients);
    socket.on('close', () => {
      clients.delete(socket);
      if (!clients.size) this.clients.delete(userId);
    });
  }
  emit(userId: string, event: unknown) {
    for (const socket of this.clients.get(userId) || [])
      if (socket.readyState === 1) socket.send(JSON.stringify(event));
  }
  async task(
    tx: Tx,
    key: string,
    kind: string,
    payload: Prisma.InputJsonValue,
    runAt = new Date(),
  ) {
    await tx.task.upsert({ where: { key }, create: { key, kind, payload, runAt }, update: {} });
  }
  async notify(tx: Tx, userId: string, orderId: string, title: string, content: string) {
    const note = await tx.notification.create({
      data: { userId, orderId: orderId || null, title, content },
    });
    await this.task(tx, `notification:${note.id}`, 'NOTIFY', { notificationId: note.id });
  }
  async sendNotification(id: string) {
    const note = await this.db.notification.findUniqueOrThrow({ where: { id } });
    this.emit(note.userId, { event: 'notification', data: note });
    const templateId = process.env.WX_SUBSCRIBE_TEMPLATE_ID;
    if (!templateId || !process.env.WX_APP_ID || !process.env.WX_APP_SECRET) return;
    // A granted subscription is reserved once. Retrying delivery must not consume a new grant.
    const marker = `wx-notify:${id}`;
    const reserved = await this.db.atomic(async (tx) => {
      const sent = await tx.setting.findUnique({ where: { key: marker } });
      if (sent) return sent.value === 'PENDING';
      const grant = await tx.subscription.updateMany({
        where: { userId: note.userId, templateId, remaining: { gt: 0 } },
        data: { remaining: { decrement: 1 } },
      });
      if (!grant.count) return false;
      await tx.setting.create({ data: { key: marker, value: 'PENDING' } });
      return true;
    });
    if (!reserved) return;
    const user = await this.db.user.findUniqueOrThrow({ where: { id: note.userId } });
    const tokenUrl = new URL('https://api.weixin.qq.com/cgi-bin/token');
    tokenUrl.search = new URLSearchParams({
      grant_type: 'client_credential',
      appid: process.env.WX_APP_ID,
      secret: process.env.WX_APP_SECRET,
    }).toString();
    const token = (await (
      await fetch(tokenUrl, { signal: AbortSignal.timeout(10000) })
    ).json()) as { access_token?: string };
    if (!token.access_token) throw new Error('订阅消息 access_token 获取失败');
    // Template fields must match the approved template supplied by the operator.
    const fields = JSON.parse(
      process.env.WX_SUBSCRIBE_FIELDS || '{"title":"thing1","content":"thing2"}',
    ) as Record<string, string>;
    const result = (await (
      await fetch(
        `https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${token.access_token}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            touser: user.openid,
            template_id: templateId,
            page: `pages/order/index?id=${note.orderId}`,
            data: {
              [fields.title]: { value: note.title.slice(0, 20) },
              [fields.content]: { value: note.content.slice(0, 20) },
            },
          }),
          signal: AbortSignal.timeout(10000),
        },
      )
    ).json()) as { errcode: number };
    if (result.errcode !== 0 && ![43101, 40003].includes(result.errcode))
      throw new Error(`微信订阅消息发送失败 ${result.errcode}`);
    await this.db.setting.update({
      where: { key: marker },
      data: { value: result.errcode === 0 ? 'SENT' : 'REJECTED' },
    });
  }
}
