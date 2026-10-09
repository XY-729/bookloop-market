import { DEV_LOGIN_ENABLED } from '../config';
export async function authorizePrivacy() {
  if (DEV_LOGIN_ENABLED) return;
  if (!wx.canIUse('requirePrivacyAuthorize')) {
    wx.showToast({ title: '请更新微信后再上传图片', icon: 'none' });
    throw new Error('Privacy API unavailable');
  }
  await new Promise<void>((resolve, reject) =>
    wx.requirePrivacyAuthorize({
      success: () => resolve(),
      fail: () => {
        wx.showToast({ title: '未同意隐私授权，未读取相册或相机', icon: 'none' });
        reject(new Error('Privacy authorization declined'));
      },
    }),
  );
}
