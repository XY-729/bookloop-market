import { request, Row, upload, ensureLogin, yuan } from '../../lib/api';
Page({
  data: {
    dict: [] as Row[],
    topics: [] as Row[],
    categories: [] as Row[],
    locations: [] as Row[],
    title: '',
    price: '',
    condition: '',
    handoff: '',
    topicIndex: 0,
    categoryIndex: 0,
    locationIndex: 0,
    front: null as Row | null,
    back: null as Row | null,
    busy: false,
    editId: '',
    verified: false,
  },
  onShow() {
    void this.load();
  },
  async load() {
    if (!ensureLogin()) return;
    try {
      const [dict, me] = await Promise.all([request<Row[]>('/dictionaries'), request('/me')]);
      this.setData({
        dict,
        topics: [{ id: '', name: '请选择主题' }, ...dict.filter((x) => x.kind === 'TOPIC')],
        categories: [{ id: '', name: '请选择分类' }, ...dict.filter((x) => x.kind === 'CATEGORY')],
        locations: [
          { id: '', name: '请选择交付区域' },
          ...dict.filter((x) => x.kind === 'LOCATION'),
        ],
        verified: me.verified,
      });
      const editId = wx.getStorageSync('edit-product');
      if (editId) {
        wx.removeStorageSync('edit-product');
        const product = await request(`/me/products/${editId}`);
        this.setData({
          editId,
          title: product.title,
          price: yuan(product.price),
          condition: product.condition,
          handoff: product.handoff,
          topicIndex: Math.max(
            0,
            this.data.topics.findIndex((x) => x.id === product.topicId),
          ),
          categoryIndex: Math.max(
            0,
            this.data.categories.findIndex((x) => x.id === product.categoryId),
          ),
          locationIndex: Math.max(
            0,
            this.data.locations.findIndex((x) => x.id === product.locationId),
          ),
          front: { id: product.frontMediaId, preview: product.frontUrl },
          back: { id: product.backMediaId, preview: product.backUrl },
        });
      }
    } catch {}
  },
  input(e: WechatMiniprogram.Input) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value });
  },
  pick(e: WechatMiniprogram.PickerChange) {
    this.setData({ [e.currentTarget.dataset.field]: Number(e.detail.value) });
  },
  async image(e: WechatMiniprogram.TouchEvent) {
    if (!ensureLogin()) return;
    try {
      this.setData({ [e.currentTarget.dataset.side]: await upload('PRODUCT') });
    } catch {}
  },
  verify() {
    wx.navigateTo({ url: '/pages/verify/index' });
  },
  async submit() {
    if (this.data.busy || !ensureLogin()) return;
    const d = this.data;
    if (!/^\d+(\.\d{1,2})?$/.test(d.price) || Number(d.price) <= 0) {
      wx.showToast({ title: '请输入大于 0 且最多两位小数的价格', icon: 'none' });
      return;
    }
    if (
      !d.front ||
      !d.back ||
      d.topicIndex <= 0 ||
      d.categoryIndex <= 0 ||
      d.locationIndex <= 0 ||
      !d.title.trim() ||
      !d.condition.trim() ||
      !d.handoff.trim()
    ) {
      wx.showToast({ title: '请补全信息与正反面照片', icon: 'none' });
      return;
    }
    this.setData({ busy: true });
    try {
      await request(d.editId ? `/products/${d.editId}/edit` : '/products', 'POST', {
        title: d.title,
        price: Math.round(Number(d.price) * 100),
        condition: d.condition,
        handoff: d.handoff,
        topicId: d.topics[d.topicIndex].id,
        categoryId: d.categories[d.categoryIndex].id,
        locationId: d.locations[d.locationIndex].id,
        frontMediaId: d.front.id,
        backMediaId: d.back.id,
      });
      wx.showToast({ title: '已提交，等待审核', icon: 'success' });
      this.setData({
        title: '',
        price: '',
        condition: '',
        handoff: '',
        front: null,
        back: null,
        topicIndex: 0,
        categoryIndex: 0,
        locationIndex: 0,
        editId: '',
      });
      wx.navigateTo({ url: '/pages/sales/index' });
    } catch {
    } finally {
      this.setData({ busy: false });
    }
  },
});
