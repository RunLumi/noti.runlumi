import type { PluralMessage } from './messages.en';
import type { ledgerEn } from './messages.ledger.en';

/**
 * Vietnamese copy for the per-attempt history, duplicate disclosure, the automatic pause and
 * "gửi lại tất cả" (ADR 0023); same register and glossary as `messages.vi.ts`. Noti cannot tell
 * whether a destination showed a message twice, so the copy says "có thể". Not reviewed by a
 * native-speaking editor.
 */
export const ledgerVi = {
  'attempts.title': 'Từng lần thử',
  'attempts.note':
    'Mỗi dòng là một lần Noti thử gửi hoặc chờ thay vì gửi, từ cũ đến mới. Noti chỉ giữ một mã ngắn cho phản hồi của nơi nhận, không giữ nội dung phản hồi.',
  'attempts.empty':
    'Lượt gửi này được tạo trước khi Noti ghi lại từng lần thử, nên chỉ có phần tóm tắt ở trên.',
  'attempts.list': 'Các lần thử, từ cũ đến mới',
  'attempts.item': 'Lần thử {number}',
  'attempts.stoppedWaiting': 'Đã ngừng chờ',
  'attempts.waited': 'Đã chờ, chưa gửi gì',
  'attempts.outcome.delivered': 'Đã gửi',
  'attempts.outcome.accepted': 'Đã được chấp nhận, chưa xác nhận',
  'attempts.outcome.retry_scheduled': 'Không thành công, sẽ thử lại',
  'attempts.outcome.dead_lettered': 'Không thành công, đã dừng',
  'attempts.outcome.deferred': 'Tạm giữ lại',
  'attempts.statusClass.2xx': 'Nơi nhận báo đã thành công',
  'attempts.statusClass.3xx': 'Nơi nhận chuyển hướng yêu cầu',
  'attempts.statusClass.4xx': 'Nơi nhận từ chối yêu cầu',
  'attempts.statusClass.5xx': 'Nơi nhận gặp lỗi',
  'attempts.statusClass.timeout': 'Không có phản hồi kịp lúc',
  'attempts.statusClass.network': 'Noti không kết nối được',
  'attempts.statusClass.none': 'Chưa gửi yêu cầu nào',
  'attempts.waitedTimes': {
    other: 'Đã chờ, rồi chờ thêm {count} lần nữa. Chưa gửi gì.',
  },
  'attempts.reason.circuit_open_timeout':
    'Đã ngừng chờ: nơi nhận liên tục lỗi hơn một ngày. Hãy gửi lại khi nơi nhận hoạt động.',
  'attempts.reason.destination_paced_timeout':
    'Đã ngừng chờ: nơi nhận liên tục yêu cầu Noti gửi chậm lại hơn một ngày. Hãy gửi lại sau.',
  'attempts.reason.claim_expired':
    'Một tiến trình đã dừng giữa chừng khi đang gửi, nên lần thử này có thể đã đến nơi nhận.',
  'attempts.duration': 'Mất {ms} ms',
  'attempts.retryAfter': 'Nơi nhận yêu cầu Noti chờ {seconds} giây.',
  'attempts.possibleDuplicate': 'Nơi nhận có thể đã nhận được tin này rồi.',
  'attempts.code': 'Mã {code}',
  'attempts.reason.circuit_open': 'Tự động tạm dừng vì nơi nhận liên tục lỗi.',
  'attempts.reason.destination_paced': 'Đã chờ vì nơi nhận yêu cầu Noti gửi chậm lại.',
  'attempts.reason.workspace_paused':
    'Đã chờ vì không gian làm việc này gửi tới Discord nhiều yêu cầu bị từ chối hoặc bị giới hạn hơn phần cho phép. Chưa có gì được gửi.',
  'attempts.reason.platform_paused_timeout':
    'Đã ngừng chờ: Noti tạm dừng Discord cho mọi người hơn một ngày. Hãy gửi lại sau.',
  'attempts.reason.workspace_paused_timeout':
    'Đã ngừng chờ: không gian làm việc này vượt phần yêu cầu Discord cho phép hơn một ngày. Hãy sửa các webhook Discord bị lỗi rồi gửi lại.',
  'attempts.reason.platform_paused':
    'Đã chờ vì Noti tạm dừng gửi tới dịch vụ này cho mọi không gian làm việc trong lúc nó phục hồi. Chưa có gì được gửi.',

  'delivery.detail.possibleDuplicate.title': 'Tin này có thể đã đến nhiều lần',
  'delivery.detail.possibleDuplicate.body':
    'Một lần thử trước không nhận được phản hồi rõ ràng, nên Noti đã thử lại. Nơi nhận có thể đã hiển thị tin hai lần. Noti không thể biết, và không hứa rằng điều đó không xảy ra.',
  'delivery.detail.suppressed.title': 'Không gửi lại',
  'delivery.detail.suppressed.duplicate':
    'Nguồn đã gửi sự kiện này nhiều lần. Noti giữ lần đầu và ghi lại lần lặp này thay vì gửi lại.',
  'delivery.detail.suppressed.claim_conflict':
    'Một tiến trình khác đang gửi tin này, nên Noti không gửi lần thứ hai.',
  'delivery.detail.suppressed.provider_idempotency': 'Nơi nhận nhận ra đây là tin nó đã có.',
  'delivery.detail.suppressed.originalFailed':
    'Lượt gửi đầu tiên của sự kiện này đã thất bại. Hãy gửi lại lượt đó: lần lặp này không được gửi.',
  'delivery.detail.suppressed.of': 'Lặp lại của lượt gửi {id}',
  'delivery.detail.suppressed.open': 'Xem lượt gửi đầu tiên',
  'delivery.detail.paused.circuit_open':
    'Tự động tạm dừng vì nơi nhận liên tục lỗi. Noti sẽ tự thử lại. Không có gì bị mất, và không có gì bị tắt.',
  'delivery.detail.paused.destination_paced':
    'Đang chờ vì nơi nhận yêu cầu Noti gửi chậm lại. Noti sẽ gửi ngay khi hết thời gian đó.',

  'delivery.detail.paused.platform_paused':
    'Đang chờ vì Noti tạm dừng gửi tới dịch vụ này cho mọi không gian làm việc trong một lúc. Noti sẽ tự gửi sau đó. Không có gì bị mất, và không có gì bị tắt.',

  'delivery.detail.paused.workspace_paused':
    'Đang chờ vì không gian làm việc này gửi tới Discord quá nhiều yêu cầu bị từ chối hoặc bị giới hạn. Noti làm chậm không gian này để bảo vệ mọi người, và sẽ tự thử lại. Hãy kiểm tra các webhook Discord còn tồn tại.',

  'health.open.title': 'Tự động tạm dừng',
  'health.open.body':
    'Nơi nhận này lỗi nhiều lần liên tiếp, nên Noti tạm ngừng gửi một lúc thay vì dồn dập gửi. Không có gì bị mất: các lượt gửi chờ, và Noti thử lại {time}. Noti không bao giờ tự tắt một tích hợp.',
  'health.halfOpen.title': 'Đang kiểm tra nơi nhận',
  'health.halfOpen.body':
    'Noti đang gửi một tin để xem {destination} đã hoạt động lại chưa. Các tin còn lại chờ kết quả.',
  'health.paced.title': 'Bị nơi nhận yêu cầu gửi chậm lại',
  'health.paced.body': '{destination} yêu cầu Noti gửi chậm lại. Các lượt gửi chờ đến {time} rồi tiếp tục.',
  'health.waiting': 'Xem các lượt gửi đang chờ',

  'bulk.button': 'Gửi lại tất cả lượt thất bại',
  'bulk.buttonFor': 'Gửi lại tất cả lượt thất bại của {name}',
  'bulk.title': 'Gửi lại các lượt gửi thất bại',
  'bulk.loading': 'Đang đếm các lượt gửi thất bại…',
  'bulk.none':
    'Không có lượt gửi thất bại nào để gửi lại cho lựa chọn này. Các lượt của tích hợp đang tạm dừng hoặc đã xóa, hoặc đã mất tin gốc, không được tính.',
  'bulk.preview': {
    other: '{count} lượt gửi thất bại sẽ được gửi lại dưới dạng lượt gửi mới.',
  },
  'bulk.scope.integration': 'Cho {name}.',
  'bulk.scope.all': 'Cho mọi tích hợp trong không gian làm việc này khớp với bộ lọc ở trên.',
  'bulk.more': {
    other:
      'Còn {count} lượt nữa đang chờ. Noti gửi tối đa {bound} lượt mỗi lần: hãy chạy lại để gửi phần còn lại.',
  },
  'bulk.moreMany':
    'Còn rất nhiều lượt nữa. Noti gửi tối đa {bound} lượt mỗi lần: hãy chạy lại để gửi phần còn lại.',
  'bulk.warning':
    'Các lượt thất bại vẫn nằm trong nhật ký. Nơi nhận có thể nhận một tin nhiều lần. Nếu chưa khắc phục nguyên nhân, chúng sẽ lại thất bại.',
  'bulk.typed.label': 'Nhập {count} để xác nhận',
  'bulk.typed.hint': 'Thao tác này gửi nhiều tin nhắn, nên Noti yêu cầu bạn nhập con số.',
  'bulk.confirm': 'Gửi lại',
  'bulk.cancel': 'Hủy',
  'bulk.sending': 'Đang gửi…',
  'bulk.done': {
    other: 'Đã xếp hàng {count} lượt gửi mới. Chúng xuất hiện trong nhật ký ngay khi Noti gửi.',
  },
  'bulk.done.already': { other: '{count} lượt đã được gửi lại trước đó.' },
  'bulk.done.refused': {
    other: '{count} lượt không gửi lại được: tích hợp đã thay đổi hoặc không còn tin gốc.',
  },
  'bulk.done.more': { other: 'Còn {count} lượt nữa chờ ở lượt sau.' },
  'bulk.stale': 'Danh sách đã thay đổi từ lúc bạn xem, nên chưa gửi gì. Hãy xem lại con số mới rồi thử lại.',
  'bulk.recount': 'Đếm lại',
} as const satisfies Record<keyof typeof ledgerEn, string | PluralMessage>;
