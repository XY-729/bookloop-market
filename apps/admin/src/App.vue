<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  Reading,
  DataAnalysis,
  User,
  DocumentChecked,
  Collection,
  ShoppingBag,
  RefreshLeft,
  Money,
  ChatDotRound,
  List,
  Bell,
  Timer,
  Operation,
  ArrowRight,
  Search,
  Refresh,
  Plus,
  SwitchButton,
} from '@element-plus/icons-vue';
import { api } from './api';
type Row = Record<string, any>;
const menus = [
  { id: 'dashboard', name: '工作台', icon: DataAnalysis },
  { id: 'readiness', name: '上线准备', icon: Operation },
  { id: 'verifications', name: '用户认证审核', icon: DocumentChecked },
  { id: 'products', name: '教材管理', icon: Collection },
  { id: 'orders', name: '交易订单', icon: ShoppingBag },
  { id: 'refunds', name: '退款审核', icon: RefreshLeft },
  { id: 'settlements', name: '结算记录', icon: Money },
  { id: 'complaints', name: '投诉处理', icon: ChatDotRound },
  { id: 'users', name: '用户管理', icon: User },
  { id: 'dictionaries', name: '分类与主题', icon: List },
  { id: 'announcements', name: '公告管理', icon: Bell },
  { id: 'tasks', name: '任务与异常', icon: Timer },
  { id: 'audits', name: '操作记录', icon: Operation },
];
const logged = ref(!!sessionStorage.getItem('market-admin-token'));
const username = ref('admin');
const password = ref('');
const loginBusy = ref(false);
const current = ref('dashboard');
const dashboard = ref<Row>({});
const release = ref<Row | null>(null);
const rows = ref<Row[]>([]);
const total = ref(0);
const page = ref(1);
const loading = ref(false);
const filter = ref('');
const search = ref('');
const error = ref('');
const selected = ref<Row | null>(null);
const drawer = ref(false);
const proof = ref('');
const evidenceUrls = ref<string[]>([]);
const evidenceMessages = ref<Row[]>([]);
const detail = ref<Row | null>(null);
const busy = ref(false);
const formDialog = ref(false);
const form = ref<Row>({});
const reconciliation = ref<Row | null>(null);
const title = computed(() => menus.find((x) => x.id === current.value)?.name || '工作台');
const statusText: Record<string, string> = {
  PENDING: '待审核',
  APPROVED: '已通过',
  REJECTED: '已驳回',
  ACTIVE: '在售',
  RESERVED: '待付款锁定',
  SOLD: '已售出',
  OFFLINE: '已下架',
  UNPAID: '待付款',
  PAID: '待交付',
  DELIVERED: '待收货',
  CANCELLED: '已取消',
  REFUND_REQUESTED: '退款审核中',
  WAIT_RETURN: '待退书',
  REFUNDING: '退款处理中',
  REFUNDED: '已退款',
  LATE_PAYMENT_REFUNDING: '迟到支付退款中',
  SETTLING: '结算处理中',
  SETTLED: '已结算',
  PROCESSING: '处理中',
  SUCCEEDED: '已成功',
  OPEN: '待处理',
  RESOLVED: '已处理',
  RUNNING: '执行中',
  DONE: '已完成',
  DEAD: '异常待处理',
  CREATED: '已创建',
  CLOSED: '已关闭',
};
const kindText: Record<string, string> = {
  CATEGORY: '分类',
  TOPIC: '主题',
  LOCATION: '交付区域',
  HANDOFF: '交付地点',
};
const state = (row: Row) =>
  row.state === 'PENDING'
    ? '待执行'
    : row.status === 'PENDING' && current.value === 'settlements'
      ? '待结算'
      : statusText[row.status || row.state] || row.status || row.state || '—';
const money = (amount: number) => `¥${((amount || 0) / 100).toFixed(2)}`;
const date = (value: string) =>
  value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
