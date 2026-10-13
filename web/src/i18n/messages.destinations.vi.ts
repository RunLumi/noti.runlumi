import type { destinationsEn } from './messages.destinations.en';

/**
 * Vietnamese copy for the Discord and custom-webhook destinations (ADR 0014). Product and
 * provider names (Noti, Discord) and protocol vocabulary people will paste into code or search
 * for (webhook, URL, POST, JSON, 2xx, 429, 5xx, Standard Webhooks, webhook-id,
 * webhook-signature, @everyone, @here, HTTPS) stay in English. Menu labels in Discord's own
 * screens are the labels the person sees there.
 */
export const destinationsVi = {
  // --- Discord ------------------------------------------------------------
  'destination.discord': 'Discord',
  'destination.discord.where': 'Đăng vào kênh Discord mà bạn chọn.',
  'destination.discord.what':
    'Dùng một webhook mà bạn tạo cho một kênh. Noti không bao giờ nhắc @everyone, @here, vai trò hay cá nhân nào.',
  'destination.discord.urlHint':
    'Bắt đầu bằng https://discord.com/api/webhooks/. Bạn có thể thêm ?thread_id=… để đăng vào một thread.',
  'destination.discord.docs': 'Hướng dẫn của Discord về webhook',
  'destination.discord.step1':
    'Trong Discord, mở Server Settings, rồi Integrations, rồi Webhooks. Bạn cần quyền Manage Webhooks.',
  'destination.discord.step2': 'Chọn New Webhook, đặt tên, rồi chọn kênh mà nó sẽ đăng vào.',
  'destination.discord.step3': 'Chọn Copy Webhook URL.',
  'destination.discord.step4': 'Dán vào ô bên dưới. Noti chỉ chấp nhận các địa chỉ thuộc discord.com.',
  'destination.discord.noteDeleted':
    'Nếu webhook bị xóa trong Discord, Noti sẽ tạm dừng tích hợp này ngay sau lần lỗi đầu tiên thay vì thử lại. Discord hạn chế những bên cứ dùng một webhook đã bị xóa. Hãy dán một URL mới rồi bật lại tích hợp.',
  'destination.discord.noteMentions':
    'Một branch tên @everyone, hoặc một pull request nhắc đến một vai trò, chỉ hiện dưới dạng văn bản thường. Nó không thể thông báo cho ai.',
  'validation.webhookUrl.wrongHost.discord':
    'Đây không phải địa chỉ webhook của Discord. Địa chỉ phải bắt đầu bằng https://discord.com/api/webhooks/ và được sao chép đầy đủ từ Discord.',

  // --- Custom webhook -----------------------------------------------------
  'destination.generic_webhook': 'Webhook tùy chỉnh',
  'destination.generic_webhook.where': 'Đăng đến một endpoint HTTPS do bạn vận hành.',
  'destination.generic_webhook.what':
    'Gửi mỗi cập nhật dưới dạng JSON có chữ ký đến dịch vụ của riêng bạn. Dành cho người có thể viết một bộ nhận nhỏ.',
  'destination.generic_webhook.urlHint':
    'Một địa chỉ https:// công khai, ví dụ https://hooks.example.com/noti. Có thể chứa một đường dẫn hoặc query bí mật.',
  'destination.generic_webhook.docs': 'Đặc tả chữ ký Standard Webhooks',
  'destination.generic_webhook.step1':
    'Chạy một endpoint nhận POST với nội dung JSON và truy cập được từ internet công khai qua HTTPS (cổng 443).',
  'destination.generic_webhook.step2':
    'Sau khi lưu, Noti hiện một signing secret đúng một lần. Hãy dùng nó để kiểm tra header webhook-signature của mọi request, như đặc tả Standard Webhooks mô tả.',
  'destination.generic_webhook.step3':
    'Trả lời bằng mã trạng thái 2xx trong vòng 10 giây. 408, 429 và 5xx sẽ được thử lại. Các mã 4xx khác và chuyển hướng được báo là lỗi và không thử lại.',
  'destination.generic_webhook.step4':
    'Việc gửi là ít nhất một lần. Hãy dùng header webhook-id để bỏ qua request bạn đã xử lý; giá trị này giữ nguyên qua các lần thử lại.',
  'destination.generic_webhook.step5':
    'Dán địa chỉ vào ô bên dưới. Noti không chấp nhận địa chỉ IP, localhost, tên nội bộ, cổng khác hay http, và không bao giờ đi theo chuyển hướng.',
  'destination.generic_webhook.noteChecked':
    'Noti kiểm tra rằng tên miền phân giải ra một địa chỉ công khai khi bạn lưu. Noti không thể kiểm tra lại ở mỗi lần gửi, nên hãy giữ tên miền này trỏ đến máy chủ công khai của chính bạn.',
  'destination.generic_webhook.noteEvidence':
    'Câu trả lời 2xx của endpoint là bằng chứng duy nhất Noti có. Noti không thấy được chuyện gì xảy ra sau đó. Mã 202 hiển thị là Đã tiếp nhận; các mã 2xx khác hiển thị là Đã gửi tới nơi.',
  'validation.webhookUrl.wrongHost.generic_webhook':
    'Hãy dùng một địa chỉ https:// công khai với tên miền bình thường, ví dụ https://hooks.example.com/noti. Không chấp nhận địa chỉ IP, localhost, tên nội bộ, cổng khác và http.',

  // --- One-time signing secret --------------------------------------------
  'integration.secret.created.title': 'Signing secret của {name}',
  'integration.secret.rotated.title': 'Signing secret mới của {name}',
  'integration.secret.warning':
    'Hãy sao chép secret này ngay bây giờ. Noti lưu nó dưới dạng đã mã hóa và không thể hiện lại. Endpoint của bạn dùng nó để kiểm tra mỗi request thật sự đến từ Noti.',
  'integration.secret.rotatedNote':
    'Secret trước đó đã ngừng hoạt động khi bạn lưu. Hãy cập nhật endpoint ngay, nếu không việc kiểm tra chữ ký sẽ thất bại.',
  'integration.secret.label': 'Signing secret',
  'integration.secret.saved': 'Tôi đã lưu lại',
  'integration.secret.continue': 'Mở tích hợp',
} as const satisfies Record<keyof typeof destinationsEn, string>;
