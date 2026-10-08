import { request, Row, yuan, ensureLogin } from '../../lib/api';
Page({
  data: { id: '', book: null as Row | null, loading: true, error: '' },
  onLoad(options) {
    this.setData({ id: options.id || '' });
    void this.load();
  },
  async load() {
    try {
      const book = await request(`/products/${this.data.id}`);
      this.setData({ book: { ...book, yuan: yuan(book.price) }, loading: false });
      if (ensureLoginSilent())
        void request(`/products/${this.data.id}/visit`, 'POST').catch(() => {});
    } catch (e) {
      this.setData({ error: (e as Error).message, loading: false });
    }
  },
  async chat() {
    if (!ensureLogin()) return;
    try {
      const c = await request('/conversations', 'POST', { productId: this.data.id });
      wx.navigateTo({ url: `/pages/chat/index?id=${c.id}&productId=${this.data.id}` });
    } catch {}
  },
  async buy() {
    if (!ensureLogin()) return;
    try {
      const order = await request('/orders', 'POST', { productId: this.data.id });
      wx.navigateTo({ url: `/pages/order/index?id=${order.id}` });
    } catch {}
  },
  preview() {
    if (this.data.book)
      wx.previewImage({ urls: [this.data.book.frontUrl, this.data.book.backUrl] });
  },
});
function ensureLoginSilent() {
  return !!wx.getStorageSync('market-token');
}
