import type { PluralMessage } from './messages.en';
import type { noiseEn } from './messages.noise.en';

/**
 * Vietnamese copy for quiet hours, grouping, summaries and resolved notices (ADR 0016); same
 * register and glossary as `messages.vi.ts`. An update waiting to be sent is "đã lưu" (saved),
 * because the filters copy already uses "giữ lại" for an update that is NOT sent. Not reviewed
 * by a native-speaking editor.
 */
export const noiseVi = {
  'noise.title': 'Giờ yên tĩnh và bản tóm tắt',
  'noise.intro':
    'Giữ nhóm chat bớt ồn mà không bỏ lỡ gì. Cập nhật không bao giờ bị bỏ: chúng được lưu lại và gửi gộp vào lúc sau.',
  'noise.honest':
    'Với mỗi cập nhật đã lưu, Noti chỉ giữ một tiêu đề ngắn, một liên kết và một dòng tóm tắt, không giữ chính sự kiện, và xóa chúng sau khi gửi vài ngày.',

  'noise.quiet.title': 'Giờ yên tĩnh',
  'noise.quiet.hint': 'Lưu các cập nhật không khẩn cấp qua đêm và gửi gộp khi giờ yên tĩnh kết thúc.',
  'noise.quiet.enable': 'Lưu cập nhật trong giờ yên tĩnh',
  'noise.quiet.start': 'Giờ yên tĩnh bắt đầu',
  'noise.quiet.end': 'Giờ yên tĩnh kết thúc',
  'noise.timezone': 'Múi giờ',
  'noise.timezone.hint': 'Mọi giờ đều tính theo múi giờ này, kể cả khi đổi giờ mùa hè.',

  'noise.group.title': 'Gộp các đợt cập nhật dồn dập',
  'noise.group.hint':
    'Chờ khoảng này trước khi gửi, để nhiều cập nhật về cùng một pull request, issue hoặc branch đến thành một tin nhắn có kèm số lượng.',
  'noise.group.label': 'Gộp các cập nhật trong',
  'noise.group.w0': 'Tắt: gửi từng cập nhật',
  'noise.group.w60': '1 phút',
  'noise.group.w300': '5 phút',
  'noise.group.w900': '15 phút',
  'noise.group.w3600': '1 giờ',

  'noise.digest.title': 'Bản tóm tắt',
  'noise.digest.hint': 'Lưu các cập nhật không khẩn cấp và gửi thành một bản tóm tắt theo lịch.',
  'noise.digest.label': 'Gửi cập nhật không khẩn cấp',
  'noise.digest.off': 'Ngay lập tức',
  'noise.digest.hourly': 'Thành bản tóm tắt mỗi giờ',
  'noise.digest.daily': 'Thành bản tóm tắt mỗi ngày một lần',
  'noise.digest.at': 'Giờ gửi bản tóm tắt hằng ngày',

  'noise.resolution.title': 'Thông báo đã khắc phục',
  'noise.resolution.label': 'Báo cho tôi khi workflow đang lỗi chạy thành công trở lại',
  'noise.resolution.hint':
    'Gửi một tin “Đã khắc phục” ngắn khi workflow từng lỗi trên một branch chạy thành công trên chính branch đó.',
  'noise.resolution.needsFailures':
    'Hãy chọn “workflow run thất bại” hoặc “hết thời gian” trong các cập nhật của tích hợp này để dùng tính năng này.',

  'noise.preview.title': 'Kết quả sẽ như sau',
  'noise.preview.none': 'Mọi cập nhật được gửi ngay.',
  'noise.preview.quiet': 'Trong giờ yên tĩnh, Noti sẽ giữ cập nhật lại và gửi một bản tóm tắt lúc {time}.',
  'noise.preview.urgent': 'Lỗi và các cập nhật khẩn cấp khác luôn được gửi ngay, kể cả trong giờ yên tĩnh.',
  'noise.preview.group':
    'Các cập nhật về cùng một việc đến trong vòng {window} được gửi thành một tin nhắn có kèm số lượng.',
  'noise.preview.digestHourly':
    'Các cập nhật không khẩn cấp được lưu lại và gửi thành một bản tóm tắt mỗi giờ.',
  'noise.preview.digestDaily':
    'Các cập nhật không khẩn cấp được lưu lại và gửi thành một bản tóm tắt mỗi ngày lúc {time}.',
  'noise.preview.resolution':
    'Khi workflow đang lỗi chạy thành công trở lại, Noti gửi một tin “Đã khắc phục”.',

  'noise.status.title': 'Đang chờ gửi',
  'noise.status.loading': 'Đang kiểm tra những gì đang chờ…',
  'noise.status.none': 'Hiện không có gì đang chờ.',
  'noise.status.waiting': {
    other: '{count} cập nhật đang chờ. Lần gửi tiếp theo: {when}.',
  } satisfies PluralMessage,
  'noise.status.error': 'Chúng tôi không kiểm tra được những gì đang chờ. Không có gì bị mất.',

  'noise.invalid.title': 'Không đọc được các cài đặt đã lưu',
  'noise.invalid.body':
    'Cập nhật đang được gửi bình thường. Lưu cài đặt mới sẽ thay thế các cài đặt không đọc được.',
  'noise.newer.title': 'Được lưu bởi phiên bản Noti mới hơn',
  'noise.newer.body':
    'Phiên bản này bỏ qua các cài đặt đó và gửi cập nhật bình thường. Lưu ở đây sẽ thay thế chúng.',

  'noise.save': 'Lưu cài đặt',
  'noise.saving': 'Đang lưu…',
  'noise.saved': 'Đã lưu cài đặt.',
  'noise.clear': 'Tắt tất cả',
  'noise.unsaved': 'Có thay đổi chưa lưu',

  'noise.error.time': 'Dùng giờ dạng 22:00.',
  'noise.error.sameTime': 'Giờ bắt đầu và kết thúc phải khác nhau.',
  'noise.error.timezone': 'Hãy chọn một múi giờ trong danh sách.',
  'noise.error.resolution':
    'Hãy chọn “workflow run thất bại” hoặc “hết thời gian” trong các cập nhật của tích hợp này trước.',
  'noise.error.generic': 'Không lưu được các cài đặt này. Hãy kiểm tra các trường được đánh dấu.',

  'noise.log.held': 'Đã lưu để gửi sau',
  'noise.log.quiet_hours': 'Đã lưu trong giờ yên tĩnh và gửi trong một bản tóm tắt.',
  'noise.log.digest': 'Đã lưu cho bản tóm tắt tiếp theo.',
  'noise.log.grouped': 'Đã gộp với các cập nhật tương tự thành một tin nhắn.',
  'noise.log.critical_bypass': 'Khẩn cấp: gửi ngay, bỏ qua giờ yên tĩnh, bản tóm tắt và việc gộp tin.',
  'noise.log.hold_capacity': 'Gửi ngay vì đã có quá nhiều cập nhật đang chờ.',
} as const satisfies Record<keyof typeof noiseEn, string | PluralMessage>;
