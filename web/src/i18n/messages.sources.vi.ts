import type { en, PluralMessage } from './messages.en';
import type { providersEn } from './messages.providers.en';

/**
 * Vietnamese copy for generic sources (ADR 0012). "Source" is "nguồn"; a connected Lark, Slack
 * or Teams group is a "chat". Protocol vocabulary people will search for or paste into code
 * (webhook-id, webhook-timestamp, webhook-signature, HTTP 409, Standard Webhooks, HMAC-SHA256,
 * curl, openssl, Node.js, JSON, POST) is left in English exactly as the sender must write it.
 */
type SourceId = Exclude<
  Extract<
    keyof typeof en,
    | `sources.${string}`
    | 'integration.source'
    | 'integration.source.value'
    | 'integration.source.manage'
    | 'settings.details.source'
  >,
  keyof typeof providersEn
>;

export const sourcesVi = {
  'sources.nav': 'Nguồn',
  'sources.eyebrow': 'KẾT NỐI',
  'sources.title': 'Nguồn',
  'sources.description':
    'Nguồn là hệ thống của riêng bạn gửi sự kiện đến Noti. Mỗi nguồn có một signing secret riêng tư để chứng minh sự kiện thật sự đến từ bạn, và mọi sự kiện nguồn đó nhận được đều có thể được gửi đến một chat Lark, Slack, Microsoft Teams hoặc Discord, hoặc đến webhook của riêng bạn.',
  'sources.loading': 'Đang tải danh sách nguồn…',
  'sources.count': { other: '{count} nguồn' },
  'sources.listLabel': 'Các nguồn trong không gian làm việc này',
  'sources.empty.title': 'Chưa có nguồn nào',
  'sources.empty.body':
    'Hãy thêm một nguồn để nhận một địa chỉ riêng tư và một signing secret. Sau đó hệ thống của bạn có thể gửi (POST) một sự kiện JSON nhỏ mỗi khi có việc xảy ra, như một lần deploy lỗi, một đơn hàng mới hay một tác vụ vừa chạy xong.',
  'sources.error.title': 'Chúng tôi không tải được danh sách nguồn.',
  'sources.error.body': 'Chưa có gì bị thay đổi. Các nguồn đã lưu của bạn không bị ảnh hưởng.',
  'sources.retry': 'Thử lại',
  'sources.create.title': 'Thêm một nguồn',
  'sources.create.label': 'Tên nguồn',
  'sources.create.hint': 'Ví dụ “CI pipeline” hoặc “Dịch vụ thanh toán”.',
  'sources.create.submit': 'Tạo nguồn',
  'sources.create.submitting': 'Đang tạo…',
  'sources.create.failed': 'Nguồn chưa được tạo.',
  'sources.secret.created.title': 'Signing secret của {name}',
  'sources.secret.rotated.title': 'Signing secret mới của {name}',
  'sources.secret.warning':
    'Đây là lần duy nhất Noti hiển thị secret này. Hãy sao chép ngay và cất vào nơi quản lý secret của bạn. Noti không thể hiển thị lại; nếu bị mất, hãy đổi secret (rotate) để lấy một secret mới.',
  'sources.secret.rotatedNote':
    'Secret cũ đã ngừng hoạt động ngay lập tức. Hãy cập nhật bên gửi để dùng secret này; các sự kiện được ký bằng secret cũ sẽ bị từ chối.',
  'sources.secret.label': 'Signing secret',
  'sources.secret.copy': 'Sao chép secret',
  'sources.secret.copied': 'Đã sao chép',
  'sources.secret.copyFailed': 'Không sao chép được. Hãy chọn secret và tự sao chép.',
  'sources.secret.saved': 'Tôi đã lưu lại',
  'sources.card.endpoint': 'Endpoint URL',
  'sources.card.endpointHint':
    'Hệ thống của bạn gửi các yêu cầu POST có chữ ký đến đây. Địa chỉ này không phải là bí mật; chữ ký mới là thứ chứng minh ai đã gửi sự kiện.',
  'sources.card.copyUrl': 'Sao chép URL',
  'sources.card.lastReceived': 'Sự kiện gần nhất',
  'sources.card.neverReceived': 'Chưa nhận được sự kiện nào',
  'sources.card.chats': 'Gửi đến',
  'sources.card.chatsCount': { other: '{count} chat' },
  'sources.card.chatsNone': 'Chưa có chat nào: sự kiện vẫn được nhận nhưng không được gửi đi đâu.',
  'sources.card.rotated': 'Đã đổi secret',
  'sources.card.reused': {
    other: '{count} sự kiện bị từ chối vì id của chúng bị dùng lại.',
  },
  'sources.card.reusedHelp':
    'Mỗi sự kiện cần một webhook-id riêng. Một yêu cầu dùng lại một id với nội dung khác sẽ bị từ chối với HTTP 409 để không bao giờ bị bỏ qua một cách im lặng. Hãy cấp id mới cho mỗi sự kiện; chỉ thử lại cùng một sự kiện với cùng id và cùng nội dung.',
  'sources.adminOnly':
    'Chỉ quản trị viên không gian làm việc mới đổi hoặc thu hồi được secret, hoặc xóa nguồn.',
  'sources.card.created': 'Thời điểm tạo',
  'sources.toggle.label': 'Nhận sự kiện',
  'sources.toggle.labelFor': 'Nhận sự kiện cho {name}',
  'sources.toggle.on': 'Đang nhận sự kiện',
  'sources.toggle.off': 'Đã tạm dừng: sự kiện bị từ chối',
  'sources.toggle.saving': 'Đang lưu…',
  'sources.toggle.error': 'Chúng tôi không đổi được {name}. Nguồn vẫn đang {state}.',
  'sources.toggle.state.on': 'nhận sự kiện',
  'sources.toggle.state.off': 'tạm dừng',
  'sources.guide.summary': 'Gửi một sự kiện thử',
  'sources.guide.intro':
    'Sự kiện là JSON, được ký bằng secret của bạn theo phương pháp Standard Webhooks. Hãy đặt secret vào một biến môi trường trước để nó không nằm lại trong lịch sử lệnh của shell.',
  'sources.guide.formatTitle': 'Định dạng sự kiện',
  'sources.guide.format':
    'Bắt buộc: type (ví dụ deploy.failed) và title. Tùy chọn: summary, url (chỉ https, hiển thị dưới dạng liên kết, Noti không bao giờ tự mở), severity (info, warning, error hoặc critical), actor, và tối đa 10 trường đơn giản. Kích thước nội dung tối đa là 256 KiB.',
  'sources.guide.signTitle': 'Cách ký sự kiện',
  'sources.guide.sign':
    'Gửi ba header: webhook-id (duy nhất cho mỗi sự kiện), webhook-timestamp (tính bằng giây; phải nằm trong 5 phút) và webhook-signature (v1, một dấu phẩy, rồi HMAC-SHA256 dạng base64 của “id.timestamp.body”, dùng secret đã giải mã làm khóa). Id phải duy nhất cho mỗi sự kiện: lặp lại một webhook-id với cùng nội dung là an toàn (Noti chỉ nhận sự kiện đó một lần), nhưng dùng lại nó cho nội dung khác sẽ bị từ chối với HTTP 409.',
  'sources.guide.bash': 'Shell (curl và openssl)',
  'sources.guide.node': 'Node.js',
  'sources.guide.copy': 'Sao chép ví dụ',
  'sources.guide.copied': 'Đã sao chép',
  'sources.guide.copyFailed': 'Không sao chép được. Hãy chọn ví dụ và tự sao chép.',
  'sources.guide.result':
    'Một yêu cầu thành công trả về 202. 401 nghĩa là chữ ký hoặc timestamp sai; 400 chỉ ra trường không hợp lệ.',
  'sources.chat.summary': 'Gửi các sự kiện này đến một chat',
  'sources.chat.intro':
    'Mọi sự kiện mà nguồn này nhận được sẽ được đăng vào chat bạn kết nối. Hãy kết nối nhiều chat để đăng vào nhiều nơi.',
  'sources.chat.name': 'Tên',
  'sources.chat.nameHint': 'Cách kết nối này hiện trong danh sách Tích hợp của bạn.',
  'sources.chat.destination': 'Ứng dụng chat',
  'sources.chat.submit': 'Kết nối chat',
  'sources.chat.submitting': 'Đang kết nối…',
  'sources.chat.done': 'Đã kết nối. Từ giờ các sự kiện mới từ {name} sẽ được gửi đến {destination}.',
  'sources.chat.failed': 'Chat chưa được kết nối.',
  'sources.rotate.open': 'Đổi secret…',
  'sources.rotate.title': 'Đổi secret của {name}?',
  'sources.rotate.body':
    'Một secret mới được tạo và chỉ hiển thị một lần. Secret hiện tại ngừng hoạt động ngay lập tức, nên các sự kiện từ hệ thống của bạn sẽ bị từ chối (401) cho đến khi bạn cập nhật. Không có khoảng thời gian dùng song song.',
  'sources.rotate.keep': 'Giữ secret hiện tại',
  'sources.rotate.confirm': 'Đổi secret',
  'sources.rotate.rotating': 'Đang đổi…',
  'sources.rotate.failed': 'Secret chưa được đổi.',
  'sources.delete.open': 'Xóa nguồn…',
  'sources.delete.title': 'Xóa {name}?',
  'sources.delete.body': {
    other:
      'Endpoint ngừng hoạt động ngay và signing secret bị hủy. {count} chat đã kết nối sẽ bị xóa cùng, kể cả webhook URL đã lưu cho chúng. Không thể hoàn tác.',
  },
  'sources.delete.bodyNoChats': 'Endpoint ngừng hoạt động ngay và signing secret bị hủy. Không thể hoàn tác.',
  'sources.delete.confirmLabel': 'Nhập {name} để xác nhận',
  'sources.delete.keep': 'Giữ nguồn',
  'sources.delete.confirm': 'Xóa nguồn',
  'sources.delete.deleting': 'Đang xóa…',
  'sources.delete.failed': 'Nguồn chưa được xóa.',
  'sources.card.fingerprint': 'Dấu vân tay',
  'sources.card.fingerprintHint':
    'Một mã ngắn tính từ secret đã lưu, để bạn biết secret có đổi hay không mà Noti không cần hiển thị nó. Mã này không phải là secret và không thể đổi ngược lại thành secret.',
  'sources.card.fingerprintNone':
    'Không có dấu vân tay cho secret này: nó được lưu trước khi có dấu vân tay, hoặc hệ thống này chưa có khóa tạo dấu vân tay.',
  'sources.card.credential': 'Secret đã lưu',
  'sources.card.credentialRevoked': 'Đã thu hồi',
  'sources.card.encryptedCopy': 'Bản mã hóa',
  'sources.card.copyDestroyed':
    'Đã hủy trong cơ sở dữ liệu đang chạy nên Noti không đọc được nữa. Lịch sử cơ sở dữ liệu của Cloudflare có thể giữ một bản trong tối đa 30 ngày.',
  'sources.card.copyDestroying':
    'Đang được hủy. Nó không còn được dùng vào việc gì và sẽ bị hủy trong vài phút sau khi thu hồi.',
  'sources.card.copyKept':
    'Chưa bị hủy: vì không có dấu vân tay, Noti giữ nó cho đến khi người vận hành hủy. Nó không được dùng vào việc gì.',
  'sources.revoked.title': 'Đã thu hồi secret',
  'sources.revoked.body':
    'Nguồn này từ chối mọi sự kiện cho đến khi quản trị viên không gian làm việc đổi secret và hệ thống của bạn được cập nhật để dùng secret mới.',
  'sources.revoked.providerTitle': 'Đã thu hồi thông tin xác thực',
  'sources.revoked.providerBody':
    'Nguồn này từ chối mọi sự kiện cho đến khi quản trị viên không gian làm việc dán thông tin xác thực mới từ {provider}. Hãy dán thông tin mới, không phải thông tin đã thu hồi.',
  'sources.toggle.revoked': 'Tắt: secret đã bị thu hồi',
  'sources.revoke.open': 'Thu hồi secret…',
  'sources.revoke.title': 'Thu hồi secret của {name}?',
  'sources.revoke.body':
    'Noti tắt nguồn này ngay và từ chối mọi sự kiện, dù có ký bằng secret này hay không. Bản mã hóa của nó bị hủy vài phút sau đó, nên Noti không đọc lại được; lịch sử cơ sở dữ liệu của Cloudflare có thể giữ một bản trong tối đa 30 ngày. Không thể hoàn tác: để nhận sự kiện lại, hãy đổi secret và cập nhật hệ thống của bạn để dùng secret mới.',
  'sources.revoke.confirm': 'Thu hồi secret',
  'sources.revoke.done': 'Đã thu hồi secret. {name} từ chối mọi sự kiện cho đến khi bạn đổi secret.',
  'sources.revoke.provider.open': 'Thu hồi thông tin xác thực…',
  'sources.revoke.provider.title': 'Thu hồi thông tin xác thực của {name}?',
  'sources.revoke.provider.body':
    'Noti tắt nguồn này ngay và từ chối mọi sự kiện từ {provider}. Bản mã hóa của nó bị hủy vài phút sau đó, nên Noti không đọc lại được; lịch sử cơ sở dữ liệu của Cloudflare có thể giữ một bản trong tối đa 30 ngày. Không thể hoàn tác: để nhận sự kiện lại, hãy tạo thông tin xác thực mới trong {provider} và dán vào đây. Nếu nó đã bị lộ, hãy thay nó cả trong {provider}.',
  'sources.revoke.provider.confirm': 'Thu hồi thông tin xác thực',
  'sources.revoke.provider.done':
    'Đã thu hồi thông tin xác thực. {name} từ chối mọi sự kiện cho đến khi bạn dán thông tin xác thực mới.',
  'sources.rotate.revokedBody':
    'Một secret mới được tạo và hiển thị một lần, và nguồn được bật lại. Hãy cập nhật hệ thống của bạn để dùng nó; secret đã thu hồi vẫn bị từ chối.',
  'sources.rotate.provider.revokedBody':
    'Dán thông tin xác thực mới bạn đã tạo trong {provider}. Lưu lại sẽ bật nguồn trở lại. Đừng dán lại thông tin đã thu hồi.',
  'integration.source': 'Nguồn',
  'integration.source.value': 'Sự kiện từ hệ thống của riêng bạn',
  'integration.source.manage': 'Quản lý nguồn',
  'settings.details.source':
    'Tích hợp này gửi mọi sự kiện từ nguồn của nó. Để đổi những gì nó nhận, hãy đổi hoặc tạm dừng nguồn.',
} as const satisfies Record<SourceId, string | PluralMessage>;
