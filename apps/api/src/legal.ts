import { ConflictException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { Db } from './db';
export const LEGAL_VERSION = '2026-10-09';
@Injectable()
export class Legal {
  constructor(@Inject(Db) private db: Db) {}
  versions() {
    return {
      privacy: process.env.PRIVACY_VERSION || LEGAL_VERSION,
      terms: process.env.TERMS_VERSION || LEGAL_VERSION,
    };
  }
  documents() {
    const configured = !!process.env.OPERATOR_NAME && !!process.env.SUPPORT_CONTACT;
    const operator = process.env.OPERATOR_NAME || 'BookLoop 内部测试运营方';
    const contact = process.env.SUPPORT_CONTACT || '正式运营联系方式尚未配置';
    return {
      operator,
      contact,
      configured,
      versions: this.versions(),
      privacy: [
        {
          title: '收集与使用',
          body: '为提供账号、教材发布、聊天和交易服务，我们处理微信提供的用户标识、昵称、教材描述和图片、聊天记录、订单及资金操作记录。上传图片前由你主动选择相册或拍摄，不读取全部相册。',
        },
        {
          title: '认证材料',
          body: '认证材料只用于人工审核。请遮挡完整证件编号等无关信息，不提交超出审核要求的资料。材料保存在私有存储，仅授权审核人员可查看，审核结束 7 天后删除原始图片，保留审核结果与操作记录。',
        },
        {
          title: '服务提供方',
          body: '正式微信登录、订阅消息和内容安全检查使用微信提供的服务。公开发布及聊天的文字与图片会提交微信进行内容安全检测；认证证明图片不提交此内容检测服务。订单发货信息和付款人微信标识按交易管理要求同步至微信。真实资金服务启用后由获准的支付渠道处理。',
        },
        {
          title: '存储与访问',
          body: '教材图片审核通过后可公开展示。聊天图片和投诉证据按参与者及授权人员权限访问。账号、订单与必要审计记录按运营及适用规定保存；正式上线前由运营方明确具体保存期限并公示。',
        },
        {
          title: '你的选择与联系',
          body: `你可以拒绝上传图片或订阅消息，仍可浏览公开教材。可通过“我的”撤回平台协议同意，撤回后停止新的发布和交易，已有订单的退款、交付与投诉入口继续保留。访问、更正或删除资料的请求请联系：${contact}。`,
        },
      ],
      terms: [
        {
          title: '平台与适用范围',
          body: `本服务由 ${operator} 提供，用于二手学习教材的信息展示、沟通与交易。当前模拟资金环境仅供测试，不发生真实收付款。`,
        },
        {
          title: '商品与交付',
          body: '发布者应如实描述版本、成色与笔记，上传真实正反面照片，并保证有权出售教材。双方通过聊天约定线下交付地点和时间，禁止发布违法、侵权或与教材交易无关的内容。',
        },
        {
          title: '交易规则',
          body: '订单创建后锁定教材及价格，15 分钟未付款自动取消。真实付款成功后 72 小时内需交付，超时发起全额退款；买家确认收货，或付款满 7 天且已交付、无退款或纠纷时，进入结算流程。',
        },
        {
          title: '退款与投诉',
          body: '结算前支持整单退款审核，需要退书时先核实退书。申请退款或待处理纠纷暂停结算。结算已发起或完成后的争议由运营人员协调，平台不承诺自动扣回卖家资金。',
        },
        {
          title: '费用与资金',
          body: '试运营平台手续费为 0，订单记录展示实际金额及费用。资金页面仅展示渠道处理状态，不提供充值、余额消费或自主提现。只有渠道明确确认成功才显示退款或结算完成。',
        },
        {
          title: '联系与运营确认',
          body: `服务与投诉联系方式：${contact}。正式上线前运营方须补齐主体、联系方式、保存期限及适用的业务条款；当前模板不能替代运营方对正式文本的确认。`,
        },
      ],
    };
  }
  async status(userId: string) {
    const row = await this.db.setting.findUnique({ where: { key: `consent:${userId}` } });
    const value = row?.value as
      { privacy?: string; terms?: string; acceptedAt?: string; revokedAt?: string } | undefined;
    const versions = this.versions();
    return {
      accepted:
        !!value?.acceptedAt &&
        !value.revokedAt &&
        value.privacy === versions.privacy &&
        value.terms === versions.terms,
      acceptedAt: value?.acceptedAt || null,
      revokedAt: value?.revokedAt || null,
      versions,
    };
  }
  async accept(userId: string, versions: { privacy: string; terms: string }) {
    const current = this.versions();
    if (versions.privacy !== current.privacy || versions.terms !== current.terms)
      throw new ConflictException('协议已更新，请重新阅读并确认');
    return this.db.atomic(async (tx) => {
      const value = { ...current, acceptedAt: new Date().toISOString() };
      await tx.setting.upsert({
        where: { key: `consent:${userId}` },
        create: { key: `consent:${userId}`, value },
        update: { value },
      });
      await tx.audit.create({
        data: { actorId: userId, action: 'LEGAL_CONSENT', targetId: userId, details: value },
      });
      return { accepted: true, ...value };
    });
  }
  async revoke(userId: string) {
    return this.db.atomic(async (tx) => {
      const row = await tx.setting.findUnique({ where: { key: `consent:${userId}` } });
      const value = {
        ...((row?.value as Record<string, string>) || {}),
        revokedAt: new Date().toISOString(),
      };
      await tx.setting.upsert({
        where: { key: `consent:${userId}` },
        create: { key: `consent:${userId}`, value },
        update: { value },
      });
      await tx.audit.create({
        data: {
          actorId: userId,
          action: 'LEGAL_CONSENT_REVOKE',
          targetId: userId,
          details: { revokedAt: value.revokedAt },
        },
      });
      return { accepted: false };
    });
  }
  async ensure(userId: string) {
    if (!(await this.status(userId)).accepted)
      throw new ForbiddenException({
        message: '请先阅读并同意隐私政策与用户协议',
        code: 'CONSENT_REQUIRED',
      });
  }
}
