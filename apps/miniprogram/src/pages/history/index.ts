import { request, Row, yuan, ensureLogin } from '../../lib/api';
Page({
  data: { items: [] as Row[] },
  onShow() {
    void this.load();
  },
  async load() {
    if (!ensureLogin()) return;
    try {
      this.setData({
        items: (await request<Row[]>('/me/history')).map((x) => ({ ...x, yuan: yuan(x.price) })),
      });
    } catch {}
  },
  detail(e: WechatMiniprogram.TouchEvent) {
    wx.navigateTo({ url: `/pages/detail/index?id=${e.currentTarget.dataset.id}` });
  },
});
