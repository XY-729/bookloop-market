import { request, Row } from '../../lib/api';
Page({
  data: { kind: 'privacy', document: null as Row | null, error: '' },
  onLoad(options) {
    this.setData({ kind: options.kind === 'terms' ? 'terms' : 'privacy' });
    wx.setNavigationBarTitle({ title: this.data.kind === 'terms' ? '用户协议' : '隐私政策' });
    void this.load();
  },
  async load() {
    try {
      this.setData({ document: await request('/legal'), error: '' });
    } catch (e) {
      this.setData({ error: (e as Error).message });
    }
  },
});
