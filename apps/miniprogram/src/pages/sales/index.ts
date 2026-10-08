import { request, Row, yuan, statuses, publicImage, ensureLogin, confirm } from '../../lib/api';
Page({
  data: { items: [] as Row[] },
  onShow() {
    void this.load();
  },
  async load() {
    if (!ensureLogin()) return;
    try {
      this.setData({
        items: (await request<Row[]>('/me/products')).map((x) => ({
          ...x,
          yuan: yuan(x.price),
          label: statuses[x.status],
          image: publicImage(x.frontMediaId),
        })),
      });
    } catch {}
  },
  async price(e: WechatMiniprogram.TouchEvent) {
    const product = this.data.items.find((x) => x.id === e.currentTarget.dataset.id)!;
    const result = await new Promise<WechatMiniprogram.ShowModalSuccessCallbackResult>((resolve) =>
      wx.showModal({
        title: '修改在售价格',
        content: product.yuan,
        editable: true,
        placeholderText: '输入新价格（元）',
        success: resolve,
      }),
    );
    if (!result.confirm) return;
    const amount = result.content || '';
    if (!/^\d+(\.\d{1,2})?$/.test(amount) || Number(amount) <= 0) {
      wx.showToast({ title: '请输入有效价格', icon: 'none' });
      return;
    }
    try {
      await request(`/products/${product.id}/price`, 'POST', {
        price: Math.round(Number(amount) * 100),
      });
      await this.load();
    } catch {}
  },
  edit(e: WechatMiniprogram.TouchEvent) {
    wx.setStorageSync('edit-product', e.currentTarget.dataset.id);
    wx.switchTab({ url: '/pages/publish/index' });
  },
  async offline(e: WechatMiniprogram.TouchEvent) {
    if (!(await confirm('下架教材', '确认将这本教材下架？'))) return;
    try {
      await request(`/products/${e.currentTarget.dataset.id}/offline`, 'POST');
      await this.load();
    } catch {}
  },
  orders() {
    wx.navigateTo({ url: '/pages/orders/index?role=seller' });
  },
});
