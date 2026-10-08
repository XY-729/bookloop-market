import {
  request,
  Row,
  yuan,
  date,
  statuses,
  ensureLogin,
  user,
  confirm,
  subscribe,
  publicImage,
} from '../../lib/api';
Page({
  data: {
    id: '',
    order: null as Row | null,
    isBuyer: false,
    isSeller: false,
    busy: false,
    reason: '',
    mode: '',
    error: '',
  },
  onLoad(options) {
    this.setData({ id: options.id || '' });
  },
  onShow() {
    void this.load();
  },
  async load() {
    if (!ensureLogin()) return;
    try {
      const [o, runtime] = await Promise.all([
        request(`/orders/${this.data.id}`),
        request('/runtime'),
      ]);
      this.setData({
        order: {
          ...o,
          label: statuses[o.status],
          yuan: yuan(o.amount),
          time: date(o.createdAt),
          paidTime: date(o.paidAt),
          deliveredTime: date(o.deliveredAt),
          expires: date(o.expiresAt),
          image: publicImage(o.snapshot.frontMediaId),
          refundLabel: o.refund ? statuses[o.refund.status] : '',
          settlementLabel: o.settlement ? statuses[o.settlement.status] : '',
        },
        isBuyer: o.buyerId === user().id,
        isSeller: o.sellerId === user().id,
        mode: runtime.paymentMode,
        error: '',
      });
    } catch (e) {
      this.setData({ error: (e as Error).message });
    }
  },
  reason(e: WechatMiniprogram.Input) {
    this.setData({ reason: e.detail.value });
  },
  async pay() {
    if (this.data.busy) return;
    const intent = await request(`/orders/${this.data.id}/pay`, 'POST').catch(() => null);
    if (!intent) return;
    this.setData({ busy: true });
    try {
      if (intent.mode === 'mock') {
        if (
          !(await confirm('内部模拟支付', `模拟支付 ¥${this.data.order!.yuan}，不会扣除真实资金。`))
        )
          return;
        await request(`/orders/${this.data.id}/mock-pay`, 'POST');
      } else {
        await new Promise<void>((resolve, reject) =>
          wx.requestPayment({
            ...(intent as WechatMiniprogram.RequestPaymentOption),
            success: () => resolve(),
            fail: reject,
          }),
        );
      }
      await subscribe();
      await this.load();
    } catch {
    } finally {
      this.setData({ busy: false });
    }
  },
  async action(e: WechatMiniprogram.TouchEvent) {
    if (this.data.busy) return;
    const action = e.currentTarget.dataset.action;
    const labels: Record<string, string> = {
      cancel: '取消此未付款订单？',
      deliver: '已与买家完成教材交付？',
      confirm: '已收到并核对教材？确认后将进入结算流程。',
    };
    if (!(await confirm('确认操作', labels[action] || '确认操作？'))) return;
    this.setData({ busy: true });
    try {
      await request(`/orders/${this.data.id}/${action}`, 'POST');
      await this.load();
    } catch {
    } finally {
      this.setData({ busy: false });
    }
  },
  async refund() {
    if (!this.data.reason.trim()) {
      wx.showToast({ title: '请填写退款原因', icon: 'none' });
      return;
    }
    this.setData({ busy: true });
    try {
      await request(`/orders/${this.data.id}/refunds`, 'POST', { reason: this.data.reason });
      this.setData({ reason: '' });
      await this.load();
    } catch {
    } finally {
      this.setData({ busy: false });
    }
  },
  async returned() {
    if (!(await confirm('确认退书', '已核实买家退回教材？确认后将执行全额退款。'))) return;
    try {
      await request(`/refunds/${this.data.order!.refund.id}/return`, 'POST');
      await this.load();
    } catch {}
  },
  async chat() {
    try {
      const c = await request(`/orders/${this.data.id}/conversation`, 'POST');
      wx.navigateTo({
        url: `/pages/chat/index?id=${c.id}&productId=${this.data.order!.productId}`,
      });
    } catch {
      if (this.data.isSeller) wx.switchTab({ url: '/pages/messages/index' });
    }
  },
  complain() {
    wx.navigateTo({ url: `/pages/complaint/index?orderId=${this.data.id}` });
  },
});
