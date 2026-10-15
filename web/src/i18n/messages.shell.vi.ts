import type { PluralMessage } from './messages.en';
import type { shellEn } from './messages.shell.en';

/**
 * Vietnamese copy for the detail pages and the Destinations health page (ADR 0056). Same register
 * and glossary as `messages.vi.ts`: "bạn", short active sentences, "nơi nhận" for a destination,
 * product names and developer terms (webhook URL) left in English.
 */
export const shellVi = {
  // --- Navigation and route titles ---------------------------------------------
  'nav.destinations': 'Tình trạng nơi nhận',
  'route.title.delivery': 'Lượt gửi',
  'route.title.source': 'Nguồn',
  'route.title.destinations': 'Tình trạng nơi nhận',

  // --- Delivery page (/activity/:id) -------------------------------------------
  'delivery.page.eyebrow': 'LƯỢT GỬI',
  'delivery.page.back': 'Tất cả hoạt động',
  'delivery.page.loading': 'Đang tải lượt gửi này…',
  'delivery.page.error.title': 'Chúng tôi không tải được lượt gửi này.',
  'delivery.page.retry': 'Thử lại',
  'delivery.detail.openPage': 'Mở thành trang riêng',
  'delivery.detail.openPageHint':
    'Trang này có địa chỉ riêng, nên bạn có thể đánh dấu hoặc dán nó vào câu trả lời.',

  // --- Source page (/sources/:id) ----------------------------------------------
  'sources.detail.eyebrow': 'NGUỒN',
  'sources.detail.back': 'Tất cả nguồn',
  'sources.detail.loading': 'Đang tải nguồn này…',
  'sources.detail.error.title': 'Chúng tôi không tải được nguồn này.',
  'sources.detail.retry': 'Thử lại',
  'sources.card.open': 'Mở trang',
  'sources.card.openLabel': 'Mở trang của {name}',

  // --- Destinations health (/destinations) -------------------------------------
  'destinations.eyebrow': 'NƠI NHẬN',
  'destinations.title': 'Tình trạng nơi nhận',
  'destinations.description':
    'Mỗi tích hợp gửi đến đâu, và lúc này Noti có đang gửi đến đó không. Mọi trạng thái trên trang này là trạng thái máy chủ báo khi trang được tải.',
  'destinations.loading': 'Đang tải danh sách nơi nhận…',
  'destinations.empty.title': 'Chưa có nơi nhận nào',
  'destinations.empty.body':
    'Nơi nhận được thêm cùng với một tích hợp. Khi đã có tích hợp, nơi nhận và tình trạng của nó sẽ hiện ở đây.',
  'destinations.error.title': 'Chúng tôi không tải được danh sách nơi nhận.',
  'destinations.retry': 'Thử lại',
  'destinations.count': { other: '{count} nơi nhận' } satisfies PluralMessage,
  'destinations.tableLabel': 'Các nơi nhận và tình trạng của chúng',
  'destinations.col.integration': 'Tích hợp',
  'destinations.col.destination': 'Gửi đến',
  'destinations.col.switch': 'Công tắc',
  'destinations.col.sending': 'Việc gửi',
  'destinations.col.failures': 'Số lần lỗi liên tiếp',
  'destinations.col.credentials': 'Webhook URL',
  'destinations.col.open': 'Cài đặt',
  'destinations.switch.on': 'Đang bật',
  'destinations.switch.off': 'Đã tắt',
  'destinations.sending.closed': 'Đang gửi bình thường',
  'destinations.sending.open': 'Tự động tạm dừng',
  'destinations.sending.openUntil': 'Thử lại {time}',
  'destinations.sending.halfOpen': 'Đang kiểm tra nơi nhận',
  'destinations.sending.paced': 'Gửi chậm lại đến {time}',
  'destinations.timesOpened': { other: 'Đã tự động tạm dừng {count} lần' } satisfies PluralMessage,
  'destinations.notReported': 'Chưa có báo cáo',
  'destinations.notReported.note':
    '“Chưa có báo cáo” nghĩa là máy chủ không có bản ghi tình trạng cho nơi nhận đó. Bản ghi bắt đầu từ lần lỗi đầu tiên hoặc lần đầu nơi nhận yêu cầu gửi chậm lại, và được xóa sau một thời gian yên ổn, nên nó không chứng minh tin nhắn đã đến nơi. Hãy mở tích hợp để xem các lượt gửi gần đây.',
  'destinations.breakerNote':
    'Noti tự tạm dừng việc gửi khi một nơi nhận lỗi liên tục, rồi thử lại sau. Noti không bao giờ tắt một tích hợp; chỉ con người mới tắt.',
  'destinations.credentials.ok': 'Đã lưu',
  'destinations.credentials.legacy': 'Cần nhập lại',
  'destinations.credentials.quarantined': 'Không đọc được: không gửi gì',
  'destinations.credentials.revoked': 'Đã thu hồi: không gửi gì',
} as const satisfies Record<keyof typeof shellEn, string | PluralMessage>;
