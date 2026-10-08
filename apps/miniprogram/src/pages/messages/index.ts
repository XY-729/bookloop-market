import { request, Row, date, ensureLogin } from '../../lib/api';
import { listen } from '../../lib/socket';
let unsubscribe: (() => void) | undefined;
Page({
  data: { conversations: [] as Row[], notifications: [] as Row[], tab: 'chat', loading: false },
  onShow() {
    void this.load();
    if (wx.getStorageSync('market-user')?.verified) unsubscribe = listen(() => void this.load());
  },
  onHide() {
    unsubscribe?.();
    unsubscribe = undefined;
  },
  onUnload() {
    unsubscribe?.();
  },
  async load() {
    if (!ensureLogin()) return;
    this.setData({ loading: true });
    try {
      const me = await request('/me');
      const [conversations, notes] = await Promise.all([
        me.verified ? request<Row[]>('/conversations') : Promise.resolve([]),
        request<Row[]>('/notifications'),
      ]);
      this.setData({
        conversations: conversations.map((x) => ({
          ...x,
          preview:
            x.last?.kind === 'TEXT'
              ? x.last.body
              : x.last?.kind === 'IMAGE'
                ? '[图片]'
                : x.last?.kind === 'PRODUCT'
                  ? '[教材卡片]'
                  : '开始聊聊这本教材',
          time: date(x.updatedAt),
        })),
        notifications: notes.map((x) => ({ ...x, time: date(x.createdAt) })),
      });
    } catch {
    } finally {
      this.setData({ loading: false });
    }
  },
  tab(e: WechatMiniprogram.TouchEvent) {
    this.setData({ tab: e.currentTarget.dataset.tab });
  },
  chat(e: WechatMiniprogram.TouchEvent) {
    wx.navigateTo({
      url: `/pages/chat/index?id=${e.currentTarget.dataset.id}&productId=${e.currentTarget.dataset.product}`,
    });
  },
  async note(e: WechatMiniprogram.TouchEvent) {
    const n = this.data.notifications[e.currentTarget.dataset.index];
    try {
      await request(`/notifications/${n.id}/read`, 'POST');
      if (n.orderId) wx.navigateTo({ url: `/pages/order/index?id=${n.orderId}` });
      else wx.showModal({ title: n.title, content: n.content, showCancel: false });
      void this.load();
    } catch {}
  },
});
