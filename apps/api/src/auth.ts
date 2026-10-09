import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { sign, verify } from 'jsonwebtoken';
import { compare } from 'bcryptjs';
import { Db } from './db';
import { Legal } from './legal';
import { production, secret } from './config';
import type { Request } from 'express';
export type Actor = {
  id: string;
  nickname: string;
  role: string;
  verified: boolean;
  banned: boolean;
  openid: string;
};
export type AuthedRequest = Request & { actor: Actor };
@Injectable()
export class Auth {
  constructor(@Inject(Db) private db: Db) {}
  token(user: Actor) {
    return {
      token: sign({ sub: user.id }, secret('JWT_SECRET'), {
        expiresIn: '12h',
        algorithm: 'HS256',
        issuer: 'bookloop-market',
        audience: 'market-clients',
      }),
      user: this.publicUser(user),
    };
  }
  publicUser(user: Actor) {
    return {
      id: user.id,
      nickname: user.nickname,
      role: user.role,
      verified: user.verified,
      banned: user.banned,
    };
  }
  async actor(token: string): Promise<Actor> {
    try {
      const payload = verify(token, secret('JWT_SECRET'), {
        algorithms: ['HS256'],
        issuer: 'bookloop-market',
        audience: 'market-clients',
      });
      if (typeof payload === 'string' || !payload.sub) throw new Error();
      const user = await this.db.user.findUnique({ where: { id: payload.sub } });
      if (!user) throw new Error();
      if (user.banned) throw new ForbiddenException('账号已被封禁');
      return user;
    } catch (e) {
      if (e instanceof ForbiddenException) throw e;
      throw new UnauthorizedException('请重新登录');
    }
  }
  async login(code: string, nickname: string) {
    const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
    url.search = new URLSearchParams({
      appid: process.env.WX_APP_ID || '',
      secret: process.env.WX_APP_SECRET || '',
      js_code: code,
      grant_type: 'authorization_code',
    }).toString();
    const data = (await (await fetch(url, { signal: AbortSignal.timeout(10000) })).json()) as {
      openid?: string;
      errcode?: number;
    };
    if (!data.openid || data.errcode) throw new UnauthorizedException('微信登录失败');
    const user = await this.db.user.upsert({
      where: { openid: data.openid },
      create: { openid: data.openid, nickname },
      update: {},
    });
    if (user.banned) throw new ForbiddenException('账号已被封禁');
    return this.token(user);
  }
  async devLogin(openid: string, nickname: string, key: string) {
    if (
      production ||
      process.env.DEV_LOGIN_ENABLED !== 'true' ||
      !process.env.DEV_LOGIN_SECRET ||
      key !== process.env.DEV_LOGIN_SECRET
    )
      throw new ForbiddenException('开发登录未开放');
    const user = await this.db.user.upsert({
      where: { openid: `dev:${openid}` },
      create: { openid: `dev:${openid}`, nickname },
      update: {},
    });
    if (user.role !== 'USER' || user.banned) throw new ForbiddenException('账号不可用');
    return this.token(user);
  }
  async adminLogin(username: string, password: string) {
    const user = await this.db.user.findUnique({ where: { openid: `admin:${username}` } });
    if (
      !user?.passwordHash ||
      user.role !== 'ADMIN' ||
      user.banned ||
      !(await compare(password, user.passwordHash))
    )
      throw new UnauthorizedException('账号或密码错误');
    return this.token(user);
  }
}
@Injectable()
export class UserGuard implements CanActivate {
  constructor(
    @Inject(Auth) private auth: Auth,
    @Inject(Legal) private legal: Legal,
  ) {}
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const token = req.headers.authorization?.replace(/^Bearer /, '');
    if (!token) throw new UnauthorizedException('请先登录');
    req.actor = await this.auth.actor(token);
    const newContent =
      /^\/v1\/(products(?:\/[^/]+\/(?:edit|price))?|orders(?:\/[^/]+\/(?:pay|mock-pay))?|media|conversations(?:\/[^/]+\/messages)?)\/?$/.test(
        req.path,
      );
    if (req.actor.role !== 'ADMIN' && req.method !== 'GET' && newContent)
      await this.legal.ensure(req.actor.id);
    return true;
  }
}
export function requireVerified(actor: Actor) {
  if (!actor.verified || actor.banned) throw new ForbiddenException('请先通过用户认证审核');
}
export function requireAdmin(actor: Actor) {
  if (actor.role !== 'ADMIN') throw new ForbiddenException('需要管理员权限');
}
