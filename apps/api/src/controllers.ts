import {
  Body,
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Query,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  Inject,
  HttpCode,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request, Response } from 'express';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { Auth, AuthedRequest, UserGuard, requireAdmin } from './auth';
import { Catalog } from './catalog';
import { Trading } from './trading';
import { Chat } from './chat';
import { Admin } from './admin';
import { Storage } from './storage';
import { Db } from './db';
import { PaymentProvider } from './payments';
import { parse, id, text, money, page, productInput } from './validation';
const bodyDoc = (schema: z.ZodTypeAny) =>
  ApiBody({
    schema: (zodToJsonSchema as (s: unknown, o: unknown) => unknown)(schema, {
      $refStrategy: 'none',
    }) as never,
  });
const login = z.object({ code: text(200), nickname: text(40).default('教材用户') }).strict();
const devLogin = z.object({ openid: text(80), nickname: text(40), key: text(200) }).strict();
const adminLogin = z.object({ username: text(40), password: text(200) }).strict();
const review = z.object({ approve: z.boolean(), reason: text(500) }).strict();
const refundReview = review.extend({ returnRequired: z.boolean().default(false) }).strict();
const message = z
  .object({ kind: z.enum(['TEXT', 'IMAGE', 'PRODUCT']), body: text(2000), clientId: text(100) })
  .strict();
const complaint = z
  .object({ orderId: id, content: text(2000), evidence: z.array(id).max(6).default([]) })
  .strict();
const dictionary = z
  .object({
    id: id.optional(),
    kind: z.enum(['CATEGORY', 'TOPIC', 'LOCATION', 'HANDOFF']),
    name: text(100),
    active: z.boolean().default(true),
  })
  .strict();
const announcement = z
  .object({
    id: id.optional(),
    title: text(100),
    content: text(3000),
    active: z.boolean().default(true),
  })
  .strict();

@ApiTags('登录与公共目录')
@Controller('v1')
export class PublicController {
  constructor(
    @Inject(Auth) private auth: Auth,
    @Inject(Catalog) private catalog: Catalog,
    @Inject(PaymentProvider) private payments: PaymentProvider,
    @Inject(Trading) private trading: Trading,
    @Inject(Db) private db: Db,
  ) {}
  @Post('auth/wechat') @bodyDoc(login) @ApiOperation({ summary: '微信 code 登录' }) login(
    @Body() value: unknown,
  ) {
    const b = parse(login, value);
    return this.auth.login(b.code, b.nickname);
  }
  @Post('auth/dev')
  @bodyDoc(devLogin)
  @ApiOperation({ summary: '仅开发环境的模拟微信身份登录' })
  dev(@Body() value: unknown) {
    const b = parse(devLogin, value);
    return this.auth.devLogin(b.openid, b.nickname, b.key);
  }
  @Post('auth/admin') @bodyDoc(adminLogin) @ApiOperation({ summary: '管理员登录' }) admin(
    @Body() value: unknown,
  ) {
    const b = parse(adminLogin, value);
    return this.auth.adminLogin(b.username, b.password);
  }
  @Get('dictionaries') dictionaries() {
    return this.catalog.dictionaries();
  }
  @Get('announcements') announcements() {
    return this.catalog.announcements();
  }
  @Get('products') @ApiOperation({ summary: '教材搜索，固定每页 20 条' }) list(
    @Query('q') q = '',
    @Query('categoryId') categoryId?: string,
    @Query('page') p?: string,
  ) {
    return this.catalog.list(
      parse(z.string().trim().max(100), q),
      categoryId ? parse(id, categoryId) : undefined,
      page(p),
    );
  }
  @Get('products/:id') detail(@Param('id') value: string) {
    return this.catalog.detail(parse(id, value));
  }
  @Post('payments/webhook')
  @HttpCode(200)
  @ApiOperation({ summary: '支付渠道验签回调，不接受客户端自行上报收款' })
  async webhook(@Req() req: Request & { rawBody?: Buffer }) {
    const event = await this.payments.verifyWebhook(req.rawBody || Buffer.alloc(0), req.headers);
    await this.trading.paid(event);
    return { code: 'SUCCESS' };
  }
  @Get('health') async health() {
    await this.db.$queryRaw`SELECT 1`;
    return { status: 'ok', paymentMode: this.payments.name, productionReady: false };
  }
  @Get('runtime') async runtime() {
    return {
      paymentMode: this.payments.name,
      tradingPaused:
        (await this.db.setting.findUnique({ where: { key: 'tradingPaused' } }))?.value === true,
      subscriptionTemplateId: process.env.WX_SUBSCRIBE_TEMPLATE_ID || null,
    };
  }
}

