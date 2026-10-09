import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createDecipheriv, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { Db, Tx } from './db';
import { WechatClient } from './wechat-client';
import { production, secret } from './config';
import type { Actor } from './auth';
function equal(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function verifyWxSignature(query: Record<string, unknown>, encrypted?: string) {
  const token = process.env.WX_MESSAGE_TOKEN;
  if (!token) throw new ServiceUnavailableException('微信消息推送未配置');
  const timestamp = String(query.timestamp || ''),
    nonce = String(query.nonce || '');
  if (
    !/^\d+$/.test(timestamp) ||
    Math.abs(Date.now() / 1000 - Number(timestamp)) > 600 ||
    !nonce ||
    nonce.length > 256
  )
    throw new ForbiddenException('微信回调时间或参数无效');
  const expected = createHash('sha1')
    .update([token, timestamp, nonce, ...(encrypted ? [encrypted] : [])].sort().join(''))
    .digest('hex');
  if (!equal(expected, String(query[encrypted ? 'msg_signature' : 'signature'] || '')))
    throw new ForbiddenException('微信回调签名无效');
}
export function decryptWxMessage(encrypted: string): string {
  const keyString = process.env.WX_ENCODING_AES_KEY;
  if (!keyString || !/^[a-zA-Z0-9+/]{43}$/.test(keyString) || !process.env.WX_APP_ID)
    throw new ServiceUnavailableException('微信回调加密配置不完整');
  try {
    if (!/^[a-zA-Z0-9+/]+={0,2}$/.test(encrypted) || encrypted.length > 350000) throw new Error();
    const key = Buffer.from(keyString + '=', 'base64'),
      ciphertext = Buffer.from(encrypted, 'base64');
    if (!ciphertext.length || ciphertext.length % 16) throw new Error();
    const decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16));
    decipher.setAutoPadding(false);
    const raw = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const padding = raw[raw.length - 1];
    if (
      padding < 1 ||
      padding > 32 ||
      !raw.subarray(raw.length - padding).every((b) => b === padding)
    )
      throw new Error();
    const packet = raw.subarray(0, raw.length - padding);
    if (packet.length < 20) throw new Error();
    const length = packet.readUInt32BE(16);
    if (length > packet.length - 20) throw new Error();
    if (packet.subarray(20 + length).toString() !== process.env.WX_APP_ID) throw new Error();
    return packet.subarray(20, 20 + length).toString('utf8');
  } catch {
    throw new ForbiddenException('微信回调密文或接收方无效');
  }
}
const callback = z
  .object({
    Event: z.literal('wxa_media_check'),
    trace_id: z.string().min(1).max(128),
    errcode: z.number().int().optional(),
    result: z.object({ suggest: z.enum(['pass', 'risky', 'review']) }).optional(),
  })
  .passthrough();
