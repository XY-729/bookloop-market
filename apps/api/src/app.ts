import 'reflect-metadata';
import './config';
import {
  Catch,
  ExceptionFilter,
  ArgumentsHost,
  HttpException,
  Logger,
  Module,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { WsAdapter } from '@nestjs/platform-ws';
import { Prisma } from '@prisma/client';
import helmet from 'helmet';
import { Request, Response, NextFunction } from 'express';
import { Db } from './db';
import { Auth, UserGuard } from './auth';
import { Catalog } from './catalog';
import { Trading } from './trading';
import { Chat } from './chat';
import { Admin } from './admin';
import { Storage } from './storage';
import { Events } from './events';
import { PaymentProvider, providerFactory } from './payments';
import { Worker } from './worker';
import { Gateway } from './gateway';
import { PublicController, UserController, AdminController, FilesController } from './controllers';
import { production, validateConfig } from './config';
@Catch()
class Errors implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    let status = 500,
      message = '服务暂时不可用，请稍后重试';
    if (error instanceof HttpException) {
      status = error.getStatus();
      const response = error.getResponse();
      message = typeof response === 'string' ? response : (response as { message: string }).message;
    } else if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2025') {
        status = 404;
        message = '记录不存在';
      } else if (error.code === 'P2002') {
        status = 409;
        message = '记录已存在或请求冲突，请刷新重试';
      }
    }
    if (status === 500)
      new Logger('API').error(error instanceof Error ? error.stack : String(error));
    res.status(status).json({ statusCode: status, message });
  }
}
@Module({
  controllers: [PublicController, UserController, AdminController, FilesController],
  providers: [
    Db,
    Auth,
    UserGuard,
    Catalog,
    Trading,
    Chat,
    Admin,
    Storage,
    Events,
    Worker,
    Gateway,
    { provide: PaymentProvider, useFactory: providerFactory, inject: [Db] },
  ],
})
export class AppModule {}
export async function createApp() {
  validateConfig();
  const app = await NestFactory.create(AppModule, {
    rawBody: true,
    logger: process.env.NODE_ENV === 'test' ? false : undefined,
  });
  app.use(helmet({ contentSecurityPolicy: production ? undefined : false }));
  app.enableCors({ origin: process.env.ADMIN_ORIGIN || 'http://localhost:5173' });
  app.useGlobalFilters(new Errors());
  app.useWebSocketAdapter(new WsAdapter(app));
  const limits = new Map<string, { n: number; reset: number }>();
  const sweep = setInterval(() => {
    for (const [key, value] of limits) if (value.reset < Date.now()) limits.delete(key);
  }, 60000);
  sweep.unref();
  app.use((req: Request, res: Response, next: NextFunction) => {
    const key = `${req.socket.remoteAddress}:${req.path.startsWith('/v1/auth') ? 'auth' : 'api'}`;
    const now = Date.now();
    let entry = limits.get(key);
    if (!entry || entry.reset < now) {
      entry = { n: 0, reset: now + 60000 };
      limits.set(key, entry);
    }
    entry.n++;
    if (process.env.NODE_ENV !== 'test' && entry.n > (req.path.startsWith('/v1/auth') ? 20 : 300)) {
      res.set('Retry-After', String(Math.ceil((entry.reset - now) / 1000)));
      res.status(429).json({ statusCode: 429, message: '请求过于频繁，请稍后再试' });
      return;
    }
    next();
  });
  const doc = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('BookLoop 教材 API')
      .setDescription('金额为整数分；模拟支付仅用于开发。所有写入均由服务器校验身份与归属。')
      .setVersion('0.1.0')
      .addBearerAuth()
      .build(),
  );
  if (!production)
    SwaggerModule.setup('v1/docs', app, doc, { jsonDocumentUrl: '/v1/openapi.json' });
  app.enableShutdownHooks();
  return app;
}
