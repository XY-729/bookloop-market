import { request, login, token, Row, confirm } from '../../lib/api';
import { DEV_LOGIN_ENABLED } from '../../config';
Page({
  data: {
    me: null as Row | null,
    dev: DEV_LOGIN_ENABLED,
    busy: false,
    accepted: false,
    legal: null as Row | null,
  },
  onShow() {
    void this.load();
  },
  async load() {
    try {
      this.setData({ legal: await request('/legal') });
    } catch {}
    if (!token()) {
      this.setData({ me: null });
      return;
    }
    try {
      const me = await request('/me');
      wx.setStorageSync('market-user', me);
      this.setData({ me, accepted: me.consent?.accepted === true });
    } catch {
      this.setData({ me: null });
    }
  },
  async login() {
    if (this.data.busy) return;
    if (!this.data.accepted || !this.data.legal) {
      wx.showToast({ title: '请先阅读并同意协议', icon: 'none' });
      return;
    }
    this.setData({ busy: true });
    try {
      await login('buyer', this.data.legal.versions);
      await this.load();
    } catch {
    } finally {
      this.setData({ busy: false });
    }
  },
  async seller() {
    if (!this.data.accepted || !this.data.legal) {
      wx.showToast({ title: '请先阅读并同意协议', icon: 'none' });
      return;
    }
    try {
      await login('seller', this.data.legal.versions);
      await this.load();
    } catch {}
  },
  logout() {
    wx.removeStorageSync('market-token');
    wx.removeStorageSync('market-user');
    this.setData({ me: null, accepted: false });
  },
  policyChange(e: WechatMiniprogram.CheckboxGroupChange) {
    this.setData({ accepted: e.detail.value.includes('agree') });
  },
  policy(e: WechatMiniprogram.TouchEvent) {
    wx.navigateTo({ url: `/pages/legal/index?kind=${e.currentTarget.dataset.kind}` });
  },
  async accept() {
    if (!this.data.accepted || !this.data.legal) return;
    this.setData({ busy: true });
    try {
      await request('/me/consent', 'POST', { ...this.data.legal.versions, agree: true });
      await this.load();
    } catch {
    } finally {
      this.setData({ busy: false });
    }
  },
  async revoke() {
    if (
      !(await confirm(
        '撤回同意',
        '撤回后停止新发布、聊天和付款，已有订单的售后继续保留。确认撤回？',
      ))
    )
      return;
    try {
      await request('/me/consent/revoke', 'POST');
      await this.load();
    } catch {}
  },
  go(e: WechatMiniprogram.TouchEvent) {
    if (!this.data.me) {
      void this.login();
      return;
    }
    wx.navigateTo({
      url: `/pages/${e.currentTarget.dataset.page}/index${e.currentTarget.dataset.query || ''}`,
    });
  },
});
