import { config } from 'dotenv';
import { resolve } from 'node:path';
config({ path: resolve(process.cwd(), '../../.env'), quiet: true });
config({ quiet: true });
export const production = process.env.NODE_ENV === 'production';
export function secret(name: string) {
  const value = process.env[name];
  if (!value || value.length < 32) throw new Error(`${name} must contain at least 32 characters`);
  return value;
}
export function validateConfig() {
  secret('JWT_SECRET');
  secret('MEDIA_SIGNING_SECRET');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  if (production) {
    if (
      process.env.PAYMENT_PROVIDER !== 'wechat-platform' ||
      process.env.PAYMENT_CAPABILITIES_VERIFIED !== 'true'
    )
      throw new Error('Production requires verified platform payment capabilities');
    if (process.env.DEV_LOGIN_ENABLED === 'true')
      throw new Error('Development login cannot be enabled in production');
    if (!process.env.WX_APP_ID || !process.env.WX_APP_SECRET)
      throw new Error('WeChat credentials are required');
    if (process.env.STORAGE_DRIVER !== 's3') throw new Error('Production requires object storage');
    if (
      !process.env.ADMIN_ORIGIN?.startsWith('https://') ||
      !process.env.PUBLIC_API_URL?.startsWith('https://')
    )
      throw new Error('Production requires HTTPS origins');
    if (
      secret('JWT_SECRET').includes('local-only') ||
      secret('MEDIA_SIGNING_SECRET').includes('local-only')
    )
      throw new Error('Replace development secrets');
    if (!/^wx[a-zA-Z0-9]{16}$/.test(process.env.WX_APP_ID))
      throw new Error('A real WeChat AppID is required');
    if (
      !process.env.OPERATOR_NAME ||
      !process.env.SUPPORT_CONTACT ||
      process.env.LEGAL_APPROVED !== 'true'
    )
      throw new Error('Reviewed legal documents and operator contact are required');
    if (process.env.ACCOUNT_COMPLIANCE_VERIFIED !== 'true')
      throw new Error('Account category and registration must be verified');
    if (
      process.env.WX_CONTENT_SAFETY !== 'wechat' ||
      !process.env.WX_MESSAGE_TOKEN ||
      !/^[a-zA-Z0-9+/]{43}$/.test(process.env.WX_ENCODING_AES_KEY || '')
    )
      throw new Error('WeChat content safety and encrypted callbacks are required');
    if (process.env.WX_ORDER_SYNC !== 'wechat' || process.env.WX_SHIPPING_VERIFIED !== 'true')
      throw new Error('WeChat shipping management must be verified');
    if (
      !process.env.S3_PUBLIC_BUCKET ||
      !process.env.S3_PRIVATE_BUCKET ||
      process.env.S3_PUBLIC_BUCKET === process.env.S3_PRIVATE_BUCKET ||
      !process.env.S3_ACCESS_KEY_ID ||
      !process.env.S3_SECRET_ACCESS_KEY
    )
      throw new Error('Separate object storage buckets and credentials are required');
  }
}
