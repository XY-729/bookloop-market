import { Injectable, ServiceUnavailableException } from '@nestjs/common';
type WxResult = Record<string, any>;
@Injectable()
export class WechatClient {
  private cached?: { token: string; expiresAt: number };
  private pending?: Promise<string>;
  private async fetchJson(url: string, body: unknown): Promise<WxResult> {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(12000),
      });
    } catch {
      throw new ServiceUnavailableException('微信服务连接失败，请稍后重试');
    }
    if (!response.ok) throw new ServiceUnavailableException('微信服务暂时不可用');
    const result = await response.json().catch(() => {
      throw new ServiceUnavailableException('微信服务返回格式无效');
    });
    if (!result || typeof result !== 'object' || Array.isArray(result))
      throw new ServiceUnavailableException('微信服务返回格式无效');
    return result as WxResult;
  }
  async token(force = false): Promise<string> {
    if (!force && this.cached && this.cached.expiresAt > Date.now()) return this.cached.token;
    if (this.pending) return this.pending;
    this.pending = (async () => {
      if (!process.env.WX_APP_ID || !process.env.WX_APP_SECRET)
        throw new ServiceUnavailableException('微信账号尚未配置');
      const result = await this.fetchJson('https://api.weixin.qq.com/cgi-bin/stable_token', {
        grant_type: 'client_credential',
        appid: process.env.WX_APP_ID,
        secret: process.env.WX_APP_SECRET,
        force_refresh: force,
      });
      if (
        result.errcode ||
        typeof result.access_token !== 'string' ||
        !Number.isFinite(result.expires_in)
      )
        throw new ServiceUnavailableException(`微信凭证获取失败（${result.errcode || 'invalid'}）`);
      this.cached = {
        token: result.access_token,
        expiresAt: Date.now() + Math.max(0, result.expires_in - 120) * 1000,
      };
      return result.access_token;
    })();
    try {
      return await this.pending;
    } finally {
      this.pending = undefined;
    }
  }
  async post(path: string, body: unknown): Promise<WxResult> {
    // Paths are supplied only by our service code; no user-controlled URL is accepted.
    if (!/^\/[a-zA-Z0-9_/-]+$/.test(path)) throw new Error('Invalid internal WeChat endpoint');
    let token = await this.token();
    let result = await this.fetchJson(
      `https://api.weixin.qq.com${path}?access_token=${encodeURIComponent(token)}`,
      body,
    );
    if ([40001, 40014, 42001].includes(result.errcode)) {
      this.cached = undefined;
      token = await this.token(true);
      result = await this.fetchJson(
        `https://api.weixin.qq.com${path}?access_token=${encodeURIComponent(token)}`,
        body,
      );
    }
    return result;
  }
}
