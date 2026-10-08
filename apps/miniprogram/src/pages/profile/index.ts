import { request, login, token, Row } from '../../lib/api';
import { DEV_LOGIN_ENABLED } from '../../config';
Page({
  data: { me: null as Row | null, dev: DEV_LOGIN_ENABLED, busy: false },
  onShow() {
    void this.load();
  },
  async load() {
    if (!token()) {
      this.setData({ me: null });
      return;
    }
    try {
      const me = await request('/me');
      wx.setStorageSync('market-user', me);
      this.setData({ me });
    } catch {
      this.setData({ me: null });
    }
  },
  async login() {
    if (this.data.busy) return;
    this.setData({ busy: true });
    try {
      await login('buyer');
      await this.load();
    } catch {
    } finally {
      this.setData({ busy: false });
    }
  },
  async seller() {
    try {
      await login('seller');
      await this.load();
    } catch {}
  },
  logout() {
    wx.removeStorageSync('market-token');
    wx.removeStorageSync('market-user');
    this.setData({ me: null });
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
