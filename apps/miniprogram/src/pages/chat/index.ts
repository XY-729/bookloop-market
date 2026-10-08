import {
  request,
  Row,
  user,
  upload,
  signedImage,
  publicImage,
  ensureLogin,
  date,
} from '../../lib/api';
import { listen } from '../../lib/socket';
let unsubscribe: (() => void) | undefined;
function clientId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
Page({
  data: {
    id: '',
    productId: '',
    messages: [] as Row[],
    text: '',
    busy: false,
    scrollInto: '',
    cursor: '',
    hasMore: true,
  },
  onLoad(options) {
    this.setData({ id: options.id || '', productId: options.productId || '' });
  },
  onShow() {
    void this.load();
    unsubscribe = listen((event) => {
      if (
        event.event === 'reconnected' ||
        (event.event === 'message' && event.data.conversationId === this.data.id)
      )
        void this.load();
    });
  },
  onHide() {
    unsubscribe?.();
    unsubscribe = undefined;
  },
  onUnload() {
    unsubscribe?.();
  },
  async load(older = false) {
    if (!ensureLogin()) return;
    try {
      const rows = await request<Row[]>(
        `/conversations/${this.data.id}/messages${older && this.data.cursor ? `?beforeId=${this.data.cursor}` : ''}`,
      );
      const mapped: Row[] = await Promise.all(
        rows.reverse().map(async (x) => ({
          ...x,
          mine: x.senderId === user().id,
          time: date(x.createdAt),
          image: x.kind === 'IMAGE' ? await signedImage(x.body).catch(() => '') : null,
          card:
            x.kind === 'PRODUCT' ? await request(`/products/${x.body}`).catch(() => null) : null,
        })),
      );
      const map = new Map<string, Row>();
      for (const row of [...this.data.messages, ...mapped]) map.set(row.id, row);
      const merged = [...map.values()].sort(
        (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      );
      this.setData({
        messages: merged,
        cursor: merged[0]?.id || '',
        hasMore: older || !this.data.messages.length ? rows.length === 50 : this.data.hasMore,
        ...(!older ? { scrollInto: `m-${merged[merged.length - 1]?.id || ''}` } : {}),
      });
      await request(`/conversations/${this.data.id}/read`, 'POST');
    } catch {}
  },
  input(e: WechatMiniprogram.Input) {
    this.setData({ text: e.detail.value });
  },
  async send(kind: string, body: string) {
    if (this.data.busy) return;
    this.setData({ busy: true });
    const pending = wx.getStorageSync(`pending-chat:${this.data.id}`) as Row | undefined;
    const message =
      pending?.kind === kind && pending.body === body
        ? pending
        : { kind, body, clientId: clientId() };
    wx.setStorageSync(`pending-chat:${this.data.id}`, message);
    try {
      await request(`/conversations/${this.data.id}/messages`, 'POST', message);
      wx.removeStorageSync(`pending-chat:${this.data.id}`);
      if (kind === 'TEXT') this.setData({ text: '' });
      await this.load();
    } catch {
    } finally {
      this.setData({ busy: false });
    }
  },
  textSend() {
    if (this.data.text.trim()) void this.send('TEXT', this.data.text.trim());
  },
  async imageSend() {
    try {
      const media = await upload('CHAT');
      await this.send('IMAGE', media.id);
    } catch {}
  },
  cardSend() {
    if (this.data.productId) void this.send('PRODUCT', this.data.productId);
  },
  older() {
    void this.load(true);
  },
  preview(e: WechatMiniprogram.TouchEvent) {
    wx.previewImage({ urls: [e.currentTarget.dataset.url] });
  },
  book(e: WechatMiniprogram.TouchEvent) {
    wx.navigateTo({ url: `/pages/detail/index?id=${e.currentTarget.dataset.id}` });
  },
});
