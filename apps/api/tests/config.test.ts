import { afterEach, describe, expect, it, vi } from 'vitest';
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});
async function productionConfig() {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('PAYMENT_PROVIDER', 'wechat-platform');
  vi.stubEnv('PAYMENT_CAPABILITIES_VERIFIED', 'true');
  vi.stubEnv('DEV_LOGIN_ENABLED', 'false');
  vi.stubEnv('JWT_SECRET', 'prod-test-secret-at-least-32-characters');
  vi.stubEnv('MEDIA_SIGNING_SECRET', 'prod-media-secret-at-least-32-characters');
  vi.stubEnv('WX_APP_ID', 'test-app-id');
  vi.stubEnv('WX_APP_SECRET', 'test-app-secret');
  vi.stubEnv('STORAGE_DRIVER', 's3');
  vi.stubEnv('PUBLIC_API_URL', 'https://api.example.test');
  vi.stubEnv('ADMIN_ORIGIN', 'https://admin.example.test');
  vi.resetModules();
  return import('../src/config');
}
describe('生产上线门槛', () => {
  it('拒绝模拟资金渠道', async () => {
    const config = await productionConfig();
    vi.stubEnv('PAYMENT_PROVIDER', 'mock');
    expect(() => config.validateConfig()).toThrow('verified platform payment');
  });
  it('拒绝开启开发登录', async () => {
    const config = await productionConfig();
    vi.stubEnv('DEV_LOGIN_ENABLED', 'true');
    expect(() => config.validateConfig()).toThrow('Development login');
  });
  it('拒绝未核验支付能力', async () => {
    const config = await productionConfig();
    vi.stubEnv('PAYMENT_CAPABILITIES_VERIFIED', 'false');
    expect(() => config.validateConfig()).toThrow('verified platform payment');
  });
  it('拒绝开发密钥和非 HTTPS 域名', async () => {
    const config = await productionConfig();
    vi.stubEnv('PUBLIC_API_URL', 'http://api.example.test');
    expect(() => config.validateConfig()).toThrow('HTTPS');
    vi.stubEnv('PUBLIC_API_URL', 'https://api.example.test');
    vi.stubEnv('JWT_SECRET', 'local-only-secret-with-at-least-32-characters');
    expect(() => config.validateConfig()).toThrow('Replace development secrets');
  });
});
