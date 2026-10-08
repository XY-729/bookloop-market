import { request, Row, yuan } from '../../lib/api';
Page({
  data: {
    products: [] as Row[],
    categories: [] as Row[],
    announcements: [] as Row[],
    q: '',
    categoryId: '',
    page: 1,
    total: 0,
    loading: false,
    error: '',
    paused: false,
    mode: '',
  },
  onLoad() {
    void this.init();
  },
  onShow() {
    void this.load(true);
  },
  async init() {
    try {
      const [dict, announcements, runtime] = await Promise.all([
        request<Row[]>('/dictionaries'),
        request<Row[]>('/announcements'),
        request('/runtime'),
      ]);
      this.setData({
        categories: dict.filter((x) => x.kind === 'CATEGORY'),
        announcements,
        paused: runtime.tradingPaused,
        mode: runtime.paymentMode,
      });
    } catch {}
  },
  input(e: WechatMiniprogram.Input) {
    this.setData({ q: e.detail.value });
  },
  search() {
    void this.load(true);
  },
  category(e: WechatMiniprogram.TouchEvent) {
    this.setData({ categoryId: e.currentTarget.dataset.id });
    void this.load(true);
  },
  async load(reset = false) {
    if (this.data.loading) return;
    this.setData({ loading: true, error: '' });
    try {
      const p = reset ? 1 : this.data.page;
      const result = await request(
        `/products?q=${encodeURIComponent(this.data.q)}${this.data.categoryId ? `&categoryId=${this.data.categoryId}` : ''}&page=${p}`,
      );
      const products = result.items.map((x: Row) => ({ ...x, yuan: yuan(x.price) }));
      this.setData({
        products: reset ? products : [...this.data.products, ...products],
        total: result.total,
        page: p,
      });
    } catch (e) {
      this.setData({ error: (e as Error).message });
    } finally {
      this.setData({ loading: false });
      wx.stopPullDownRefresh();
    }
  },
  onPullDownRefresh() {
    void this.init();
    void this.load(true);
  },
  onReachBottom() {
    if (!this.data.loading && this.data.products.length < this.data.total) {
      this.setData({ page: this.data.page + 1 });
      void this.load();
    }
  },
  detail(e: WechatMiniprogram.TouchEvent) {
    wx.navigateTo({ url: `/pages/detail/index?id=${e.currentTarget.dataset.id}` });
  },
  announce(e: WechatMiniprogram.TouchEvent) {
    const a = this.data.announcements[e.currentTarget.dataset.index];
    wx.showModal({ title: a.title, content: a.content, showCancel: false });
  },
});
