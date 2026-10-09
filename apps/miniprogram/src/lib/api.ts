import { API_BASE_URL, DEV_LOGIN_ENABLED, DEV_LOGIN_SECRET } from '../config';
import { authorizePrivacy } from './privacy';
export type Row = Record<string, any>;
export function token(): string {
  return wx.getStorageSync('market-token') || '';
}
export function user(): Row {
  return wx.getStorageSync('market-user') || {};
}
export function yuan(value: number) {
  return ((value || 0) / 100).toFixed(2);
}
export function date(value: string) {
  if (!value) return '—';
  const d = new Date(value);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
export const statuses: Record<string, string> = {
  PENDING: '待审核',
  ACTIVE: '在售',
  APPROVED: '审核通过',
  REJECTED: '审核未通过',
  OFFLINE: '已下架',
  RESERVED: '待付款锁定',
  SOLD: '已售出',
  UNPAID: '待付款',
  PAID: '待交付',
  DELIVERED: '待收货',
  CANCELLED: '已取消',
  REFUND_REQUESTED: '退款审核中',
  WAIT_RETURN: '待退书',
  REFUNDING: '退款处理中',
  REFUNDED: '已退款',
  LATE_PAYMENT_REFUNDING: '迟到支付退款中',
  SETTLING: '结算处理中',
  SETTLED: '已结算',
  REQUESTED: '待审核',
  PROCESSING: '处理中',
  SUCCEEDED: '已完成',
  OPEN: '待处理',
  RESOLVED: '已处理',
};
export function request<T = Row>(
  path: string,
  method: 'GET' | 'POST' = 'GET',
  data?: unknown,
): Promise<T> {
  return new Promise((resolve, reject) =>
    wx.request({
      url: `${API_BASE_URL}/v1${path}`,
      method,
      data: data as Record<string, unknown>,
      header: { Authorization: `Bearer ${token()}` },
      success(result) {
        if (result.statusCode >= 200 && result.statusCode < 300) {
          resolve(result.data as T);
          return;
        }
        const message = (result.data as Row)?.message || '请求失败';
        if ((result.data as Row)?.code === 'CONSENT_REQUIRED')
          wx.switchTab({ url: '/pages/profile/index' });
        if (result.statusCode === 401) {
          wx.removeStorageSync('market-token');
          wx.removeStorageSync('market-user');
        }
        wx.showToast({ title: String(message), icon: 'none' });
        reject(new Error(String(message)));
      },
      fail() {
        wx.showToast({ title: '网络连接失败，请稍后重试', icon: 'none' });
        reject(new Error('网络连接失败'));
      },
    }),
  );
}
export async function login(devIdentity = 'buyer', versions?: { privacy: string; terms: string }) {
  let result: Row;
  if (DEV_LOGIN_ENABLED) {
    result = await request('/auth/dev', 'POST', {
      openid: devIdentity,
      nickname: devIdentity === 'seller' ? '模拟卖家' : '模拟买家',
      key: DEV_LOGIN_SECRET,
    });
  } else {
    const code = await new Promise<string>((resolve, reject) =>
      wx.login({
        success: (r) => (r.code ? resolve(r.code) : reject(new Error('微信登录失败'))),
        fail: reject,
      }),
    );
    result = await request('/auth/wechat', 'POST', { code, nickname: '教材用户' });
  }
  wx.setStorageSync('market-token', result.token);
  wx.setStorageSync('market-user', result.user);
  if (versions) await request('/me/consent', 'POST', { ...versions, agree: true });
  return result.user;
}
export function ensureLogin() {
  if (token()) return true;
  wx.showToast({ title: '请先登录并完成用户认证', icon: 'none' });
  wx.switchTab({ url: '/pages/profile/index' });
  return false;
}
export async function upload(purpose: string): Promise<Row> {
  await authorizePrivacy();
  const uploaded = await chooseUpload(purpose);
  if (uploaded.reviewState !== 'PENDING') return uploaded;
  wx.showLoading({ title: '图片内容审核中', mask: true });
  try {
    for (let n = 0; n < 15; n++) {
      await new Promise((r) => setTimeout(r, 2000));
      const state = await request(`/media/${uploaded.id}/status`);
      if (state.reviewState === 'APPROVED') return { ...uploaded, ...state };
      if (['FAILED', 'REJECTED'].includes(state.reviewState))
        throw new Error('图片未通过审核，请更换或稍后重试');
    }
    throw new Error('审核尚未完成，请稍后重试');
  } catch (e) {
    wx.showToast({ title: (e as Error).message, icon: 'none' });
    throw e;
  } finally {
    wx.hideLoading();
  }
}
function chooseUpload(purpose: string): Promise<Row> {
  return new Promise((resolve, reject) =>
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success(result) {
        const file = result.tempFiles[0];
        if (file.size > 5 * 1024 * 1024) {
          wx.showToast({ title: '请选择 5MB 以内的图片', icon: 'none' });
          reject(new Error('图片过大'));
          return;
        }
        wx.uploadFile({
          url: `${API_BASE_URL}/v1/media`,
          filePath: file.tempFilePath,
          name: 'file',
          formData: { purpose },
          header: { Authorization: `Bearer ${token()}` },
          success(r) {
            let data: Row;
            try {
              data = JSON.parse(r.data);
            } catch {
              wx.showToast({ title: '服务连接中断，请重新上传', icon: 'none' });
              reject(new Error('上传响应无效'));
              return;
            }
            if (r.statusCode >= 200 && r.statusCode < 300)
              resolve({ ...data, preview: file.tempFilePath });
            else {
              wx.showToast({ title: data.message || '上传失败', icon: 'none' });
              reject(new Error(data.message));
            }
          },
          fail() {
            wx.showToast({ title: '图片上传失败，请重试', icon: 'none' });
            reject(new Error('上传失败'));
          },
        });
      },
      fail: reject,
    }),
  );
}
export function confirm(title: string, content: string) {
  return new Promise<boolean>((resolve) =>
    wx.showModal({
      title,
      content,
      success: (r) => resolve(r.confirm),
      fail: () => resolve(false),
    }),
  );
}
export async function subscribe() {
  const config = await request('/runtime');
  if (!config.subscriptionTemplateId) return;
  const templateId = config.subscriptionTemplateId;
  await new Promise<void>((resolve) =>
    wx.requestSubscribeMessage({
      tmplIds: [templateId],
      success: (r) => {
        if (r[templateId] === 'accept')
          void request('/subscriptions', 'POST', { templateId }).then(
            () => resolve(),
            () => resolve(),
          );
        else resolve();
      },
      fail: () => resolve(),
    }),
  );
}
export function publicImage(id: string) {
  return `${API_BASE_URL}/files/public/${id}`;
}
export async function signedImage(id: string) {
  return (await request(`/media/${id}/url`)).url as string;
}
