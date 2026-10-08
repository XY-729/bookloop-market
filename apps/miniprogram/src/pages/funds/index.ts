import { request, Row, yuan, date, ensureLogin } from '../../lib/api';
Page({
  data: { funds: null as Row | null },
  onShow() {
    void this.load();
  },
  async load() {
    if (!ensureLogin()) return;
    try {
      const f = await request('/me/funds');
      const labels: Record<string, string> = {
        PENDING: '待结算记录',
        PROCESSING: '结算处理中',
        SETTLED: '渠道结算完成',
        REFUNDED: '退款完成',
      };
      this.setData({
        funds: {
          ...f,
          pendingYuan: yuan(f.pending),
          processingYuan: yuan(f.processing),
          settledYuan: yuan(f.settled),
          ledger: f.ledger.map((x: Row) => ({
            ...x,
            label: labels[x.kind] || x.kind,
            yuan: yuan(x.amount),
            time: date(x.createdAt),
          })),
        },
      });
    } catch {}
  },
  order(e: WechatMiniprogram.TouchEvent) {
    wx.navigateTo({ url: `/pages/order/index?id=${e.currentTarget.dataset.id}` });
  },
});
