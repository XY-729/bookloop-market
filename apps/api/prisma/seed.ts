import '../src/config';
import { PrismaClient } from '@prisma/client';
import { hash } from 'bcryptjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';
const db = new PrismaClient();
async function main() {
  const password = process.env.ADMIN_PASSWORD;
  if (
    !password ||
    password.length < 12 ||
    (process.env.NODE_ENV === 'production' && password === 'local-admin-change-me')
  )
    throw new Error('请设置独立的 ADMIN_PASSWORD（至少 12 位）');
  await db.user.upsert({
    where: { openid: 'admin:admin' },
    create: {
      openid: 'admin:admin',
      nickname: '运营管理员',
      role: 'ADMIN',
      passwordHash: await hash(password, 12),
    },
    update: {},
  });
  for (const [kind, names] of Object.entries({
    CATEGORY: ['通用', '基础科学', '计算技术', '工程技术'],
    TOPIC: ['微积分', '基础物理', '线性代数', '程序设计', '实用英语'],
    LOCATION: ['中心城区', '周边城区'],
    HANDOFF: ['约定地点', '公共交付点', '公共取书点'],
  }))
    for (const name of names)
      await db.dictionary.upsert({
        where: { kind_name: { kind, name } },
        create: { kind, name },
        update: {},
      });
  await db.setting.upsert({
    where: { key: 'tradingPaused' },
    create: { key: 'tradingPaused', value: false },
    update: {},
  });
  if (!(await db.announcement.count()))
    await db.announcement.create({
      data: {
        title: '让教材在 BookLoop 继续流转',
        content:
          '仅交易学习教材。请核对教材版本和成色，通过聊天约定线下交付；收到教材并检查后再确认收货。',
      },
    });
  if (process.env.NODE_ENV === 'production' || process.env.SEED_DEMO === 'false') return;
  const seller = await db.user.upsert({
    where: { openid: 'dev:seller' },
    create: { openid: 'dev:seller', nickname: '模拟卖家', verified: true },
    update: {},
  });
  await db.user.upsert({
    where: { openid: 'dev:buyer' },
    create: { openid: 'dev:buyer', nickname: '模拟买家', verified: true },
    update: {},
  });
  if (await db.product.count({ where: { sellerId: seller.id } })) {await db.media.updateMany({where:{ownerId:seller.id,purpose:'PRODUCT',key:{startsWith:'public/demo-'}},data:{reviewState:'APPROVED',reviewSource:'mock'}});return;}
  const root = resolve(process.env.STORAGE_PATH || '../../.local/media');
  await mkdir(resolve(root, 'public'), { recursive: true });
  const dictionary = await db.dictionary.findMany();
  const find = (kind: string, name: string) =>
    dictionary.find((x) => x.kind === kind && x.name === name)!.id;
  const titles = [
    ['微积分 上册', '微积分', '通用', 1800, '#29645b'],
    ['基础物理 第一册', '基础物理', '基础科学', 2200, '#a26742'],
    ['线性代数', '线性代数', '通用', 1200, '#55677d'],
    ['C 语言程序设计', '程序设计', '计算技术', 2600, '#985756'],
    ['实用英语 综合教程', '实用英语', '通用', 1500, '#7d794b'],
    ['微积分 下册', '微积分', '通用', 1600, '#726183'],
  ] as const;
  for (const [title, topic, category, price, color] of titles) {
    const images: string[] = [];
    for (const side of ['正面', '反面']) {
      const svg = `<svg width="600" height="800" xmlns="http://www.w3.org/2000/svg"><rect width="600" height="800" fill="${color}"/><rect x="32" y="32" width="536" height="736" rx="8" fill="none" stroke="#ffffff" opacity=".25"/><text x="64" y="140" fill="#ffffff" font-size="20" font-family="Microsoft YaHei">学习教材</text><text x="64" y="275" fill="#ffffff" font-size="34" font-family="Microsoft YaHei">${title}</text><path d="M64 335h470" stroke="#ffffff" opacity=".5"/><text x="64" y="395" fill="#ffffff" font-size="22" font-family="Microsoft YaHei">${side} · 开发演示封面</text><text x="64" y="700" fill="#ffffff" font-size="20" font-family="Microsoft YaHei">BOOKLOOP TEXTBOOKS</text></svg>`;
      const bytes = await sharp(Buffer.from(svg)).webp().toBuffer();
      const key = `public/demo-${price}-${side === '正面' ? 'front' : 'back'}.webp`;
      await writeFile(resolve(root, key), bytes);
      const media = await db.media.upsert({
        where: { key },
        create: {
          ownerId: seller.id,
          purpose: 'PRODUCT',
          key,
          mime: 'image/webp',
          bytes: bytes.length,
          reviewState:'APPROVED',reviewSource:'mock',
        },
        update: {reviewState:'APPROVED',reviewSource:'mock'},
      });
      images.push(media.id);
    }
    await db.product.create({
      data: {
        sellerId: seller.id,
        title,
        topicId: find('TOPIC', topic),
        categoryId: find('CATEGORY', category),
        locationId: find('LOCATION', '中心城区'),
        condition: '八成新，有少量铅笔笔记，无缺页。封面为开发演示图片，实际交易请上传实拍照片。',
        handoff: '支持线下交付，具体地点和时间请通过聊天协商。',
        price,
        frontMediaId: images[0],
        backMediaId: images[1],
        status: 'ACTIVE',
      },
    });
  }
}
main().finally(() => db.$disconnect());
