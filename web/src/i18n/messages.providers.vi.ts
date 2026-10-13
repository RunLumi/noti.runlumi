import type { PluralMessage } from './messages.en';
import type { providersEn } from './messages.providers.en';

/**
 * Vietnamese copy for the GitLab and Stripe sources (ADR 0015); same register and glossary as
 * `messages.sources.vi.ts`. Provider and product names, protocol terms people paste into the
 * provider's own screen (webhook, URL, whsec_, Settings, Webhooks, Workbench, Snapshot, test
 * mode, live mode, merge request, pipeline) and event names stay in English exactly as the
 * provider shows them.
 */
export const providersVi = {
  'sources.kind.legend': 'Ai gửi sự kiện?',
  'sources.kind.generic.name': 'Hệ thống của riêng bạn',
  'sources.kind.generic.where': 'Một webhook có chữ ký do bạn tự xây dựng hoặc cấu hình. Noti tạo secret.',
  'sources.kind.gitlab.name': 'GitLab',
  'sources.kind.gitlab.where': 'Pipeline, merge request, issue và push trên GitLab.com.',
  'sources.kind.stripe.name': 'Stripe',
  'sources.kind.stripe.where': 'Thanh toán thất bại, tranh chấp (dispute) và thay đổi subscription.',
  'sources.kind.sentry.note':
    'Noti chưa hỗ trợ Sentry. Chữ ký webhook của Sentry được mô tả theo cách mà Noti chưa thể xác minh an toàn.',

  'sources.paste.stored': 'Noti lưu nó dưới dạng mã hóa và không bao giờ hiển thị lại.',
  'sources.paste.gitlab.label': 'Token từ GitLab',
  'sources.paste.gitlab.hintSigning':
    'Dán signing token đúng như GitLab hiển thị. Nó bắt đầu bằng whsec_ và GitLab chỉ hiển thị một lần.',
  'sources.paste.gitlab.hintSecret':
    'Dán secret token bạn đã nhập trong biểu mẫu webhook của GitLab (8 đến 255 ký tự, không có khoảng trắng).',
  'sources.paste.stripe.label': 'Signing secret từ Stripe',
  'sources.paste.stripe.hint':
    'Trong Stripe Workbench, mở endpoint và hiện signing secret. Nó bắt đầu bằng whsec_.',

  'sources.gitlab.auth.legend': 'Bạn sẽ dán thông tin xác thực nào của GitLab?',
  'sources.gitlab.auth.signing': 'Signing token (khuyến nghị)',
  'sources.gitlab.auth.signing.where':
    'GitLab ký mọi sự kiện, nên một thông điệp bị sửa đổi sẽ bị phát hiện.',
  'sources.gitlab.auth.secret': 'Secret token',
  'sources.gitlab.auth.secret.where':
    'GitLab gửi nó dưới dạng văn bản thuần. Yếu hơn: không thể chứng minh một thông điệp chưa bị sửa đổi.',

  'sources.stripe.mode.legend': 'Endpoint này dành cho chế độ Stripe nào?',
  'sources.stripe.mode.test': 'Test mode',
  'sources.stripe.mode.test.where': 'Sự kiện từ sandbox Stripe của bạn.',
  'sources.stripe.mode.live': 'Live mode',
  'sources.stripe.mode.live.where': 'Khách hàng thật và tiền thật.',
  'sources.stripe.mode.hint':
    'Endpoint test và live có secret khác nhau, nên mỗi chế độ là một nguồn riêng. Sự kiện của chế độ còn lại sẽ bị bỏ qua.',

  'sources.validation.authMode': 'Hãy chọn thông tin xác thực GitLab bạn sẽ dán.',
  'sources.validation.livemode': 'Hãy chọn test mode hoặc live mode.',
  'sources.validation.gitlabSigning':
    'Signing token bắt đầu bằng whsec_ theo sau là base64. Hãy dán đúng như GitLab hiển thị.',
  'sources.validation.gitlabSecret': 'Dùng 8 đến 255 ký tự nhìn thấy được, không có khoảng trắng.',
  'sources.validation.stripeSecret':
    'Signing secret của Stripe bắt đầu bằng whsec_. Hãy sao chép nó từ endpoint trong Stripe Workbench.',
  'sources.validation.downgrade': 'Hãy đánh dấu ô để xác nhận dùng thông tin xác thực yếu hơn.',

  'sources.created.provider':
    '{name} đã sẵn sàng. Hãy hoàn tất trong {provider} theo các bước ở mục “Set up {provider}” trên thẻ bên dưới.',
  'sources.replaced.provider': 'Thông tin xác thực của {name} đã được thay. Thông tin cũ không còn hiệu lực.',

  'sources.card.type': 'Loại nguồn',
  'sources.card.auth': 'Được xác minh bằng',
  'sources.card.auth.signing': 'Ký bằng signing token',
  'sources.card.auth.secret': 'Secret token thuần (yếu hơn)',
  'sources.card.mode': 'Chế độ',
  'sources.card.mode.live': 'Live',
  'sources.card.mode.test': 'Test',
  'sources.card.dropped': {
    other: '{count} sự kiện bị bỏ vì nguồn vượt quá giới hạn tốc độ',
  },
  'sources.card.droppedHelp':
    'GitLab sẽ tắt một webhook nhận phản hồi lỗi, nên Noti trả lời 200 và bỏ các sự kiện dư thay vì báo lỗi. Hãy tạm dừng các pipeline quá ồn trong GitLab hoặc thu hẹp trigger. Lần bỏ gần nhất:',

  'sources.rotate.provider.open': 'Thay thông tin xác thực…',
  'sources.rotate.provider.title': 'Thay thông tin xác thực của {name}?',
  'sources.rotate.provider.body':
    'Dán thông tin xác thực mới từ {provider}. Thông tin hiện tại ngừng hoạt động ngay khi bạn lưu, nên hãy thay trong {provider} trước hoặc ngay sau đó.',
  'sources.rotate.provider.confirm': 'Thay thông tin xác thực',
  'sources.rotate.provider.replacing': 'Đang thay…',
  'sources.rotate.provider.failed': 'Thông tin xác thực chưa được thay.',
  'sources.rotate.downgrade.label': 'Thay signing token bằng secret token thuần',
  'sources.rotate.downgrade.help':
    'Secret token thuần không thể chứng minh thông điệp chưa bị sửa đổi và một yêu cầu bị chặn bắt có thể được phát lại.',

  'sources.events.legend': 'Chat này nên nhận những sự kiện nào?',
  'sources.events.hint': 'Để trống tất cả nếu muốn gửi mọi sự kiện trong danh sách này.',

  'sources.event.push': 'Push lên một branch',
  'sources.event.tag_push': 'Tag được push',
  'sources.event.merge_request.opened': 'Merge request được mở',
  'sources.event.merge_request.merged': 'Merge request được merge',
  'sources.event.merge_request.closed': 'Merge request bị đóng',
  'sources.event.merge_request.reopened': 'Merge request được mở lại',
  'sources.event.issue.opened': 'Issue được mở',
  'sources.event.issue.closed': 'Issue bị đóng',
  'sources.event.issue.reopened': 'Issue được mở lại',
  'sources.event.pipeline.failed': 'Pipeline thất bại',
  'sources.event.pipeline.succeeded': 'Pipeline thành công',
  'sources.event.invoice.payment_failed': 'Thanh toán hóa đơn thất bại',
  'sources.event.payment_intent.payment_failed': 'Thanh toán thất bại',
  'sources.event.charge.dispute.created': 'Tranh chấp được mở',
  'sources.event.charge.dispute.closed': 'Tranh chấp được đóng',
  'sources.event.customer.subscription.created': 'Subscription được tạo',
  'sources.event.customer.subscription.updated': 'Trạng thái subscription thay đổi',
  'sources.event.customer.subscription.deleted': 'Subscription bị hủy',

  'sources.guide.gitlab.summary': 'Set up GitLab',
  'sources.guide.gitlab.step1':
    'Trong GitLab, mở project của bạn, rồi vào Settings, sau đó Webhooks và chọn Add new webhook.',
  'sources.guide.gitlab.step2': 'Dán endpoint URL trên thẻ này vào ô URL.',
  'sources.guide.gitlab.step3':
    'Dán signing token, hoặc secret token bạn đã nhập, vào ô tương ứng. Nó phải đúng là giá trị bạn đã đưa cho Noti.',
  'sources.guide.gitlab.step4':
    'Đánh dấu Push events, Tag push events, Merge request events, Issue events và Pipeline events.',
  'sources.guide.gitlab.step5': 'Lưu, rồi dùng Test. Phản hồi 2xx nghĩa là Noti đã nhận sự kiện.',
  'sources.guide.gitlab.comOnly':
    'Noti chỉ hỗ trợ GitLab.com. Webhook từ GitLab tự quản lý (self-managed) sẽ bị từ chối.',
  'sources.guide.gitlab.disable':
    'GitLab tạm dừng một webhook sau bốn lần gửi lỗi liên tiếp và tắt hẳn sau bốn mươi lần. Noti trả lời nhanh và vẫn trả lời 200 ngay cả khi đang bận, bỏ các sự kiện dư thay vì báo lỗi. Nếu sự kiện ngừng đến, hãy kiểm tra webhook trong GitLab.',
  'sources.guide.gitlab.pushLimit':
    'GitLab không gửi webhook nào cho một lần push chạm hơn ba branch hoặc tag, nên Noti không thể hiển thị lần push đó.',
  'sources.guide.gitlab.weak':
    'Secret token chỉ chứng minh người gửi biết token, không chứng minh thông điệp còn nguyên vẹn, và một yêu cầu bị chặn bắt có thể được phát lại. Hãy dùng signing token nếu GitLab của bạn có.',
  'sources.guide.gitlab.docs': 'Tài liệu webhook của GitLab',
  'sources.guide.gitlab.ignored':
    'Các sự kiện ngoài danh sách trên, và các cập nhật merge request, được nhận nhưng không gửi đến chat.',

  'sources.guide.stripe.summary': 'Set up Stripe',
  'sources.guide.stripe.step1':
    'Trong Stripe, mở Workbench, rồi Webhooks và chọn Create an event destination.',
  'sources.guide.stripe.step2':
    'Chọn Your account và định dạng payload Snapshot. Thin events chưa được hỗ trợ.',
  'sources.guide.stripe.step3':
    'Chọn các sự kiện: invoice.payment_failed, payment_intent.payment_failed, charge.dispute.created, charge.dispute.closed, customer.subscription.created, customer.subscription.updated, customer.subscription.deleted.',
  'sources.guide.stripe.step4': 'Chọn Webhook endpoint và dán endpoint URL trên thẻ này.',
  'sources.guide.stripe.step5':
    'Hiện signing secret, bắt đầu bằng whsec_, và dán vào Noti khi bạn tạo nguồn hoặc thay thông tin xác thực.',
  'sources.guide.stripe.modes':
    'Test mode và live mode có secret khác nhau và endpoint khác nhau. Hãy tạo một nguồn Noti cho mỗi chế độ.',
  'sources.guide.stripe.privacy':
    'Một thông báo chỉ hiển thị id, số tiền và loại tiền. Tên khách hàng, email và thông tin thẻ không bao giờ được sao chép vào chat.',
  'sources.guide.stripe.retries':
    'Stripe thử gửi lại một lần gửi lỗi trong tối đa ba ngày. Noti hiển thị mỗi sự kiện Stripe một lần, ngay cả khi Stripe gửi lại.',
  'sources.guide.stripe.roll':
    'Khi bạn đổi (roll) secret trong Stripe, hãy giữ secret cũ hoạt động một lúc, rồi thay thông tin xác thực trong Noti.',
  'sources.guide.stripe.docs': 'Tài liệu webhook của Stripe',
} as const satisfies Record<keyof typeof providersEn, string | PluralMessage>;
