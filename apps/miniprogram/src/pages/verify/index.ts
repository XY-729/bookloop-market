import { request, upload, ensureLogin, Row } from '../../lib/api';
Page({
  data: {
    media: null as Row | null,
    busy: false,
    verification: null as Row | null,
    verified: false,
  },
  onLoad() {
    void this.load();
  },
  async load() {
    if (!ensureLogin()) return;
    try {
      const me = await request('/me');
      this.setData({ verification: me.verification, verified: me.verified });
    } catch {}
  },
  async image() {
    try {
      this.setData({ media: await upload('IDENTITY') });
    } catch {}
  },
  async submit() {
    if (!this.data.media || this.data.busy) return;
    this.setData({ busy: true });
    try {
      await request('/verifications', 'POST', { mediaId: this.data.media.id });
      wx.showToast({ title: '已提交审核', icon: 'success' });
      this.setData({ media: null });
      await this.load();
    } catch {
    } finally {
      this.setData({ busy: false });
    }
  },
});
