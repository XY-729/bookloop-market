import { request, Row, yuan, date, statuses, ensureLogin, publicImage } from '../../lib/api';
Page({
  data: { role: 'buyer', orders: [] as Row[], loading: false, page: 1, total: 0 },
  onLoad(options) {
    this.setData({ role: options.role === 'seller' ? 'seller' : 'buyer' });
    wx.setNavigationBarTitle({ title: this.data.role === 'seller' ? '售卖订单' : '我的购买' });
  },
  onShow() {
    void this.load(true);
  },
  async load(reset = false) {
    if (!ensureLogin() || this.data.loading) return;
    this.setData({ loading: true });
    try {
      const p = reset ? 1 : this.data.page;
      const result = await request(`/orders?role=${this.data.role}&page=${p}`);
      const items = result.items.map((x: Row) => ({
        ...x,
        label: statuses[x.status],
        yuan: yuan(x.amount),
        time: date(x.createdAt),
        image: publicImage(x.snapshot.frontMediaId),
      }));
      this.setData({
        orders: reset ? items : [...this.data.orders, ...items],
        total: result.total,
        page: p,
      });
    } catch {
    } finally {
      this.setData({ loading: false });
    }
  },
  onReachBottom() {
    if (!this.data.loading && this.data.orders.length < this.data.total) {
      this.setData({ page: this.data.page + 1 });
      void this.load();
    }
  },
  go(e: WechatMiniprogram.TouchEvent) {
    wx.navigateTo({ url: `/pages/order/index?id=${e.currentTarget.dataset.id}` });
  },
});
