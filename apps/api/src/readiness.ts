import { Injectable } from '@nestjs/common';
export type ReleaseCheck = {
  id: string;
  label: string;
  status: 'PASS' | 'BLOCKED' | 'PENDING';
  detail: string;
};
export function releaseChecks(env: NodeJS.ProcessEnv = process.env): ReleaseCheck[] {
  const check = (id: string, label: string, ok: boolean, detail: string): ReleaseCheck => ({
    id,
    label,
    status: ok ? 'PASS' : 'BLOCKED',
    detail: ok ? '配置已提供；仍需按上线验收清单验证实际效果' : detail,
  });
  return [
    check(
      'account',
      '正式小程序账号',
      /^wx[a-zA-Z0-9]{16}$/.test(env.WX_APP_ID || '') && !!env.WX_APP_SECRET,
      '需要正式 AppID 和 AppSecret',
    ),
    check(
      'operator',
      '运营主体与联系方式',
      !!env.OPERATOR_NAME && !!env.SUPPORT_CONTACT,
      '需要实际运营主体名称和有效客服联系方式',
    ),
    check(
      'legal',
      '隐私及业务文本确认',
      env.LEGAL_APPROVED === 'true',
      '运营方须确认隐私政策、保存期限和用户协议',
    ),
    check(
      'registration',
      '主体、类目与备案',
      env.ACCOUNT_COMPLIANCE_VERIFIED === 'true',
      '完成账号认证、正确类目资质及备案后记录验收结果',
    ),
    check(
      'api',
      'HTTPS 与合法域名',
      /^https:\/\//.test(env.PUBLIC_API_URL || '') && /^https:\/\//.test(env.ADMIN_ORIGIN || ''),
      '需要生产 HTTPS 域名并配置微信合法域名',
    ),
    check(
      'storage',
      '私有对象存储',
      env.STORAGE_DRIVER === 's3' &&
        !!env.S3_PUBLIC_BUCKET &&
        !!env.S3_PRIVATE_BUCKET &&
        env.S3_PUBLIC_BUCKET !== env.S3_PRIVATE_BUCKET &&
        !!env.S3_ACCESS_KEY_ID &&
        !!env.S3_SECRET_ACCESS_KEY,
      '配置独立的媒体桶与权限，两桶都禁止直接匿名读取，由服务按审核及访问权限提供图片',
    ),
    check(
      'safety',
      '内容安全与加密回调',
      env.WX_CONTENT_SAFETY === 'wechat' &&
        !!env.WX_MESSAGE_TOKEN &&
        /^[a-zA-Z0-9+/]{43}$/.test(env.WX_ENCODING_AES_KEY || ''),
      '接入微信文字／图片安全检测，配置 JSON 加密消息推送并验证回调',
    ),
    check(
      'shipping',
      '交易订单发货同步',
      env.WX_ORDER_SYNC === 'wechat' && env.WX_SHIPPING_VERIFIED === 'true',
      '联调订单发货管理，确认实际支付产品的交易单号映射',
    ),
    check(
      'production',
      '生产模式与密钥',
      env.NODE_ENV === 'production' &&
        env.DEV_LOGIN_ENABLED !== 'true' &&
        (env.JWT_SECRET?.length || 0) >= 32 &&
        (env.MEDIA_SIGNING_SECRET?.length || 0) >= 32 &&
        !env.JWT_SECRET?.includes('local-only') &&
        !env.MEDIA_SIGNING_SECRET?.includes('local-only'),
      '关闭开发登录并替换开发密钥',
    ),
    {
      id: 'payments',
      label: '真实平台支付与卖家结算',
      status: 'BLOCKED',
      detail: '当前仓库尚无获准支付产品的真实适配器；修改环境变量不能完成接入',
    },
    {
      id: 'device',
      label: '微信开发者工具与真机验收',
      status: 'PENDING',
      detail: '须提供真实 iOS／Android 测试记录，代码构建不代表真机验收',
    },
    {
      id: 'operations',
      label: '生产部署、备份与恢复',
      status: 'PENDING',
      detail: '在实际部署环境执行并记录恢复演练、监控及资金对账',
    },
  ];
}
@Injectable()
export class Readiness {
  report() {
    const checks = releaseChecks();
    return { ready: checks.every((x) => x.status === 'PASS'), checkedAt: new Date(), checks };
  }
}
