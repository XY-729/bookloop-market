import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { Db } from './db';
import { Actor, requireAdmin } from './auth';
import { secret } from './config';
@Injectable()
export class Storage {
  private root = resolve(process.env.STORAGE_PATH || '../../.local/media');
  private s3 =
    process.env.STORAGE_DRIVER === 's3'
      ? new S3Client({
          endpoint: process.env.S3_ENDPOINT || undefined,
          region: process.env.S3_REGION || 'ap-beijing',
          forcePathStyle: !!process.env.S3_ENDPOINT,
          credentials: {
            accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
            secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
          },
        })
      : null;
  constructor(@Inject(Db) private db: Db) {}
  private bucket(purpose: string) {
    return purpose === 'IDENTITY' || purpose === 'CHAT' || purpose === 'EVIDENCE'
      ? process.env.S3_PRIVATE_BUCKET
      : process.env.S3_PUBLIC_BUCKET;
  }
  private private(purpose: string) {
    return purpose !== 'PRODUCT';
  }
  async upload(actor: Actor, file: Express.Multer.File, purpose: string) {
    if (
      !file ||
      file.size > 5 * 1024 * 1024 ||
      !['PRODUCT', 'IDENTITY', 'CHAT', 'EVIDENCE'].includes(purpose)
    )
      throw new BadRequestException('仅允许上传 5MB 以内的教材、证明、聊天或投诉图片');
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype))
      throw new BadRequestException('仅支持 JPG、PNG、WebP');
    let buffer: Buffer;
    try {
      const image = sharp(file.buffer, { limitInputPixels: 20000000 });
      const meta = await image.metadata();
      if (!['jpeg', 'png', 'webp'].includes(meta.format || '')) throw new Error();
      buffer = await image
        .rotate()
        .resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 85 })
        .toBuffer();
    } catch {
      throw new BadRequestException('图片内容无效或尺寸过大');
    }
    const key = `${this.private(purpose) ? 'private' : 'public'}/${randomUUID()}.webp`;
    if (this.s3)
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket(purpose),
          Key: key,
          Body: buffer,
          ContentType: 'image/webp',
        }),
      );
    else {
      await mkdir(resolve(this.root, this.private(purpose) ? 'private' : 'public'), {
        recursive: true,
      });
      await writeFile(resolve(this.root, key), buffer);
    }
    const media = await this.db.media.create({
      data: { ownerId: actor.id, purpose, key, mime: 'image/webp', bytes: buffer.length },
    });
    return { id: media.id, purpose, url: this.private(purpose) ? null : this.publicUrl(media.id) };
  }
  publicUrl(id: string) {
    return `${process.env.PUBLIC_API_URL || 'http://127.0.0.1:3000'}/files/public/${id}`;
  }
  async own(actorId: string, ids: string[], purpose: string) {
    const rows = await this.db.media.findMany({
      where: { id: { in: ids }, ownerId: actorId, purpose, deleted: false },
    });
    if (rows.length !== new Set(ids).size) throw new BadRequestException('图片不存在或无权使用');
  }
  async signed(actor: Actor, id: string) {
    const media = await this.db.media.findUnique({ where: { id } });
    if (!media || media.deleted) throw new NotFoundException('图片已删除');
    if (media.purpose === 'IDENTITY') requireAdmin(actor);
    else if (media.ownerId !== actor.id && actor.role !== 'ADMIN') {
      if (media.purpose !== 'CHAT') throw new ForbiddenException('无权查看图片');
      const messages = await this.db.message.findMany({
        where: { kind: 'IMAGE', body: id },
        select: { conversationId: true },
      });
      if (
        !(await this.db.conversation.findFirst({
          where: {
            id: { in: messages.map((m) => m.conversationId) },
            OR: [{ buyerId: actor.id }, { sellerId: actor.id }],
          },
        }))
      )
        throw new ForbiddenException('无权查看图片');
    }
    const exp = Math.floor(Date.now() / 1000) + 120;
    const sig = createHmac('sha256', secret('MEDIA_SIGNING_SECRET'))
      .update(`${id}:${exp}`)
      .digest('hex');
    return {
      url: `${process.env.PUBLIC_API_URL || 'http://127.0.0.1:3000'}/files/private/${id}?exp=${exp}&sig=${sig}`,
      expiresAt: exp,
    };
  }
  async get(id: string, isPrivate: boolean, exp?: number, sig?: string) {
    const media = await this.db.media.findUnique({ where: { id } });
    if (!media || media.deleted || this.private(media.purpose) !== isPrivate)
      throw new NotFoundException('图片不存在');
    if (isPrivate) {
      const expected = createHmac('sha256', secret('MEDIA_SIGNING_SECRET'))
        .update(`${id}:${exp}`)
        .digest('hex');
      if (
        !exp ||
        exp < Math.floor(Date.now() / 1000) ||
        exp > Math.floor(Date.now() / 1000) + 125 ||
        !sig ||
        sig.length !== expected.length ||
        !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
      )
        throw new ForbiddenException('图片链接已过期');
    }
    if (this.s3) {
      const response = await this.s3.send(
        new GetObjectCommand({ Bucket: this.bucket(media.purpose), Key: media.key }),
      );
      return Buffer.from(await response.Body!.transformToByteArray());
    }
    return readFile(resolve(this.root, media.key));
  }
  async purge(id: string) {
    const media = await this.db.media.findUnique({ where: { id } });
    if (!media || media.deleted) return;
    if (this.s3)
      await this.s3.send(
        new DeleteObjectCommand({ Bucket: this.bucket(media.purpose), Key: media.key }),
      );
    else
      await unlink(resolve(this.root, media.key)).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'ENOENT') throw e;
      });
    await this.db.media.update({ where: { id }, data: { deleted: true } });
  }
}
