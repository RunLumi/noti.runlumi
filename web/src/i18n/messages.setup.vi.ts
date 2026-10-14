import type { setupEn } from './messages.setup.en';

/**
 * Vietnamese copy for "Send a test notification" and the setup-progress card (ADR 0018); same
 * register and glossary as `messages.vi.ts`. "Đã gửi" means the destination confirmed it;
 * "đã được chấp nhận" means it did not say either way. Not reviewed by a native-speaking editor.
 */
export const setupVi = {
  'test.title': 'Gửi thông báo thử',
  'test.hint':
    'Noti gửi một tin nhắn ngắn được đánh dấu là thử qua tích hợp này, theo đúng cách gửi các cập nhật thật, rồi cho bạn biết {destination} đã phản hồi gì.',
  'test.button': 'Gửi thông báo thử',
  'test.buttonAgain': 'Gửi thêm một thông báo thử',
  'test.buttonShort': 'Gửi thử',
  'test.buttonFor': 'Gửi thông báo thử cho {name}',
  'test.sending': 'Đang gửi thông báo thử…',
  'test.waiting': 'Đang chờ {destination} phản hồi…',
  'test.resultLabel': 'Kết quả gửi thử',

  'test.sent.title': 'Đã gửi thử',
  'test.sent.body': '{destination} xác nhận đã nhận được tin nhắn.',
  'test.accepted.title': 'Thông báo thử đã được chấp nhận, chưa được xác nhận',
  'test.accepted.body':
    '{destination} đã chấp nhận tin nhắn nhưng không cho Noti biết tin có được hiển thị hay không. Thường tin xuất hiện trong vòng một phút.',
  'test.accepted.teams':
    'Microsoft Teams chấp nhận tin nhắn từ workflow mà không xác nhận là đã đăng, nên Noti không thể biết tin đã xuất hiện. Hãy mở cuộc trò chuyện hoặc kênh mà workflow của bạn đăng vào. Nếu một phút sau vẫn chưa thấy, hãy mở lịch sử chạy của workflow trong Power Automate.',
  'test.failed.title': 'Thông báo thử chưa gửi được',
  'test.failed.fix': 'Thay URL webhook',
  'test.retrying.title': 'Lần thử đầu tiên chưa được',
  'test.retrying.body':
    'Noti đang tự thử lại. Một phút nữa hãy mở Hoạt động để xem kết quả; bạn không cần làm gì thêm.',
  'test.timeout.title': 'Vẫn đang chờ phản hồi',
  'test.timeout.body':
    'Lần này lâu hơn bình thường. Thông báo thử không bị mất: kết quả sẽ hiện trong Hoạt động.',
  'test.viewActivity': 'Xem trong Hoạt động',

  'test.where.title': 'Xem ở đâu',
  'test.where.lark': 'Hãy xem trong nhóm Lark nơi bạn đã thêm bot tùy chỉnh.',
  'test.where.slack': 'Hãy xem trong kênh Slack bạn đã chọn khi tạo webhook.',
  'test.where.teams': 'Hãy xem trong cuộc trò chuyện hoặc kênh Teams mà workflow của bạn đăng vào.',
  'test.where.discord': 'Hãy xem trong kênh Discord mà bạn đã tạo webhook cho.',
  'test.where.generic_webhook':
    'Hãy xem nhật ký của endpoint của bạn. Noti đã ký yêu cầu bằng khóa ký của bạn.',

  'test.blocked.paused': 'Tích hợp này đang tạm dừng. Hãy bật nó trước, rồi gửi thông báo thử.',
  'test.blocked.quarantined':
    'Noti đã ngừng dùng URL webhook đã lưu của tích hợp này. Hãy dán lại URL trong phần thông tin xác thực, rồi gửi thông báo thử.',
  'test.error.unavailable':
    'Hiện tại tích hợp này không nhận được thông báo thử. Nếu không gian làm việc đang được lên lịch xóa, hãy hủy việc đó trong Cài đặt trước. Nếu không, hãy tải lại trang và thử lại.',
  'test.error.inFlight': 'Một thông báo thử đang chạy cho tích hợp này. Hãy chờ kết quả rồi gửi thêm.',
  'test.error.rateLimited': 'Bạn đã gửi khá nhiều thông báo thử. Hãy chờ {seconds} giây rồi thử lại.',

  'delivery.testBadge': 'Thử',

  'wizard.step.test': 'Gửi thử (không bắt buộc)',
  'wizard.test.title': 'Đã lưu “{name}”',
  'wizard.test.intro':
    'Bạn có thể gửi một tin nhắn thử ngay bây giờ để kiểm tra {destination} có nhận được không. Bước này không bắt buộc, và bạn có thể làm sau trong phần cài đặt của tích hợp.',
  'wizard.test.skip': 'Bỏ qua lúc này',
  'wizard.test.done': 'Đến trang tích hợp',

  'setup.title': 'Hoàn tất thiết lập',
  'setup.summary': 'Đã xong {done} trên {total} bước',
  'setup.honest': 'Noti tính điều này từ những gì đã thực sự xảy ra trong không gian làm việc của bạn.',
  'setup.listLabel': 'Các bước thiết lập',
  'setup.since': 'Từ {when}',
  'setup.action.send_test': 'Gửi thử',
  'setup.action.trigger_real_event': 'Mở Hoạt động',
} as const satisfies Record<keyof typeof setupEn, string>;