const short = (value: string) => (value ? value.slice(0, 8) : '—');
const filtered = computed(() =>
  rows.value.filter(
    (x) => !search.value || JSON.stringify(x).toLowerCase().includes(search.value.toLowerCase()),
  ),
);
const filters = computed(
  () =>
    (
      ({
        verifications: ['PENDING', 'APPROVED', 'REJECTED'],
        products: ['PENDING', 'ACTIVE', 'RESERVED', 'SOLD', 'OFFLINE', 'REJECTED'],
        orders: [
          'UNPAID',
          'PAID',
          'DELIVERED',
          'REFUND_REQUESTED',
          'REFUNDING',
          'SETTLING',
          'SETTLED',
          'REFUNDED',
          'CANCELLED',
        ],
        refunds: ['REQUESTED', 'WAIT_RETURN', 'PROCESSING', 'SUCCEEDED', 'REJECTED'],
        settlements: ['PENDING', 'SUCCEEDED'],
        complaints: ['OPEN', 'RESOLVED'],
        tasks: ['PENDING', 'RUNNING', 'DEAD', 'DONE'],
      }) as Record<string, string[]>
    )[current.value] || [],
);
async function login() {
  loginBusy.value = true;
  error.value = '';
  try {
    const result = await api('/auth/admin', 'POST', {
      username: username.value,
      password: password.value,
    });
    sessionStorage.setItem('market-admin-token', result.token);
    password.value = '';
    logged.value = true;
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loginBusy.value = false;
  }
}
function logout() {
  sessionStorage.removeItem('market-admin-token');
  logged.value = false;
}
async function load() {
  loading.value = true;
  error.value = '';
  try {
    dashboard.value = await api('/admin/dashboard');
    if (current.value === 'readiness') release.value = await api('/admin/readiness');
    else if (current.value !== 'dashboard') {
      const result = await api(
        `/admin/lists/${current.value}?page=${page.value}${filter.value ? `&status=${filter.value}` : ''}`,
      );
      rows.value = result.items;
      total.value = result.total;
    }
  } catch (e) {
    error.value = (e as Error).message;
    if (!sessionStorage.getItem('market-admin-token')) logged.value = false;
  } finally {
    loading.value = false;
  }
}
async function navigate(id: string) {
  current.value = id;
  page.value = 1;
  filter.value = '';
  search.value = '';
  reconciliation.value = null;
  await load();
}
async function run(work: () => Promise<unknown>, success = '操作成功') {
  busy.value = true;
  try {
    await work();
    ElMessage.success(success);
    drawer.value = false;
    formDialog.value = false;
    await load();
  } catch (e) {
    ElMessage.error((e as Error).message);
  } finally {
    busy.value = false;
  }
}
async function reason(prompt: string) {
  try {
    return (
      await ElMessageBox.prompt(prompt, '填写处理说明', {
        inputValidator: (v) => !!v?.trim() || '请填写说明',
        confirmButtonText: '确认',
        cancelButtonText: '取消',
      })
    ).value;
  } catch {
    return null;
  }
}
async function inspect(row: Row) {
  selected.value = row;
  proof.value = '';
  evidenceUrls.value = [];
  evidenceMessages.value = [];
  detail.value = null;
  drawer.value = true;
  try {
    if (current.value === 'verifications') {
      if (row.status === 'PENDING' || !row.purgeAt || new Date(row.purgeAt) > new Date())
        proof.value = (await api(`/media/${row.mediaId}/url`)).url;
    } else if (current.value === 'orders') detail.value = await api(`/orders/${row.id}`);
    else if (current.value === 'refunds') detail.value = await api(`/orders/${row.orderId}`);
    else if (current.value === 'complaints') {
      detail.value = await api(`/orders/${row.orderId}`);
      evidenceUrls.value = await Promise.all(
        (row.evidence || []).map(
          async (mediaId: string) => (await api(`/media/${mediaId}/url`)).url,
        ),
      );
      evidenceMessages.value = (await api(`/admin/orders/${row.orderId}/evidence`)).messages;
    }
  } catch (e) {
    ElMessage.warning((e as Error).message);
  }
}
async function reviewRow(row: Row, approve: boolean) {
  const note = await reason(approve ? '请填写审核通过说明' : '请填写驳回理由');
  if (!note) return;
  await run(() =>
    api(`/admin/${current.value}/${row.id}/review`, 'POST', { approve, reason: note }),
  );
}
async function reviewRefund(row: Row, approve: boolean, returnRequired = false) {
  const note = await reason(
    approve
      ? returnRequired
        ? '审核通过后需先退书，请填写处理说明'
        : '请填写退款通过说明'
      : '请填写退款驳回理由',
  );
  if (!note) return;
  await run(() =>
    api(`/admin/refunds/${row.id}/review`, 'POST', { approve, reason: note, returnRequired }),
  );
}
async function off(row: Row) {
  const note = await reason('请填写下架原因');
  if (note) await run(() => api(`/admin/products/${row.id}/offline`, 'POST', { reason: note }));
}
async function ban(row: Row) {
  const note = await reason(row.banned ? '请填写解封说明' : '请填写封禁原因');
  if (note)
    await run(() =>
      api(`/admin/users/${row.id}/ban`, 'POST', { banned: !row.banned, reason: note }),
    );
}
async function resolve(row: Row) {
  const note = await reason('请记录协调结果和后续安排');
  if (note)
    await run(() => api(`/admin/complaints/${row.id}/resolve`, 'POST', { resolution: note }));
}
async function pause() {
  const note = await reason(
    dashboard.value.paused
      ? '请填写恢复交易说明'
      : '暂停后将停止新发布、下单和付款，存量退款与结算继续处理。请填写原因',
  );
  if (note)
    await run(() =>
      api('/admin/trading', 'POST', { paused: !dashboard.value.paused, reason: note }),
    );
}
async function reconcile() {
  busy.value = true;
  try {
    reconciliation.value = await api('/admin/reconcile', 'POST');
    ElMessage.success('对账完成');
  } catch (e) {
    ElMessage.error((e as Error).message);
  } finally {
    busy.value = false;
  }
}
function editForm(row?: Row) {
  form.value =
    current.value === 'dictionaries'
      ? { ...(row || { kind: 'CATEGORY', name: '', active: true }) }
      : { ...(row || { title: '', content: '', active: true }) };
  formDialog.value = true;
}
async function saveForm() {
  const values =
    current.value === 'dictionaries'
      ? {
          ...(form.value.id ? { id: form.value.id } : {}),
          kind: form.value.kind,
          name: form.value.name,
          active: form.value.active,
        }
      : {
          ...(form.value.id ? { id: form.value.id } : {}),
          title: form.value.title,
          content: form.value.content,
          active: form.value.active,
        };
  await run(() => api(`/admin/${current.value}`, 'POST', values));
}
async function retry(row: Row) {
  try {
    await ElMessageBox.confirm(
      '使用原操作标识重试此任务。请先确认渠道状态及异常原因。',
      '重试失败任务',
      { confirmButtonText: '重试', cancelButtonText: '取消' },
    );
    await run(() => api(`/admin/tasks/${row.id}/retry`, 'POST'));
  } catch {}
}
onMounted(() => {
  if (logged.value) void load();
});
</script>

