export async function api<T = any>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const token = sessionStorage.getItem('market-admin-token');
  const response = await fetch(`/v1${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const value = await response.json().catch(() => {
    throw new Error('服务连接中断，请刷新后重试');
  });
  if (!response.ok) {
    if (response.status === 401) sessionStorage.removeItem('market-admin-token');
    throw new Error(typeof value.message === 'string' ? value.message : '请求失败');
  }
  return value;
}