@Injectable()
export class ContentSafety {
  constructor(
    @Inject(Db) private db: Db,
    @Inject(WechatClient) private wx: WechatClient,
  ) {}
  mode() {
    const mode = process.env.WX_CONTENT_SAFETY || 'mock';
    if (!['wechat', 'mock'].includes(mode) || (production && mode !== 'wechat'))
      throw new ServiceUnavailableException('内容安全模式未正确配置');
    return mode;
  }
  async text(actor: Actor, content: string, scene = 3) {
    if (this.mode() === 'mock') return;
    if (actor.openid.startsWith('dev:') || actor.openid.startsWith('admin:'))
      throw new ForbiddenException('正式内容检测需要真实微信用户');
    const result = await this.wx.post('/wxa/msg_sec_check', {
      version: 2,
      scene,
      openid: actor.openid,
      content,
    });
    if (
      result.errcode === 87014 ||
      result.result?.suggest === 'risky' ||
      result.result?.suggest === 'review'
    )
      throw new BadRequestException('内容未通过安全审核，请修改后重试');
    if (result.errcode !== 0 || result.result?.suggest !== 'pass')
      throw new ServiceUnavailableException('内容审核暂未完成，请稍后重试');
  }
  async image(mediaId: string) {
    const media = await this.db.media.findUniqueOrThrow({ where: { id: mediaId } });
    if (media.purpose === 'IDENTITY') {
      await this.db.media.update({
        where: { id: mediaId },
        data: { reviewState: 'APPROVED', reviewSource: 'private-document' },
      });
      return;
    }
    if (this.mode() === 'mock') {
      await this.db.media.update({
        where: { id: mediaId },
        data: { reviewState: 'APPROVED', reviewSource: 'mock' },
      });
      return;
    }
    await this.db.atomic(async (tx) => {
      const check = await tx.mediaCheck.create({ data: { mediaId } });
      await tx.media.update({
        where: { id: mediaId },
        data: { reviewState: 'PENDING', reviewSource: 'wechat' },
      });
      await tx.task.create({
        data: {
          key: `media-check:${check.id}`,
          kind: 'MEDIA_CHECK',
          payload: { checkId: check.id },
          runAt: new Date(),
        },
      });
      await tx.task.create({
        data: {
          key: `media-timeout:${check.id}`,
          kind: 'MEDIA_CHECK_TIMEOUT',
          payload: { checkId: check.id },
          runAt: new Date(Date.now() + 30 * 60000),
        },
      });
    });
  }
  checkUrl(id: string) {
    const exp = Math.floor(Date.now() / 1000) + 7200;
    const sig = createHmac('sha256', secret('MEDIA_SIGNING_SECRET'))
      .update(`wechat:${id}:${exp}`)
      .digest('hex');
    return `${process.env.PUBLIC_API_URL}/files/check/${id}?exp=${exp}&sig=${sig}`;
  }
  async submitImage(checkId: string) {
    const check = await this.db.mediaCheck.findUniqueOrThrow({
      where: { id: checkId },
      include: { media: { include: { owner: { select: { openid: true } } } } },
    });
    if (check.status !== 'PENDING' || check.media.deleted) return;
    if (check.traceId) {
      await this.db.atomic((tx) => this.applyEvent(tx, check.traceId!));
      return;
    }
    if (check.media.owner.openid.startsWith('dev:'))
      throw new Error('正式图片审核不能使用模拟用户');
    const result = await this.wx.post('/wxa/media_check_async', {
      version: 2,
      scene: check.media.purpose === 'CHAT' ? 4 : 3,
      openid: check.media.owner.openid,
      media_type: 2,
      media_url: this.checkUrl(check.mediaId),
    });
    if (result.errcode !== 0 || typeof result.trace_id !== 'string')
      throw new Error(`微信图片审核提交失败（${result.errcode || 'invalid'}）`);
    await this.db.atomic(async (tx) => {
      await tx.mediaCheck.update({ where: { id: checkId }, data: { traceId: result.trace_id } });
      await this.applyEvent(tx, result.trace_id);
    });
  }
  private async applyEvent(tx: Tx, traceId: string) {
    const [check, event] = await Promise.all([
      tx.mediaCheck.findUnique({ where: { traceId } }),
      tx.wechatMediaEvent.findUnique({ where: { traceId } }),
    ]);
    if (!check || !event || !['PENDING', 'FAILED'].includes(check.status)) return;
    const value = event.payload as { errcode: number; suggest: string };
    const state =
      value.errcode !== 0 ? 'FAILED' : value.suggest === 'pass' ? 'APPROVED' : 'REJECTED';
    await tx.mediaCheck.update({ where: { id: check.id }, data: { status: state } });
    await tx.media.updateMany({
      where: { id: check.mediaId, deleted: false },
      data: { reviewState: state },
    });
    await tx.audit.create({
      data: { action: 'MEDIA_REVIEW_RESULT', targetId: check.mediaId, details: { traceId, state } },
    });
  }
  async event(query: Record<string, unknown>, body: unknown) {
    const envelope = z
      .object({ Encrypt: z.string().min(1).max(350000) })
      .passthrough()
      .safeParse(body);
    if (!envelope.success) throw new BadRequestException('需使用微信后台的 JSON 加密消息推送');
    verifyWxSignature(query, envelope.data.Encrypt);
    let value: unknown;
    try {
      value = JSON.parse(decryptWxMessage(envelope.data.Encrypt));
    } catch (e) {
      if (e instanceof ForbiddenException || e instanceof ServiceUnavailableException) throw e;
      throw new BadRequestException('微信消息格式无效');
    }
    const raw = value as Record<string, unknown>;
    if (raw?.Event !== 'wxa_media_check') return;
    const parsed = callback.safeParse(value);
    if (!parsed.success) throw new BadRequestException('审核回调格式无效');
    const data = parsed.data;
    if (!data.result && !(data.errcode && data.errcode !== 0))
      throw new BadRequestException('审核回调缺少检测结果');
    await this.db.atomic(async (tx) => {
      await tx.wechatMediaEvent.upsert({
        where: { traceId: data.trace_id },
        create: {
          traceId: data.trace_id,
          payload: { errcode: data.errcode || 0, suggest: data.result?.suggest || 'review' },
        },
        update: {},
      });
      await this.applyEvent(tx, data.trace_id);
    });
  }
  async timeout(checkId: string) {
    await this.db.atomic(async (tx) => {
      const check = await tx.mediaCheck.findUniqueOrThrow({ where: { id: checkId } });
      if (check.status !== 'PENDING') return;
      await tx.mediaCheck.update({ where: { id: checkId }, data: { status: 'FAILED' } });
      await tx.media.updateMany({
        where: { id: check.mediaId, reviewState: 'PENDING' },
        data: { reviewState: 'FAILED' },
      });
      await tx.audit.create({
        data: { action: 'MEDIA_REVIEW_TIMEOUT', targetId: check.mediaId, details: { checkId } },
      });
    });
  }
}
