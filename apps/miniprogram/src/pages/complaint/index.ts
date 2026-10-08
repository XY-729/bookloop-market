import { request, Row, upload, ensureLogin, date, statuses } from '../../lib/api';
Page({
  data: { orderId: '', content: '', evidence: [] as Row[], items: [] as Row[], busy: false },
  onLoad(options) {
    this.setData({ orderId: options.orderId || '' });
  },
  onShow() {
    void this.load();
  },
  async load() {
    if (!ensureLogin()) return;
    try {
      this.setData({
        items: (await request<Row[]>('/me/complaints')).map((x) => ({
          ...x,
          time: date(x.createdAt),
          label: statuses[x.status],
        })),
      });
    } catch {}
  },
  input(e: WechatMiniprogram.Input) {
    this.setData({ content: e.detail.value });
  },
  async image() {
    if (this.data.evidence.length >= 6) return;
    try {
      this.setData({ evidence: [...this.data.evidence, await upload('EVIDENCE')] });
    } catch {}
  },
  async submit() {
    if (!this.data.content.trim() || this.data.busy) return;
    this.setData({ busy: true });
    try {
      await request('/complaints', 'POST', {
        orderId: this.data.orderId,
        content: this.data.content,
        evidence: this.data.evidence.map((x) => x.id),
      });
      this.setData({ content: '', evidence: [] });
      wx.showToast({ title: '投诉已提交', icon: 'success' });
      await this.load();
    } catch {
    } finally {
      this.setData({ busy: false });
    }
  },
});