@ApiTags('用户与交易')
@ApiBearerAuth()
@UseGuards(UserGuard)
@Controller('v1')
export class UserController {
  constructor(
    @Inject(Auth) private auth: Auth,
    @Inject(Catalog) private catalog: Catalog,
    @Inject(Trading) private trading: Trading,
    @Inject(Chat) private chat: Chat,
    @Inject(Admin) private admin: Admin,
    @Inject(Storage) private storage: Storage,
    @Inject(Db) private db: Db,
  ) {}
  @Get('me') me(@Req() r: AuthedRequest) {
    return this.catalog.me(r.actor);
  }
  @Get('me/products') mine(@Req() r: AuthedRequest) {
    return this.db.product.findMany({
      where: { sellerId: r.actor.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }
  @Get('me/history') history(@Req() r: AuthedRequest) {
    return this.catalog.history(r.actor);
  }
  @Post('products/:id/visit') visit(@Req() r: AuthedRequest, @Param('id') v: string) {
    return this.catalog.visit(r.actor, parse(id, v));
  }
  @Get('me/products/:id') ownDetail(@Req() r: AuthedRequest, @Param('id') v: string) {
    return this.catalog.detail(parse(id, v), r.actor);
  }
  @Post('verifications') @bodyDoc(z.object({ mediaId: id }).strict()) verify(
    @Req() r: AuthedRequest,
    @Body() b: unknown,
  ) {
    return this.catalog.verification(r.actor, parse(z.object({ mediaId: id }).strict(), b).mediaId);
  }
  @Post('products') @bodyDoc(productInput) create(@Req() r: AuthedRequest, @Body() b: unknown) {
    return this.catalog.create(r.actor, parse(productInput, b));
  }
  @Post('products/:id/edit') @bodyDoc(productInput) edit(
    @Req() r: AuthedRequest,
    @Param('id') v: string,
    @Body() b: unknown,
  ) {
    return this.catalog.edit(r.actor, parse(id, v), parse(productInput, b));
  }
  @Post('products/:id/price') @bodyDoc(z.object({ price: money }).strict()) price(
    @Req() r: AuthedRequest,
    @Param('id') v: string,
    @Body() b: unknown,
  ) {
    return this.catalog.price(
      r.actor,
      parse(id, v),
      parse(z.object({ price: money }).strict(), b).price,
    );
  }
  @Post('products/:id/offline') offline(@Req() r: AuthedRequest, @Param('id') v: string) {
    return this.catalog.offline(r.actor, parse(id, v));
  }
  @Post('orders') @bodyDoc(z.object({ productId: id }).strict()) order(
    @Req() r: AuthedRequest,
    @Body() b: unknown,
  ) {
    return this.trading.create(r.actor, parse(z.object({ productId: id }).strict(), b).productId);
  }
  @Get('orders') orders(
    @Req() r: AuthedRequest,
    @Query('role') role = 'buyer',
    @Query('page') p?: string,
  ) {
    return this.trading.list(r.actor, parse(z.enum(['buyer', 'seller']), role), page(p));
  }
  @Get('orders/:id') detail(@Req() r: AuthedRequest, @Param('id') v: string) {
    return this.trading.detail(r.actor, parse(id, v));
  }
  @Post('orders/:id/pay') intent(@Req() r: AuthedRequest, @Param('id') v: string) {
    return this.trading.intent(r.actor, parse(id, v));
  }
  @Post('orders/:id/mock-pay') mock(@Req() r: AuthedRequest, @Param('id') v: string) {
    return this.trading.mockPay(r.actor, parse(id, v));
  }
  @Post('orders/:id/cancel') cancel(@Req() r: AuthedRequest, @Param('id') v: string) {
    return this.trading.cancel(r.actor, parse(id, v));
  }
  @Post('orders/:id/deliver') deliver(@Req() r: AuthedRequest, @Param('id') v: string) {
    return this.trading.deliver(r.actor, parse(id, v));
  }
  @Post('orders/:id/confirm') confirm(@Req() r: AuthedRequest, @Param('id') v: string) {
    return this.trading.confirm(r.actor, parse(id, v));
  }
  @Post('orders/:id/refunds') @bodyDoc(z.object({ reason: text(1000) }).strict()) refund(
    @Req() r: AuthedRequest,
    @Param('id') v: string,
    @Body() b: unknown,
  ) {
    return this.trading.requestRefund(
      r.actor,
      parse(id, v),
      parse(z.object({ reason: text(1000) }).strict(), b).reason,
    );
  }
  @Post('refunds/:id/return') returned(@Req() r: AuthedRequest, @Param('id') v: string) {
    return this.trading.confirmReturn(r.actor, parse(id, v));
  }
  @Get('me/funds') funds(@Req() r: AuthedRequest) {
    return this.trading.funds(r.actor);
  }
  @Post('conversations') @bodyDoc(z.object({ productId: id }).strict()) conversation(
    @Req() r: AuthedRequest,
    @Body() b: unknown,
  ) {
    return this.chat.start(r.actor, parse(z.object({ productId: id }).strict(), b).productId);
  }
  @Get('conversations') conversations(@Req() r: AuthedRequest) {
    return this.chat.list(r.actor);
  }
  @Get('conversations/:id/messages') messages(
    @Req() r: AuthedRequest,
    @Param('id') v: string,
    @Query('beforeId') beforeId?: string,
  ) {
    return this.chat.messages(r.actor, parse(id, v), beforeId ? parse(id, beforeId) : undefined);
  }
  @Post('orders/:id/conversation') orderConversation(
    @Req() r: AuthedRequest,
    @Param('id') v: string,
  ) {
    return this.chat.orderConversation(r.actor, parse(id, v));
  }
  @Post('conversations/:id/messages') @bodyDoc(message) send(
    @Req() r: AuthedRequest,
    @Param('id') v: string,
    @Body() b: unknown,
  ) {
    const m = parse(message, b);
    return this.chat.send(r.actor, parse(id, v), m.kind, m.body, m.clientId);
  }
  @Post('conversations/:id/read') read(@Req() r: AuthedRequest, @Param('id') v: string) {
    return this.chat.read(r.actor, parse(id, v));
  }
  @Get('notifications') notifications(@Req() r: AuthedRequest) {
    return this.db.notification.findMany({
      where: { userId: r.actor.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }
  @Post('notifications/:id/read') readNote(@Req() r: AuthedRequest, @Param('id') v: string) {
    return this.db.notification.updateMany({
      where: { id: parse(id, v), userId: r.actor.id },
      data: { read: true },
    });
  }
  @Post('subscriptions') @bodyDoc(z.object({ templateId: text(200) }).strict()) async subscription(
    @Req() r: AuthedRequest,
    @Body() b: unknown,
  ) {
    const { templateId } = parse(z.object({ templateId: text(200) }).strict(), b);
    if (templateId !== process.env.WX_SUBSCRIBE_TEMPLATE_ID) throw new Error('订阅模板未配置');
    return this.db.subscription.upsert({
      where: { userId_templateId: { userId: r.actor.id, templateId } },
      create: { userId: r.actor.id, templateId, remaining: 1 },
      update: { remaining: { increment: 1 } },
    });
  }
  @Post('complaints') @bodyDoc(complaint) complain(@Req() r: AuthedRequest, @Body() b: unknown) {
    const c = parse(complaint, b);
    return this.admin.complaint(r.actor, c.orderId, c.content, c.evidence);
  }
  @Get('me/complaints') complaints(@Req() r: AuthedRequest) {
    return this.db.complaint.findMany({
      where: { userId: r.actor.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }
  @Post('media')
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
        purpose: { type: 'string', enum: ['PRODUCT', 'IDENTITY', 'CHAT', 'EVIDENCE'] },
      },
      required: ['file', 'purpose'],
    },
  })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024, files: 1 } }))
  upload(
    @Req() r: AuthedRequest,
    @UploadedFile() file: Express.Multer.File,
    @Body('purpose') purpose: string,
  ) {
    return this.storage.upload(r.actor, file, purpose);
  }
  @Get('media/:id/url') signed(@Req() r: AuthedRequest, @Param('id') v: string) {
    return this.storage.signed(r.actor, parse(id, v));
  }
}

@ApiTags('运营管理')
@ApiBearerAuth()
@UseGuards(UserGuard)
@Controller('v1/admin')
export class AdminController {
  constructor(
    @Inject(Admin) private admin: Admin,
    @Inject(Trading) private trading: Trading,
  ) {}
  @Get('dashboard') dashboard(@Req() r: AuthedRequest) {
    return this.admin.dashboard(r.actor);
  }
  @Get('orders/:id/evidence') evidence(@Req() r: AuthedRequest, @Param('id') v: string) {
    return this.admin.orderEvidence(r.actor, parse(id, v));
  }
  @Get('lists/:entity') list(
    @Req() r: AuthedRequest,
    @Param('entity') entity: string,
    @Query('page') p?: string,
    @Query('status') status?: string,
  ) {
    return this.admin.list(r.actor, entity, page(p), status ? parse(text(30), status) : undefined);
  }
  @Post('verifications/:id/review') @bodyDoc(review) verify(
    @Req() r: AuthedRequest,
    @Param('id') v: string,
    @Body() b: unknown,
  ) {
    const c = parse(review, b);
    return this.admin.verify(r.actor, parse(id, v), c.approve, c.reason);
  }
  @Post('products/:id/review') @bodyDoc(review) product(
    @Req() r: AuthedRequest,
    @Param('id') v: string,
    @Body() b: unknown,
  ) {
    const c = parse(review, b);
    return this.admin.productReview(r.actor, parse(id, v), c.approve, c.reason);
  }
  @Post('products/:id/offline') @bodyDoc(z.object({ reason: text() }).strict()) offline(
    @Req() r: AuthedRequest,
    @Param('id') v: string,
    @Body() b: unknown,
  ) {
    return this.admin.offline(
      r.actor,
      parse(id, v),
      parse(z.object({ reason: text() }).strict(), b).reason,
    );
  }
  @Post('refunds/:id/review') @bodyDoc(refundReview) refund(
    @Req() r: AuthedRequest,
    @Param('id') v: string,
    @Body() b: unknown,
  ) {
    requireAdmin(r.actor);
    const c = parse(refundReview, b);
    return this.trading.reviewRefund(r.actor, parse(id, v), c.approve, c.reason, c.returnRequired);
  }
  @Post('users/:id/ban') @bodyDoc(z.object({ banned: z.boolean(), reason: text() }).strict()) ban(
    @Req() r: AuthedRequest,
    @Param('id') v: string,
    @Body() b: unknown,
  ) {
    const c = parse(z.object({ banned: z.boolean(), reason: text() }).strict(), b);
    return this.admin.ban(r.actor, parse(id, v), c.banned, c.reason);
  }
  @Post('dictionaries') @bodyDoc(dictionary) dictionary(
    @Req() r: AuthedRequest,
    @Body() b: unknown,
  ) {
    return this.admin.dictionary(r.actor, parse(dictionary, b));
  }
  @Post('announcements') @bodyDoc(announcement) announcement(
    @Req() r: AuthedRequest,
    @Body() b: unknown,
  ) {
    return this.admin.announcement(r.actor, parse(announcement, b));
  }
  @Post('complaints/:id/resolve') @bodyDoc(z.object({ resolution: text(2000) }).strict()) resolve(
    @Req() r: AuthedRequest,
    @Param('id') v: string,
    @Body() b: unknown,
  ) {
    return this.admin.resolveComplaint(
      r.actor,
      parse(id, v),
      parse(z.object({ resolution: text(2000) }).strict(), b).resolution,
    );
  }
  @Post('tasks/:id/retry') retry(@Req() r: AuthedRequest, @Param('id') v: string) {
    return this.admin.retry(r.actor, parse(id, v));
  }
  @Post('trading') @bodyDoc(z.object({ paused: z.boolean(), reason: text() }).strict()) pause(
    @Req() r: AuthedRequest,
    @Body() b: unknown,
  ) {
    const c = parse(z.object({ paused: z.boolean(), reason: text() }).strict(), b);
    return this.admin.pause(r.actor, c.paused, c.reason);
  }
  @Post('reconcile') reconcile(@Req() r: AuthedRequest) {
    return this.admin.reconcile(r.actor);
  }
}

@Controller('files')
export class FilesController {
  constructor(@Inject(Storage) private storage: Storage) {}
  @Get('public/:id') async public(@Param('id') v: string, @Res() res: Response) {
    const bytes = await this.storage.get(parse(id, v), false);
    res
      .set({
        'Content-Type': 'image/webp',
        'Cache-Control': 'public, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
      })
      .send(bytes);
  }
  @Get('private/:id') async private(
    @Param('id') v: string,
    @Query('exp') exp: string,
    @Query('sig') sig: string,
    @Res() res: Response,
  ) {
    const bytes = await this.storage.get(
      parse(id, v),
      true,
      parse(z.coerce.number().int(), exp),
      sig,
    );
    res
      .set({
        'Content-Type': 'image/webp',
        'Cache-Control': 'private, no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      })
      .send(bytes);
  }
}