<template>
  <div v-if="!logged" class="login-page">
    <div class="login-story">
      <div class="brand">
        <el-icon><Reading /></el-icon><span>BookLoop 教材</span>
      </div>
      <div class="story-content">
        <span class="eyebrow">BOOKLOOP TEXTBOOK MARKET</span>
        <h1>一本书的价值，<br />继续在平台流转。</h1>
        <p>管理教材、审核用户身份，<br />让每一次平台交易都有据可查。</p>
        <div class="story-books"><span>微积分</span><span>基础物理</span><span>线性代数</span></div>
      </div>
      <small>本平台 · 二手教材交易</small>
    </div>
    <form class="login-form" @submit.prevent="login">
      <span class="eyebrow">运营管理</span>
      <h2>欢迎回到工作台</h2>
      <p>使用管理员账号登录</p>
      <label>管理员账号</label
      ><el-input
        v-model="username"
        size="large"
        autocomplete="username"
        placeholder="请输入账号"
      /><label>密码</label
      ><el-input
        v-model="password"
        type="password"
        size="large"
        show-password
        autocomplete="current-password"
        placeholder="请输入密码"
      /><el-alert v-if="error" :title="error" type="error" :closable="false" /><el-button
        native-type="submit"
        type="primary"
        size="large"
        :loading="loginBusy"
        >登录工作台 <el-icon><ArrowRight /></el-icon></el-button
      ><small>账号由平台负责人分配，审核操作将保留记录。</small>
    </form>
  </div>
  <div v-else class="layout">
    <aside class="sidebar">
      <div class="brand">
        <el-icon><Reading /></el-icon><span>BookLoop 教材<small>运营工作台</small></span>
      </div>
      <nav>
        <button
          v-for="item in menus"
          :key="item.id"
          :class="{ active: current === item.id }"
          @click="navigate(item.id)"
        >
          <el-icon><component :is="item.icon" /></el-icon>{{ item.name
          }}<span
            v-if="item.id === 'verifications' && dashboard.pendingVerifications"
            class="nav-count"
            >{{ dashboard.pendingVerifications }}</span
          >
        </button>
      </nav>
      <div class="sidebar-footer">
        <span class="online-dot"></span> 小规模试运营<small>让闲置教材找到新主人</small>
      </div>
    </aside>
    <main>
      <header class="topbar">
        <span
          >运营工作台 <span class="breadcrumb">/ {{ title }}</span></span
        >
        <div>
          <el-tag
            :type="
              dashboard.paymentMode === 'mock'
                ? 'warning'
                : dashboard.paymentMode
                  ? 'success'
                  : 'info'
            "
            effect="plain"
            >{{
              dashboard.paymentMode === 'mock'
                ? '开发环境 · 模拟资金'
                : dashboard.paymentMode
                  ? '真实支付环境'
                  : '环境信息待确认'
            }}</el-tag
          ><span class="admin-avatar">管</span><span>管理员</span
          ><el-button text @click="logout"
            ><el-icon><SwitchButton /></el-icon
          ></el-button>
        </div>
      </header>
      <section class="content">
        <div class="page-heading">
          <div>
            <span class="eyebrow">MARKET OPERATIONS</span>
            <h1>{{ title }}</h1>
            <p>
              {{
                current === 'dashboard'
                  ? '查看平台交易近况，及时处理待办事项。'
                  : '审核、查询与处理记录，保障平台交易顺利完成。'
              }}
            </p>
          </div>
          <div class="heading-actions">
            <el-button :icon="Refresh" @click="load" :loading="loading">刷新</el-button
            ><el-button
              v-if="['dictionaries', 'announcements'].includes(current)"
              type="primary"
              :icon="Plus"
              @click="editForm()"
              >新增{{ current === 'dictionaries' ? '条目' : '公告' }}</el-button
            >
          </div>
        </div>
        <el-alert v-if="error" :title="error" type="error" :closable="false" class="page-alert" />
        <el-alert
          v-if="dashboard.paused"
          title="新交易已暂停，存量订单和售后继续处理。"
          type="warning"
          :closable="false"
          class="page-alert"
        />
        <template v-if="current === 'dashboard'">
          <div class="stats-grid">
            <div
              v-for="item in [
                { label: '注册用户', value: dashboard.users, icon: User, hint: '平台用户' },
                {
                  label: '在售教材',
                  value: dashboard.products,
                  icon: Collection,
                  hint: '审核通过并上架',
                },
                {
                  label: '交易订单',
                  value: dashboard.orders,
                  icon: ShoppingBag,
                  hint: '累计创建订单',
                },
                {
                  label: '待处理事项',
                  value:
                    (dashboard.pendingVerifications || 0) +
                    (dashboard.pendingProducts || 0) +
                    (dashboard.pendingRefunds || 0) +
                    (dashboard.openComplaints || 0),
                  icon: DocumentChecked,
                  hint: '身份、教材与售后',
                },
              ]"
              :key="item.label"
              class="stat-card"
            >
              <div>
                <span>{{ item.label }}</span
                ><el-icon><component :is="item.icon" /></el-icon>
              </div>
              <strong>{{ item.value || 0 }}</strong
              ><small>{{ item.hint }}</small>
            </div>
          </div>
          <div class="dashboard-grid">
            <section class="panel">
              <div class="panel-title">
                <h2>待办事项</h2>
                <span>按审核队列处理</span>
              </div>
              <button
                v-for="item in [
                  {
                    id: 'verifications',
                    name: '用户认证审核',
                    desc: '核对证明，审核后开放交易权限',
                    count: dashboard.pendingVerifications,
                  },
                  {
                    id: 'products',
                    name: '教材上架审核',
                    desc: '确认教材范围、实拍图与描述',
                    count: dashboard.pendingProducts,
                  },
                  {
                    id: 'refunds',
                    name: '退款申请',
                    desc: '核对交付与退书情况后处理',
                    count: dashboard.pendingRefunds,
                  },
                  {
                    id: 'complaints',
                    name: '交易投诉',
                    desc: '记录证据，协调交易双方',
                    count: dashboard.openComplaints,
                  },
                ]"
                :key="item.id"
                class="todo-row"
                @click="navigate(item.id)"
              >
                <div>
                  <strong>{{ item.name }}</strong
                  ><small>{{ item.desc }}</small>
                </div>
                <span class="todo-count">{{ item.count || 0 }}</span
                ><el-icon><ArrowRight /></el-icon>
              </button>
            </section>
            <section class="panel platform-panel">
              <div class="panel-title">
                <h2>平台运行</h2>
                <span class="status-pill" :class="{ warn: dashboard.paused }">{{
                  dashboard.paymentMode ? (dashboard.paused ? '新交易暂停' : '正常运行') : '未连接'
                }}</span>
              </div>
              <p>线上付款，线下交付。买家确认收货后结算，未确认则按付款后第 7 天检查结算条件。</p>
              <div class="rule-row"><span>平台手续费</span><strong>0 元</strong></div>
              <div class="rule-row"><span>未交付自动退款</span><strong>72 小时</strong></div>
              <div class="rule-row">
                <span>异常任务</span
                ><el-button
                  text
                  :type="dashboard.deadTasks ? 'danger' : 'primary'"
                  @click="navigate('tasks')"
                  >{{ dashboard.deadTasks || 0 }} 条</el-button
                >
              </div>
              <div class="platform-actions">
                <el-button @click="reconcile" :loading="busy">执行对账</el-button
                ><el-button :type="dashboard.paused ? 'primary' : 'warning'" plain @click="pause">{{
                  dashboard.paused ? '恢复交易' : '暂停新交易'
                }}</el-button>
              </div>
              <small v-if="dashboard.paymentMode === 'mock'"
                >当前仅验证内部模拟流程，真实资金接入尚未完成。</small
              >
            </section>
          </div>
          <section class="panel recent-panel">
            <div class="panel-title">
              <h2>最近订单</h2>
              <el-button text @click="navigate('orders')"
                >查看全部 <el-icon><ArrowRight /></el-icon
              ></el-button>
            </div>
            <el-table :data="dashboard.recentOrders || []"
              ><el-table-column label="教材" min-width="220"
                ><template #default="s"
                  ><strong>{{ s.row.snapshot?.title }}</strong
                  ><small class="cell-sub">订单 {{ short(s.row.id) }}</small></template
                ></el-table-column
              ><el-table-column label="金额" width="140"
                ><template #default="s">{{ money(s.row.amount) }}</template></el-table-column
              ><el-table-column label="状态" width="160"
                ><template #default="s"
                  ><el-tag effect="light">{{ state(s.row) }}</el-tag></template
                ></el-table-column
              ><el-table-column label="下单时间" min-width="180"
                ><template #default="s">{{ date(s.row.createdAt) }}</template></el-table-column
              ><template #empty
                ><el-empty
                  description="还没有交易订单，首笔交易将在这里显示"
                  :image-size="70" /></template
            ></el-table>
          </section>
        </template>
        <section v-else-if="current === 'readiness'" class="panel table-panel" v-loading="loading">
          <el-alert
            type="warning"
            title="配置检查不代表正式验收通过。真实支付适配器、微信真机及生产环境仍需完成实际验证。"
            :closable="false"
          />
          <div class="panel-title" style="margin-top: 24px">
            <h2>发布条件检查</h2>
            <el-tag :type="release?.ready ? 'success' : 'warning'">{{
              release?.ready ? '条件已齐备' : '尚不可正式上线'
            }}</el-tag>
          </div>
          <el-table :data="release?.checks || []"
            ><el-table-column prop="label" label="检查事项" min-width="180" /><el-table-column
              label="状态"
              width="100"
              ><template #default="s"
                ><el-tag
                  :type="
                    s.row.status === 'PASS'
                      ? 'success'
                      : s.row.status === 'BLOCKED'
                        ? 'danger'
                        : 'info'
                  "
                  >{{
                    s.row.status === 'PASS'
                      ? '已配置'
                      : s.row.status === 'BLOCKED'
                        ? '未就绪'
                        : '待验收'
                  }}</el-tag
                ></template
              ></el-table-column
            ><el-table-column prop="detail" label="说明" min-width="320"
          /></el-table>
        </section>
        <section v-else class="panel table-panel" v-loading="loading">
          <div class="table-toolbar">
            <div>
              <el-select
                v-if="filters.length"
                v-model="filter"
                placeholder="全部状态"
                clearable
                @change="
                  page = 1;
                  load();
                "
                style="width: 170px"
                ><el-option
                  v-for="s in filters"
                  :key="s"
                  :label="statusText[s] || (s === 'REQUESTED' ? '待审核' : s)"
                  :value="s" /></el-select
              ><el-input
                v-model="search"
                :prefix-icon="Search"
                placeholder="搜索当前页"
                clearable
                style="width: 220px"
              />
            </div>
            <span>共 {{ total }} 条记录</span>
          </div>
          <el-table :data="filtered" row-key="id">
            <el-table-column label="内容" min-width="230"
              ><template #default="s"
                ><strong>{{
                  s.row.title ||
                  s.row.name ||
                  s.row.nickname ||
                  s.row.snapshot?.title ||
                  s.row.reason ||
                  s.row.content ||
                  s.row.action ||
                  s.row.kind ||
                  '用户身份申请'
                }}</strong
                ><small class="cell-sub">{{
                  current === 'dictionaries' ? kindText[s.row.kind] : '编号 ' + short(s.row.id)
                }}</small></template
              ></el-table-column
            >
            <el-table-column
              v-if="['products', 'orders', 'refunds', 'settlements'].includes(current)"
              label="金额"
              width="115"
              ><template #default="s">{{
                money(s.row.amount ?? s.row.price)
              }}</template></el-table-column
            >
            <el-table-column label="状态" width="145"
              ><template #default="s"
                ><el-tag
                  v-if="current === 'users'"
                  :type="s.row.banned ? 'danger' : s.row.verified ? 'success' : 'info'"
                  >{{ s.row.banned ? '已封禁' : s.row.verified ? '已认证' : '未认证' }}</el-tag
                ><el-tag
                  v-else-if="['dictionaries', 'announcements'].includes(current)"
                  :type="s.row.active ? 'success' : 'info'"
                  >{{ s.row.active ? '已启用' : '已停用' }}</el-tag
                ><el-tag
                  v-else-if="current !== 'audits'"
                  :type="
                    ['DEAD', 'REJECTED'].includes(s.row.status || s.row.state) ? 'danger' : 'info'
                  "
                  >{{ s.row.status === 'REQUESTED' ? '待审核' : state(s.row) }}</el-tag
                ><span v-else>已记录</span></template
              ></el-table-column
            >
            <el-table-column label="时间" min-width="170"
              ><template #default="s">{{
                date(s.row.createdAt || s.row.updatedAt)
              }}</template></el-table-column
            >
            <el-table-column label="操作" min-width="230" fixed="right"
              ><template #default="s"
                ><el-button link type="primary" @click="inspect(s.row)">查看</el-button
                ><template
                  v-if="
                    ['verifications', 'products'].includes(current) && s.row.status === 'PENDING'
                  "
                  ><el-button link type="success" @click="reviewRow(s.row, true)">通过</el-button
                  ><el-button link type="danger" @click="reviewRow(s.row, false)"
                    >驳回</el-button
                  ></template
                ><el-button
                  v-if="current === 'products' && ['ACTIVE', 'RESERVED'].includes(s.row.status)"
                  link
                  type="danger"
                  @click="off(s.row)"
                  >下架</el-button
                ><el-button
                  v-if="current === 'refunds' && s.row.status === 'REQUESTED'"
                  link
                  type="primary"
                  @click="inspect(s.row)"
                  >处理退款</el-button
                ><el-button
                  v-if="current === 'complaints' && s.row.status === 'OPEN'"
                  link
                  type="primary"
                  @click="resolve(s.row)"
                  >记录处理结果</el-button
                ><el-button
                  v-if="current === 'users'"
                  link
                  :type="s.row.banned ? 'success' : 'danger'"
                  @click="ban(s.row)"
                  >{{ s.row.banned ? '解封' : '封禁' }}</el-button
                ><el-button
                  v-if="['dictionaries', 'announcements'].includes(current)"
                  link
                  type="primary"
                  @click="editForm(s.row)"
                  >编辑</el-button
                ><el-button
                  v-if="current === 'tasks' && s.row.state === 'DEAD'"
                  link
                  type="warning"
                  @click="retry(s.row)"
                  >重试</el-button
                ></template
              ></el-table-column
            > </el-table
          ><el-pagination
            v-model:current-page="page"
            :total="total"
            :page-size="20"
            layout="prev, pager, next, total"
            @current-change="load"
          />
        </section>
        <section v-if="reconciliation" class="panel report">
          <h2>对账结果</h2>
          <p>
            核对 {{ reconciliation.payments }} 笔付款、{{ reconciliation.refunds }} 笔退款、{{
              reconciliation.settlements
            }}
            笔结算。
          </p>
          <el-alert
            :type="reconciliation.differences.length ? 'error' : 'success'"
            :title="
              reconciliation.differences.length
                ? `发现 ${reconciliation.differences.length} 项差异，请暂停新交易并核查渠道记录`
                : '未发现渠道状态差异'
            "
            :closable="false"
          />
          <pre v-if="reconciliation.differences.length">{{
            JSON.stringify(reconciliation.differences, null, 2)
          }}</pre>
        </section>
        <footer class="page-footer">
          BookLoop 二手教材交易 <span>学习教材 · 线上交易 · 线下交付</span>
        </footer>
      </section>
    </main>
    <el-drawer v-model="drawer" title="记录详情" size="520px"
      ><template v-if="selected"
        ><div class="detail-header">
          <h2>{{ selected.title || selected.snapshot?.title || selected.nickname || title }}</h2>
          <el-tag>{{ state(selected) }}</el-tag>
        </div>
        <template v-if="current === 'verifications'"
          ><p>证明图片仅用于用户认证审核。审核结束 7 天后删除原始图片。</p>
          <el-image
            v-if="proof"
            :src="proof"
            :preview-src-list="[proof]"
            class="proof-image" /><el-empty
            v-else
            description="证明图片已删除或无法查看" /></template
        ><template v-if="current === 'products'"
          ><div class="book-images">
            <el-image
              v-for="m in [selected.frontMediaId, selected.backMediaId]"
              :key="m"
              :src="`/files/public/${m}`"
              :preview-src-list="[`/files/public/${m}`]"
            />
          </div>
          <p>{{ selected.condition }}</p>
          <p>{{ selected.handoff }}</p></template
        ><el-descriptions :column="1" border
          ><el-descriptions-item label="编号">{{ selected.id }}</el-descriptions-item
          ><el-descriptions-item v-if="selected.userId" label="申请人">{{
            selected.userId
          }}</el-descriptions-item
          ><el-descriptions-item v-if="selected.orderId" label="订单">{{
            selected.orderId
          }}</el-descriptions-item
          ><el-descriptions-item
            v-if="selected.amount !== undefined || selected.price !== undefined"
            label="金额"
            >{{ money(selected.amount ?? selected.price) }}</el-descriptions-item
          ><el-descriptions-item v-if="selected.reason" label="申请说明">{{
            selected.reason
          }}</el-descriptions-item
          ><el-descriptions-item v-if="selected.content" label="内容">{{
            selected.content
          }}</el-descriptions-item
          ><el-descriptions-item v-if="selected.reviewReason" label="审核说明">{{
            selected.reviewReason
          }}</el-descriptions-item
          ><el-descriptions-item v-if="selected.resolution" label="处理结果">{{
            selected.resolution
          }}</el-descriptions-item
          ><el-descriptions-item v-if="selected.lastError" label="异常原因">{{
            selected.lastError
          }}</el-descriptions-item
          ><el-descriptions-item v-if="selected.channelId" label="渠道流水">{{
            selected.channelId
          }}</el-descriptions-item
          ><el-descriptions-item label="时间">{{
            date(selected.createdAt || selected.updatedAt)
          }}</el-descriptions-item></el-descriptions
        >
        <el-descriptions v-if="detail" :column="1" border class="order-details"
          ><el-descriptions-item label="订单状态">{{ state(detail) }}</el-descriptions-item
          ><el-descriptions-item label="付款时间">{{ date(detail.paidAt) }}</el-descriptions-item
          ><el-descriptions-item label="交付时间">{{
            date(detail.deliveredAt)
          }}</el-descriptions-item
          ><el-descriptions-item label="纠纷暂停">{{
            detail.disputed ? '是' : '否'
          }}</el-descriptions-item
          ><el-descriptions-item label="支付结果">{{
            detail.payment ? state(detail.payment) : '无'
          }}</el-descriptions-item
          ><el-descriptions-item label="结算结果">{{
            detail.settlement ? state(detail.settlement) : '尚未结算'
          }}</el-descriptions-item></el-descriptions
        >
        <div v-if="current === 'refunds' && selected.status === 'REQUESTED'" class="drawer-actions">
          <el-button type="primary" :loading="busy" @click="reviewRefund(selected, true, false)"
            >批准全额退款</el-button
          ><el-button
            v-if="detail?.deliveredAt"
            :loading="busy"
            @click="reviewRefund(selected, true, true)"
            >先退书再退款</el-button
          ><el-button type="danger" plain :loading="busy" @click="reviewRefund(selected, false)"
            >驳回</el-button
          >
        </div>
        <div
          v-if="current === 'refunds' && selected.status === 'WAIT_RETURN'"
          class="drawer-actions"
        >
          <el-button
            type="primary"
            :loading="busy"
            @click="run(() => api(`/refunds/${selected!.id}/return`, 'POST'))"
            >已核实退书完成</el-button
          >
        </div>
        <section v-if="current === 'complaints'" class="complaint-evidence">
          <h3>投诉证据</h3>
          <div class="book-images">
            <el-image
              v-for="url in evidenceUrls"
              :key="url"
              :src="url"
              :preview-src-list="evidenceUrls"
            />
          </div>
          <p v-if="!evidenceUrls.length" class="cell-sub">未上传图片证据</p>
          <details>
            <summary>查看相关聊天记录（最近 200 条）</summary>
            <div v-for="message in evidenceMessages" :key="message.id" class="evidence-message">
              <small>{{ message.sender.nickname }} · {{ date(message.createdAt) }}</small>
              <p v-if="message.kind === 'TEXT'">{{ message.body }}</p>
              <el-image
                v-else-if="message.kind === 'IMAGE'"
                :src="message.imageUrl"
                :preview-src-list="[message.imageUrl]"
              />
              <p v-else>教材卡片</p>
            </div>
            <p v-if="!evidenceMessages.length" class="cell-sub">暂无相关聊天记录</p>
          </details>
        </section>
        <div v-if="current === 'audits'" class="audit-details">
          <h3>操作明细</h3>
          <pre>{{ JSON.stringify(selected.details, null, 2) }}</pre>
        </div></template
      ></el-drawer
    >
    <el-dialog
      v-model="formDialog"
      :title="current === 'dictionaries' ? '维护分类与主题' : '维护公告'"
      width="520px"
      ><el-form label-position="top"
        ><template v-if="current === 'dictionaries'"
          ><el-form-item label="类别"
            ><el-select v-model="form.kind"
              ><el-option
                v-for="(label, key) in kindText"
                :key="key"
                :label="label"
                :value="key" /></el-select></el-form-item
          ><el-form-item label="名称"
            ><el-input v-model="form.name" maxlength="100" /></el-form-item></template
        ><template v-else
          ><el-form-item label="公告标题"
            ><el-input v-model="form.title" maxlength="100" /></el-form-item
          ><el-form-item label="公告内容"
            ><el-input
              v-model="form.content"
              type="textarea"
              :rows="6"
              maxlength="3000" /></el-form-item></template
        ><el-form-item label="启用"><el-switch v-model="form.active" /></el-form-item></el-form
      ><template #footer
        ><el-button @click="formDialog = false">取消</el-button
        ><el-button type="primary" :loading="busy" @click="saveForm">保存</el-button></template
      ></el-dialog
    >
  </div>
</template>
