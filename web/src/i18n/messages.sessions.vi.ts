import type { PluralMessage } from './messages.en';
import type { sessionsEn } from './messages.sessions.en';

/**
 * Vietnamese copy for "Where you are signed in" (ADR 0030); same register and glossary as `messages.vi.ts`.
 * Browser and system names stay in English. Not reviewed by a native-speaking editor.
 */
export const sessionsVi = {
  'sessions.title': 'Nơi bạn đang đăng nhập',
  'sessions.body':
    'Mọi trình duyệt hoặc thiết bị đang đăng nhập vào tài khoản của bạn. Nếu có thiết bị bạn không nhận ra, hãy đăng xuất nó và đổi mật khẩu.',
  'sessions.lifetime':
    'Một lần đăng nhập hết hạn sau {idleDays} ngày không sử dụng, và luôn hết hạn sau {maxDays} ngày kể từ lúc bạn đăng nhập.',
  'sessions.activityNote': 'Thời điểm hoạt động gần nhất được cập nhật khoảng một lần mỗi ngày.',
  'sessions.listLabel': 'Các thiết bị đang đăng nhập vào tài khoản của bạn',
  'sessions.loading': 'Đang tải danh sách thiết bị…',
  'sessions.error': 'Chúng tôi không tải được danh sách thiết bị. Chưa có gì bị thay đổi.',
  'sessions.retry': 'Thử lại',
  'sessions.current': 'Thiết bị này',
  'sessions.signedIn': 'Đăng nhập {date}',
  'sessions.lastActive': 'Hoạt động gần nhất {date}',
  'sessions.address': 'Địa chỉ {ip}',
  'sessions.addressUnknown': 'Không rõ địa chỉ',
  'sessions.device.both': '{browser} trên {os}',
  'sessions.device.browser': '{browser}',
  'sessions.device.os': '{os}',
  'sessions.device.unknown': 'Thiết bị không xác định',
  'sessions.revoke': 'Đăng xuất',
  'sessions.revokeFor': 'Đăng xuất {device}',
  'sessions.revoking': 'Đang đăng xuất…',
  'sessions.revokeOthers': 'Đăng xuất mọi thiết bị khác',
  'sessions.revokeOthersNone': 'Bạn không đăng nhập ở nơi nào khác.',
  'sessions.revokedOne': 'Thiết bị đó đã được đăng xuất.',
  'sessions.revokedOthers': { other: 'Đã đăng xuất {count} thiết bị khác.' } satisfies PluralMessage,
  'sessions.revokedNone': 'Không có thiết bị nào khác để đăng xuất.',
  'sessions.error.revoke': 'Chúng tôi không đăng xuất được thiết bị đó. Hãy thử lại.',
  'sessions.error.gone': 'Thiết bị đó đã được đăng xuất trước đó. Danh sách đã được làm mới.',
  'sessions.error.tooMany': 'Quá nhiều yêu cầu. Hãy đợi một phút rồi thử lại.',
} as const satisfies Record<keyof typeof sessionsEn, string | PluralMessage>;
