import type { en, PluralMessage } from './messages.en';
import { filtersVi } from './messages.filters.vi';
import { sourcesVi } from './messages.sources.vi';

/**
 * Vietnamese catalogue for the integrations, delivery-log and workspace screens (F224).
 *
 * Register: formal-friendly, addressing the reader as "bạn", short sentences, active voice;
 * what happened first, then what to do (DESIGN.md §14). Product and provider names (Noti,
 * GitHub, Lark, Slack, Microsoft Teams) and technical terms people search for in their own
 * tools (webhook, URL, repository, pull request, workflow, commit) stay in English. The
 * Chinese menu labels in the Lark steps are the verbatim labels on Lark's screen and must not
 * be translated (F212).
 *
 * Vietnamese has no grammatical plural, so plural messages carry only `other`.
 * `catalogue.test.ts` fails if an id is missing or a `{placeholder}` differs from English.
 */
export const vi = {
  ...filtersVi,
  ...sourcesVi,

  // --- Integrations list --------------------------------------------------
  'integrations.eyebrow': 'KẾT NỐI',
  'integrations.title': 'Tích hợp',
  'integrations.description':
    'Mỗi tích hợp gửi các cập nhật GitHub bạn chọn từ một repository đến một nhóm chat Lark, Slack hoặc Microsoft Teams.',
  'integrations.new': 'Tích hợp mới',
  'integrations.loading': 'Đang tải danh sách tích hợp…',
  'integrations.count': { other: '{count} tích hợp' },
  'integrations.paused.count': { other: '{count} đang tạm dừng' },
  'integrations.listLabel': 'Các tích hợp trong không gian làm việc này',
  'integrations.empty.title': 'Chưa có tích hợp nào',
  'integrations.empty.body':
    'Một tích hợp theo dõi một repository GitHub và đăng những cập nhật bạn chọn, như một lần build lỗi hay một pull request vừa được merge, vào nhóm Lark hoặc kênh Slack.',
  'integrations.empty.action': 'Thiết lập tích hợp đầu tiên',
  'integrations.roadmap':
    'Nhiều nguồn và nơi nhận khác nằm trong kế hoạch. Chúng tôi không liệt kê những tích hợp mà hiện chưa thể kết nối.',
  'integrations.error.title': 'Chúng tôi không tải được danh sách tích hợp.',
  'integrations.error.body': 'Chưa có gì bị thay đổi. Các tích hợp đã lưu của bạn không bị ảnh hưởng.',
  'integrations.retry': 'Thử lại',
  'integrations.truncated':
    'Đang hiển thị 200 tích hợp được tạo gần đây nhất. Các tích hợp cũ hơn vẫn hoạt động nhưng chưa được liệt kê ở đây.',

  // --- One integration in the list ----------------------------------------
  'integration.repo': 'Repository',
  'integration.destination': 'Gửi đến',
  'integration.destinationValue': '{destination} · {host}',
  'integration.destinationNoHost': '{destination}',
  'integration.events': 'Cập nhật',
  'integration.events.more': { other: '+{count} nữa' },
  'integration.events.unknown': 'Không còn được hỗ trợ: {type}',
  'integration.manage': 'Quản lý',
  'integration.manageLabel': 'Quản lý {name}',
  'integration.toggle.label': 'Gửi thông báo',
  'integration.toggle.labelFor': 'Gửi thông báo cho {name}',
  'integration.toggle.on': 'Bật',
  'integration.toggle.off': 'Tạm dừng',
  'integration.toggle.saving': 'Đang lưu…',
  'integration.toggle.errorOn': 'Chúng tôi không bật lại được {name}, nên tích hợp vẫn đang tạm dừng.',
  'integration.toggle.errorOff': 'Chúng tôi không tạm dừng được {name}, nên tích hợp vẫn đang bật.',

  // --- Credential states --------------------------------------------------
  'credentials.legacy.title': 'Nhập lại webhook URL để hoàn tất nâng cấp bảo mật',
  'credentials.legacy.body':
    'Tích hợp này được lưu trước khi Noti bắt đầu niêm phong từng webhook URL bằng khóa mã hóa riêng. Tích hợp vẫn hoạt động, nhưng dán lại URL sẽ lưu nó theo cách mới.',
  'credentials.quarantined.title': 'Thông báo đã dừng: chúng tôi không đọc được webhook URL đã lưu',
  'credentials.quarantined.body':
    'Webhook URL đã lưu không qua được bước kiểm tra toàn vẹn, nên Noti ngừng dùng nó thay vì đoán. Hãy dán lại URL từ {destination} để tiếp tục.',
  'credentials.fix': 'Thay webhook URL',
  'credentials.ok': 'Đã lưu dưới dạng mã hóa. Noti không bao giờ hiển thị lại.',

  // --- Destinations -------------------------------------------------------
  'destination.lark': 'Lark',
  'destination.slack': 'Slack',
  'destination.lark.where': 'Đăng vào nhóm Lark mà bạn chọn.',
  'destination.slack.where': 'Đăng vào kênh Slack mà bạn chọn.',
  'destination.lark.what': 'Dùng một bot tùy chỉnh mà bạn thêm vào nhóm. Không cần quản trị viên phê duyệt.',
  'destination.slack.what': 'Dùng incoming webhook của một ứng dụng Slack trong không gian làm việc của bạn.',
  'destination.lark.urlHint':
    'Bắt đầu bằng https://open.larksuite.com/open-apis/bot/v2/hook/ (hoặc open.feishu.cn).',
  'destination.slack.urlHint': 'Bắt đầu bằng https://hooks.slack.com/services/.',
  'destination.lark.docs': 'Hướng dẫn của Lark về custom bot',
  'destination.slack.docs': 'Hướng dẫn của Slack về incoming webhook',
  'destination.teams': 'Microsoft Teams',
  'destination.teams.where': 'Đăng vào kênh Teams mà bạn chọn.',
  'destination.teams.what':
    'Dùng một flow “Workflows” của Power Automate có trigger là một web request. Flow chạy dưới tài khoản của bạn.',
  'destination.teams.urlHint':
    'Một địa chỉ có dạng https://…logic.azure.com/…, hiện ở bước đầu tiên của flow sau khi bạn lưu.',
  'destination.teams.docs': 'Hướng dẫn của Microsoft về webhook với Workflows',
  'destination.teams.step1':
    'Trong Teams, mở menu “…” của kênh, chọn Workflows, rồi chọn “Post to a channel when a webhook request is received”. Bạn cũng có thể bắt đầu từ Power Automate.',
  'destination.teams.step2': 'Đặt tên cho flow, kiểm tra team và kênh, rồi chọn Next và Create flow.',
  'destination.teams.step3':
    'Mở bước đầu tiên của flow (“When a Teams webhook request is received”). Ở mục Who can trigger the flow, chọn Anyone. Noti không thể đăng nhập bằng tài khoản Microsoft.',
  'destination.teams.step4': 'Lưu lại, rồi sao chép HTTP POST URL ở bước đó.',
  'destination.teams.step5': 'Dán vào ô bên dưới. Noti chỉ chấp nhận các địa chỉ thuộc logic.azure.com.',
  'destination.teams.noteOwner':
    'Flow thuộc về người đã tạo ra nó, không thuộc về team. Nếu người đó rời công ty, thông báo sẽ dừng. Hãy nhờ họ thêm một đồng sở hữu.',
  'destination.teams.noteAccepted':
    'Khi chúng tôi gửi tin, Teams chỉ trả lời “accepted”. Teams không xác nhận được flow đã đăng tin hay chưa, nên Noti hiển thị các tin này là Đã tiếp nhận, không bao giờ là Đã gửi tới nơi. Nếu quản trị viên của bạn chưa phê duyệt Workflows, tin sẽ được tiếp nhận rồi bị mất.',
  'destination.guideTitle': 'Tìm webhook URL ở đâu',
  'destination.guideNote':
    'Các bước này theo tài liệu của chính nhà cung cấp. Nếu màn hình của bạn khác, hãy làm theo hướng dẫn của họ.',
  'destination.lark.step1':
    'Mở nhóm Lark nơi bạn muốn nhận thông báo. Mọi người trong nhóm sẽ thấy các thông báo này.',
  'destination.lark.step2': 'Mở Settings (设置) của nhóm, rồi chọn Bots (群机器人).',
  'destination.lark.step3':
    'Chọn Add Bot (添加机器人), rồi Custom Bot (自定义机器人). Đặt tên và thêm bot vào nhóm.',
  'destination.lark.step4': 'Sao chép địa chỉ webhook và dán vào ô bên dưới.',
  'destination.lark.step5':
    'Tùy chọn: bật xác minh chữ ký (签名校验) và sao chép cả secret. Khi đó Noti sẽ ký mọi tin nhắn.',
  'destination.slack.step1':
    'Mở ứng dụng Slack của bạn tại api.slack.com/apps, hoặc tạo một ứng dụng cho không gian làm việc của bạn.',
  'destination.slack.step2': 'Trong Features, mở Incoming Webhooks và bật chúng lên.',
  'destination.slack.step3': 'Chọn Add New Webhook, chọn kênh và cho phép truy cập.',
  'destination.slack.step4': 'Sao chép Webhook URL và dán vào ô bên dưới.',

  // --- Wizard -------------------------------------------------------------
  'wizard.eyebrow': 'TÍCH HỢP MỚI',
  'wizard.title': 'Thiết lập một tích hợp',
  'wizard.description': 'Sáu bước ngắn. Chưa có gì được lưu cho đến khi bạn chọn Tạo tích hợp.',
  'wizard.progress': 'Các bước thiết lập',
  'wizard.stepOf': 'Bước {current} trên {total}: {title}',
  'wizard.step.github': 'Kết nối GitHub',
  'wizard.step.destination': 'Chọn nơi nhận tin',
  'wizard.step.webhook': 'Dán webhook URL',
  'wizard.step.source': 'Chọn repository',
  'wizard.step.events': 'Chọn nội dung cần gửi',
  'wizard.step.filters': 'Thêm bộ lọc (không bắt buộc)',
  'wizard.step.review': 'Xem lại và tạo',
  'wizard.back': 'Quay lại',
  'wizard.continue': 'Tiếp tục',
  'wizard.cancel': 'Hủy',
  'wizard.create': 'Tạo tích hợp',
  'wizard.creating': 'Đang tạo…',
  'wizard.leaveConfirm': 'Rời khỏi phần thiết lập? Những gì bạn đã nhập ở đây sẽ bị bỏ.',
  'wizard.fixErrors': 'Hãy kiểm tra các ô được đánh dấu.',
  'wizard.serverErrors':
    'Noti chưa lưu được tích hợp này. Hãy sửa các ô được đánh dấu bên dưới; các câu trả lời khác vẫn được giữ.',
  'wizard.destination.legend': 'Thông báo nên được gửi đến đâu?',
  'wizard.destination.changeNote': 'Bạn không thể đổi nơi nhận về sau, vì URL thuộc về nơi nhận đó.',
  'wizard.review.intro': 'Hãy kiểm tra các thông tin. Bạn có thể đổi tên, repository và các cập nhật về sau.',
  'wizard.review.edit': 'Đổi',
  'wizard.review.editLabel': 'Đổi {field}',
  'wizard.review.webhook': 'Webhook URL',
  'wizard.review.webhookValue': 'Đã cung cấp — được lưu dưới dạng mã hóa sau khi bạn tạo',
  'wizard.review.secret': 'Signing secret',
  'wizard.review.secretValue': 'Đã cung cấp',
  'wizard.review.secretNone': 'Không dùng',

  // --- Fields -------------------------------------------------------------
  'field.webhookUrl': 'Webhook URL',
  'field.webhookUrl.warning':
    'Bất kỳ ai có URL này đều đăng được vào nhóm chat của bạn. Hãy coi nó như mật khẩu. Chúng tôi lưu nó dưới dạng mã hóa và không bao giờ hiển thị lại.',
  'field.signingSecret': 'Signing secret (không bắt buộc)',
  'field.signingSecret.hint': 'Chỉ cần nếu bạn đã bật xác minh chữ ký (签名校验) cho bot.',
  'field.signingSecret.rotateHint':
    'Nếu bot dùng xác minh chữ ký, hãy dán lại secret của nó. Để trống sẽ tắt việc ký.',
  'field.name': 'Tên (không bắt buộc)',
  'field.name.hint': 'Một nhãn ngắn cho nhóm của bạn. Nếu để trống, chúng tôi dùng tên repository.',
  'field.nameRequired': 'Tên',
  'field.repo': 'Repository GitHub',
  'field.repo.hint':
    'Chủ sở hữu và tên repository, như trong github.com/owner/repository. Không phân biệt chữ hoa, chữ thường.',
  'field.repo.placeholder': 'owner/repository',
  'field.events': 'Cập nhật cần gửi',
  'field.events.hint':
    'Chúng tôi bắt đầu với các build lỗi và hết thời gian chờ vì đây là cài đặt hữu ích mà ít gây ồn nhất. Bạn có thể đổi bất cứ lúc nào.',
  'field.events.selectAll': 'Chọn tất cả',
  'field.events.clearAll': 'Bỏ chọn',
  'field.events.selectAllLabel': 'Chọn tất cả cập nhật nhóm {group}',
  'field.events.clearAllLabel': 'Bỏ chọn tất cả cập nhật nhóm {group}',
  'field.events.selected': { other: 'Đã chọn {count} cập nhật' },
  'field.show': 'Hiện',
  'field.hide': 'Ẩn',
  'field.showLabel': 'Hiện {field}',
  'field.hideLabel': 'Ẩn {field}',

  // --- Client-side validation ----------------------------------------------
  'validation.destination': 'Hãy chọn Lark, Slack hoặc Microsoft Teams.',
  'validation.name': 'Dùng 1–80 ký tự, không xuống dòng.',
  'validation.repo': 'Dùng dạng owner/repository, ví dụ acme/website.',
  'validation.events': 'Hãy chọn ít nhất một cập nhật.',
  'validation.webhookUrl.empty': 'Hãy dán webhook URL từ {destination}.',
  'validation.webhookUrl.invalid': 'Đây chưa phải là một địa chỉ web đầy đủ. Hãy sao chép lại toàn bộ URL.',
  'validation.webhookUrl.wrongHost.lark':
    'Đây không phải là địa chỉ webhook của Lark. Địa chỉ đúng bắt đầu bằng https://open.larksuite.com/open-apis/bot/v2/hook/ (hoặc open.feishu.cn).',
  'validation.webhookUrl.wrongHost.slack':
    'Đây không phải là địa chỉ webhook của Slack. Địa chỉ đúng bắt đầu bằng https://hooks.slack.com/services/.',
  'validation.webhookUrl.wrongHost.teams':
    'Đây không phải là địa chỉ web request của Workflows. Địa chỉ đúng bắt đầu bằng https:// và có tên miền kết thúc bằng logic.azure.com.',
  'validation.signingSecret': 'Hãy dán secret đúng như Lark hiển thị, không có khoảng trắng.',

  // --- Event categories ---------------------------------------------------
  'eventGroup.builds': 'Build và kiểm tra',
  'eventGroup.builds.hint': 'Kết quả của GitHub Actions workflow.',
  'eventGroup.pullRequests': 'Pull request',
  'eventGroup.reviews': 'Review và bình luận về mã',
  'eventGroup.issues': 'Issue và bình luận',
  'eventGroup.code': 'Mã nguồn',
  'eventGroup.releases': 'Release và deployment',

  // --- Event labels ---------------------------------------------------------
  'event.workflow_run.failure': 'Một workflow thất bại',
  'event.workflow_run.timed_out': 'Một workflow hết thời gian chờ',
  'event.workflow_run.cancelled': 'Một workflow bị hủy',
  'event.workflow_run.success': 'Một workflow thành công',
  'event.pull_request.opened': 'Một pull request được mở',
  'event.pull_request.ready_for_review': 'Một pull request nháp sẵn sàng để review',
  'event.pull_request.reopened': 'Một pull request được mở lại',
  'event.pull_request.merged': 'Một pull request được merge',
  'event.pull_request.closed': 'Một pull request bị đóng mà không merge',
  'event.pull_request_review.submitted': 'Có người gửi một review',
  'event.pull_request_review_comment.created': 'Có người bình luận vào một dòng mã',
  'event.issues.opened': 'Một issue được mở',
  'event.issues.closed': 'Một issue được đóng',
  'event.issues.reopened': 'Một issue được mở lại',
  'event.issue_comment.created': 'Có người bình luận vào một issue hoặc pull request',
  'event.push': 'Có commit mới được đẩy lên',
  'event.release.published': 'Một release được phát hành',
  'event.deployment_status.created': 'Một deployment báo trạng thái mới',

  // --- Settings (one integration) -----------------------------------------
  'settings.eyebrow': 'TÍCH HỢP',
  'settings.back': 'Tất cả tích hợp',
  'settings.loading': 'Đang tải tích hợp…',
  'settings.notFound.title': 'Tích hợp này không tồn tại trong không gian làm việc này.',
  'settings.notFound.body': 'Có thể nó đã bị xóa, hoặc liên kết thuộc về một không gian làm việc khác.',
  'settings.created': 'Đã lưu {name}. Từ giờ, các cập nhật GitHub phù hợp từ repository này sẽ được gửi đi.',
  'settings.status.title': 'Trạng thái',
  'settings.status.on': 'Đang bật. Các sự kiện mới của repository này được gửi đến {destination}.',
  'settings.status.onBlocked':
    'Đang bật, nhưng chưa gửi được gì cho đến khi webhook URL được thay. Xem mục Nơi nhận và webhook URL bên dưới.',
  'settings.status.off':
    'Đang tạm dừng. Không có gì được gửi đi. Cài đặt và thông tin xác thực vẫn được giữ, và bạn có thể bật lại.',
  'settings.details.title': 'Repository và cập nhật',
  'settings.save': 'Lưu thay đổi',
  'settings.saving': 'Đang lưu…',
  'settings.saved': 'Đã lưu thay đổi.',
  'settings.noChanges': 'Chưa có thay đổi nào.',
  'settings.unsaved': 'Bạn có thay đổi chưa lưu.',
  'settings.leaveConfirm': 'Rời khỏi trang này? Các thay đổi chưa lưu của bạn sẽ mất.',
  'settings.credentials.title': 'Nơi nhận và webhook URL',
  'settings.credentials.destination': 'Nơi nhận',
  'settings.credentials.host': 'Máy chủ webhook',
  'settings.credentials.state': 'URL đã lưu',
  'settings.credentials.stateOk': 'Đã mã hóa',
  'settings.credentials.stateLegacy': 'Cần nhập lại',
  'settings.credentials.stateQuarantined': 'Không đọc được — hãy thay',
  'settings.credentials.destinationFixed': 'Để gửi đến một loại nơi nhận khác, hãy tạo tích hợp mới.',
  'settings.credentials.replace': 'Thay webhook URL',
  'settings.credentials.replaceIntro':
    'Dán một URL mới từ {destination}. Noti ngừng dùng URL cũ ngay khi bạn lưu, và khóa mã hóa của nó bị hủy.',
  'settings.credentials.save': 'Lưu webhook URL mới',
  'settings.credentials.saved': 'Đã lưu webhook URL mới. URL cũ không còn được dùng.',
  'settings.danger.title': 'Xóa tích hợp',
  'settings.danger.body':
    'Xóa sẽ gỡ tích hợp này và hủy webhook URL cùng signing secret đã lưu. Không thể khôi phục chúng. Nếu chỉ muốn ngừng gửi tin một thời gian, hãy tạm dừng tích hợp ở phần trên.',
  'settings.delete': 'Xóa tích hợp',

  // --- Delete dialog --------------------------------------------------------
  'delete.title': 'Xóa {name}?',
  'delete.body':
    'Noti sẽ ngừng gửi cập nhật từ {repo} đến {destination} và hủy webhook URL cùng signing secret đã lưu. Không thể hoàn tác.',
  'delete.confirmLabel': 'Nhập {name} để xác nhận',
  'delete.cancel': 'Giữ tích hợp',
  'delete.confirm': 'Xóa vĩnh viễn',
  'delete.deleting': 'Đang xóa…',
  'delete.done': 'Đã xóa {name}.',

  // --- Request errors --------------------------------------------------------
  'error.network': 'Chúng tôi không kết nối được với Noti. Hãy kiểm tra kết nối mạng rồi thử lại.',
  'error.session': 'Phiên đăng nhập của bạn đã kết thúc. Hãy đăng nhập lại để tiếp tục.',
  'error.forbidden':
    'Vai trò của bạn không thể thực hiện thay đổi này. Hãy nhờ quản trị viên không gian làm việc.',
  'error.blocked': 'Yêu cầu bị chặn bởi một bước kiểm tra bảo mật. Hãy tải lại trang rồi thử lại.',
  'error.notFound': 'Tích hợp này không còn tồn tại. Có thể nó đã bị xóa.',
  'error.quota':
    'Không gian làm việc này đã đạt giới hạn 100 tích hợp. Hãy xóa một tích hợp bạn không dùng nữa rồi thử lại.',
  'error.rateLimited':
    'Bạn vừa thực hiện quá nhiều thay đổi trong thời gian ngắn. Hãy đợi một phút rồi thử lại.',
  'error.rateLimitedFor':
    'Bạn vừa thực hiện quá nhiều thay đổi trong thời gian ngắn. Hãy đợi {seconds} giây rồi thử lại.',
  'error.tooLarge': 'Yêu cầu này lớn hơn mức Noti chấp nhận trong một lần. Hãy rút ngắn ô dài nhất.',
  'error.server': 'Đã có sự cố ở phía chúng tôi. Hãy tải lại trang để xem những gì đã được lưu.',
  'error.validation': 'Một số ô cần bạn chú ý.',
  'error.reference': 'Mã tham chiếu cho bộ phận hỗ trợ: HTTP {status}',

  // --- GitHub connection -----------------------------------------------------
  'github.title': 'Kết nối GitHub',
  'github.loading': 'Đang kiểm tra kết nối GitHub của bạn…',
  'github.error': 'Chúng tôi không kiểm tra được kết nối GitHub của bạn.',
  'github.intro.none':
    'Noti đọc các cập nhật GitHub thông qua Noti GitHub App. Hãy cài ứng dụng này cho tài khoản hoặc tổ chức của bạn và chọn những repository mà Noti được phép thấy.',
  'github.intro.connected':
    'Các tích hợp có thể dùng những repository mà các tài khoản GitHub này cho phép Noti thấy. Hãy kết nối lại để thêm tài khoản hoặc đổi các repository được đưa vào.',
  'github.connect': 'Kết nối GitHub',
  'github.reconnect': 'Kết nối lại để làm mới quyền truy cập repository',
  'github.connecting': 'Đang mở GitHub…',
  'github.samlHint':
    'Nếu tổ chức của bạn dùng đăng nhập một lần (SSO), hãy đăng nhập vào tổ chức đó trên GitHub trước, nếu không GitHub sẽ không cho Noti thấy bản cài đặt.',
  'github.notConfigured.title': 'Máy chủ này chưa cấu hình GitHub App',
  'github.notConfigured.body':
    'Máy chủ Noti này chưa có thông tin xác thực GitHub App, nên chưa thể kết nối GitHub và chưa thể tạo tích hợp. Quản trị viên của máy chủ cần đăng ký App trước.',
  'github.type.org': 'Tổ chức',
  'github.type.user': 'Tài khoản cá nhân',
  'github.status.active': 'Đã kết nối',
  'github.status.suspended': 'Bị tạm ngưng',
  'github.status.uninstalled': 'Đã gỡ cài đặt',
  'github.scope.all': 'Tất cả repository của {account}, kể cả repository mới',
  'github.scope.selected': { other: '{count} repository được chọn' },
  'github.suspended.body':
    'Noti App đang bị tạm ngưng cho {account} trong GitHub, nên không có cập nhật nào được gửi tới. Chủ sở hữu của {account} có thể bỏ tạm ngưng trong phần cài đặt của GitHub.',
  'github.uninstalled.body':
    'Noti App đã bị gỡ khỏi {account}, nên các tích hợp của nó không nhận được gì. Hãy kết nối lại GitHub để khôi phục quyền truy cập.',
  'github.resync.title': 'Danh sách repository của Noti có thể đã cũ',
  'github.resync.body':
    'GitHub đã đổi những repository của {account} mà Noti được phép thấy, nhưng chúng tôi chỉ nhận được một phần thay đổi. Hãy kết nối lại để làm mới danh sách.',
  'github.return.connected':
    'GitHub đã được kết nối. Bây giờ bạn có thể chọn repository của nó trong một tích hợp.',
  'github.return.next': 'Thiết lập một tích hợp',
  'github.return.state_invalid':
    'Liên kết kết nối GitHub đó đã hết hạn hoặc đã được dùng. Hãy chọn Kết nối GitHub để bắt đầu lại.',
  'github.return.state_user_mismatch':
    'Kết nối GitHub được bắt đầu bởi một người dùng Noti khác. Hãy bắt đầu lại khi đang đăng nhập bằng tài khoản của chính bạn.',
  'github.return.installation_id_invalid':
    'GitHub gửi về một bản cài đặt mà Noti không nhận ra. Hãy chọn Kết nối GitHub để thử lại.',
  'github.return.oauth_failed':
    'GitHub không xác nhận được bạn là ai, nên chưa có gì được kết nối. Hãy thử lại và đồng ý yêu cầu trên GitHub.',
  'github.return.installation_not_accessible':
    'Tài khoản GitHub của bạn không thấy bản cài đặt đó. Nếu tổ chức dùng đăng nhập một lần (SSO), hãy đăng nhập vào tổ chức trên GitHub rồi thử lại.',
  'github.return.installation_admin_required':
    'Chỉ chủ sở hữu hoặc quản trị viên của một tổ chức GitHub mới kết nối được tổ chức đó với Noti. Hãy nhờ một người trong số họ chọn Kết nối GitHub từ không gian làm việc này.',
  'github.return.installation_bound_elsewhere':
    'Bản cài đặt GitHub đó đã được kết nối với một không gian làm việc Noti khác. Mỗi bản cài đặt chỉ thuộc về một nơi.',
  'github.return.installation_deleted':
    'Bản cài đặt đó đã bị gỡ khỏi GitHub trước khi kịp kết nối. Hãy cài App lại.',
  'github.return.installation_too_large':
    'Bản cài đặt đó có hơn 1.000 repository được chọn, mà Noti chưa theo dõi được. Hãy chọn ít repository hơn, hoặc chọn tất cả repository, trong GitHub.',
  'github.return.workspace_access_lost':
    'Bạn không còn quyền truy cập không gian làm việc này, nên chưa có gì được kết nối. Hãy nhờ quản trị viên kiểm tra vai trò của bạn.',
  'github.return.github_unavailable':
    'GitHub không phản hồi, nên chưa có gì được kết nối. Hãy thử lại sau vài phút.',
  'github.return.not_configured': 'Máy chủ Noti này chưa cấu hình GitHub App, nên chưa thể kết nối GitHub.',
  'github.return.signin_required': 'Hãy đăng nhập vào Noti, rồi chọn Kết nối GitHub lần nữa.',
  'github.return.unexpected_error':
    'Đã có sự cố khi kết nối GitHub và chưa có gì được kết nối. Hãy thử lại; nếu vẫn lặp lại, hãy liên hệ bộ phận hỗ trợ.',

  // --- Repository picker ----------------------------------------------------
  'repo.picker': 'Repository GitHub',
  'repo.picker.hint': 'Chỉ liệt kê những repository mà kết nối GitHub của bạn cho phép Noti thấy.',
  'repo.picker.placeholder': 'Chọn một repository',
  'repo.picker.allOption': 'Repository khác trong {account}…',
  'repo.picker.notCovered': '{repo} (Noti không còn thấy)',
  'repo.name': 'Tên repository trong {account}',
  'repo.name.hint': 'Nhập tên như hiển thị sau {account}/ trên GitHub.',
  'repo.none.title': 'Hãy kết nối GitHub trước',
  'repo.none.body':
    'Một tích hợp theo dõi một repository mà Noti GitHub App có thể thấy. Hãy kết nối GitHub và chọn các repository. GitHub sẽ đưa bạn trở lại trang Tích hợp, nơi bạn có thể bắt đầu lại phần thiết lập này.',
  'validation.repoNotCovered':
    'Noti không thấy repository này. Hãy chọn một repository trong danh sách, hoặc kết nối lại GitHub để cấp quyền truy cập.',

  // --- Overview -------------------------------------------------------------
  'overview.integrations': 'Tích hợp',
  'overview.integrations.loading': 'Đang tải…',
  'overview.integrations.error': 'Không tải được',
  'overview.integrations.breakdown': '{enabled} đang bật · {paused} tạm dừng',
  'overview.integrations.none': 'Chưa thiết lập tích hợp nào',
  'overview.delivered': 'Đã gửi tới nơi, 24 giờ qua',
  'overview.delivered.accepted': { other: '+{count} được tiếp nhận nhưng chưa xác nhận' },
  'overview.delivered.none': 'Không có lượt gửi nào trong 24 giờ qua',
  'overview.delivered.confirmed': 'Được nơi nhận xác nhận',
  'overview.failed': 'Thất bại, 24 giờ qua',
  'overview.failed.retrying': { other: '{count} đang được thử lại' },
  'overview.failed.clear': 'Không có lượt gửi nào thất bại',
  'overview.failed.view': 'Xem các lượt gửi thất bại',
  'overview.stats.loading': 'Đang tải…',
  'overview.stats.error': 'Không tải được',

  // --- Delivery log ---------------------------------------------------------------
  'deliveries.eyebrow': 'NHẬT KÝ GỬI',
  'deliveries.title': 'Hoạt động',
  'deliveries.description':
    'Mọi thông báo Noti đã thử gửi, chuyện gì đã xảy ra với chúng, và cần làm gì với những thông báo bị lỗi.',
  'deliveries.model': 'Noti gửi ít nhất một lần. Đôi khi một thông báo có thể được gửi nhiều hơn một lần.',
  'deliveries.loading': 'Đang tải các lượt gửi…',
  'deliveries.filters.label': 'Lọc các lượt gửi',
  'deliveries.filter.state': 'Kết quả',
  'deliveries.filter.state.all': 'Mọi kết quả',
  'deliveries.filter.integration': 'Tích hợp',
  'deliveries.filter.integration.all': 'Mọi tích hợp',
  'deliveries.filter.from': 'Từ',
  'deliveries.filter.to': 'Đến',
  'deliveries.filter.clear': 'Xóa bộ lọc',
  'deliveries.filter.dateHint': 'Ngày tính theo giờ UTC và bao gồm cả ngày.',
  'deliveries.count': { other: 'Đang hiển thị {count} lượt gửi.' },
  'deliveries.count.more': 'Còn nữa.',
  'deliveries.count.end': 'Đó là toàn bộ các lượt gửi phù hợp.',
  'deliveries.loadMore': 'Tải thêm',
  'deliveries.loadingMore': 'Đang tải…',
  'deliveries.tableLabel': 'Các lượt gửi, mới nhất trước',
  'deliveries.col.state': 'Kết quả',
  'deliveries.col.integration': 'Tích hợp',
  'deliveries.col.destination': 'Gửi đến',
  'deliveries.col.attempts': 'Số lần thử',
  'deliveries.col.updated': 'Thay đổi gần nhất',
  'deliveries.col.details': 'Chi tiết',
  'deliveries.details': 'Chi tiết',
  'deliveries.detailsFor': 'Chi tiết lượt gửi đến {name}, {state}',
  'deliveries.redelivery': 'Gửi lại',
  'deliveries.redelivery.of': 'Gửi lại một lượt gửi trước đó',
  'deliveries.integrationDeleted': 'Tích hợp đã xóa',
  'deliveries.empty.none.title': 'Chưa có lượt gửi nào',
  'deliveries.empty.none.body':
    'Khi một sự kiện GitHub đến một tích hợp của bạn, mỗi thông báo Noti gửi đi sẽ hiện ở đây cùng kết quả của nó.',
  'deliveries.empty.filtered.title': 'Không có lượt gửi nào khớp với bộ lọc',
  'deliveries.empty.filtered.body':
    'Không có gì khớp với kết quả, tích hợp và khoảng ngày bạn đã chọn. Hãy xóa bộ lọc để xem tất cả.',
  'deliveries.error.title': 'Chúng tôi không tải được nhật ký gửi.',
  'deliveries.error.body': 'Chưa có gì bị thay đổi. Nhật ký có thể chưa cập nhật cho đến khi tải xong.',
  'deliveries.error.stale': 'Danh sách này có thể đã cũ: lần làm mới gần nhất bị lỗi.',
  'deliveries.retry': 'Thử lại',
  'deliveries.error.notFound': 'Lượt gửi này không thuộc không gian làm việc này.',
  'deliveries.error.conflict': 'Hiện chưa thể gửi lại lượt gửi này.',

  // --- Delivery states ----------------------------------------------------------------
  'delivery.state.pending': 'Đang chờ',
  'delivery.state.claimed': 'Đang gửi',
  'delivery.state.sent': 'Đã gửi tới nơi',
  'delivery.state.accepted': 'Đã tiếp nhận',
  'delivery.state.retrying': 'Đang thử lại',
  'delivery.state.dead_lettered': 'Thất bại',
  'delivery.state.suppressed': 'Đã bỏ qua',
  'delivery.state.pending.meaning': 'Noti đã nhận được thông báo và sẽ gửi đi trong giây lát.',
  'delivery.state.claimed.meaning': 'Noti đang gửi thông báo này.',
  'delivery.state.sent.meaning': 'Nơi nhận đã xác nhận là đã nhận được thông báo này.',
  'delivery.state.accepted.meaning':
    'Nơi nhận đã tiếp nhận thông báo này nhưng không xác nhận được là nó đã hiển thị. Nhiều khả năng nó đã đến nơi; Noti không thể cam kết như vậy.',
  'delivery.state.retrying.meaning': 'Lần thử gần nhất không thành công. Noti sẽ tự thử lại.',
  'delivery.state.dead_lettered.meaning':
    'Noti đã ngừng thử. Thông báo không được gửi tới nơi trong lần thử này.',
  'delivery.state.suppressed.meaning':
    'Noti nhận ra đây là bản trùng của một thông báo đã xử lý, nên không gửi lại.',

  // --- Delivery detail --------------------------------------------------------
  'delivery.detail.title': 'Lượt gửi đến {name}',
  'delivery.detail.close': 'Đóng chi tiết',
  'delivery.detail.loading': 'Đang tải chi tiết…',
  'delivery.detail.error': 'Chúng tôi không tải được các chi tiết này. Phần tóm tắt ở trên vẫn đúng.',
  'delivery.detail.whatHappened': 'Chuyện gì đã xảy ra',
  'delivery.detail.whatNext': 'Việc cần làm',
  'delivery.detail.nextRetry': 'Lần thử tiếp theo: {time}.',
  'delivery.detail.retryable': 'Noti đã dừng sau khi hết số lần thử lại.',
  'delivery.detail.permanent':
    'Noti không thử lại, vì thử lại sẽ lỗi y như vậy cho đến khi nguyên nhân được khắc phục.',
  'delivery.detail.fixLink': 'Mở cài đặt tích hợp',
  'delivery.detail.noFix': 'Bạn thay đổi gì cũng không giúp được; gửi lại sau có thể sẽ được.',
  'delivery.detail.facts': 'Bản ghi',
  'delivery.detail.attempts': 'Số lần thử',
  'delivery.detail.created': 'Thời điểm tạo',
  'delivery.detail.updated': 'Thay đổi gần nhất',
  'delivery.detail.id': 'Mã lượt gửi',
  'delivery.detail.replayOf': 'Gửi lại của',
  'delivery.detail.destination': 'Gửi đến',
  'delivery.detail.timeline': 'Những gì Noti đã ghi lại',
  'delivery.detail.timeline.note':
    'Noti ghi lại thời điểm một lượt gửi được tạo, lần thử đầu tiên và gần nhất, và lúc nó dừng lại. Noti không lưu nhật ký của từng lần thử.',
  'delivery.timeline.created': 'Đã tạo',
  'delivery.timeline.first_attempt': 'Lần thử đầu tiên',
  'delivery.timeline.last_attempt': 'Lần thử gần nhất',
  'delivery.timeline.next_attempt': 'Lần thử tiếp theo đã được lên lịch',
  'delivery.timeline.dead_lettered': 'Noti đã ngừng thử',
  'delivery.detail.replays': 'Các lần gửi lại của lượt gửi này',
  'delivery.detail.replays.none': 'Chưa có.',
  'delivery.detail.support': 'Chi tiết cho bộ phận hỗ trợ',
  'delivery.detail.supportCode': 'Mã lỗi',
  'delivery.detail.supportId': 'Mã lượt gửi',
  'delivery.detail.noMessage': 'Noti không có thêm giải thích nào cho lỗi này.',

  // --- Redeliver --------------------------------------------------------------
  'redeliver.button': 'Gửi lại',
  'redeliver.title': 'Gửi lại thông báo này?',
  'redeliver.body':
    'Noti sẽ gửi lại thông báo gốc đến {destination} dưới dạng một lượt gửi mới. Lượt gửi bị lỗi vẫn nằm trong nhật ký. Nơi nhận có thể nhận nó nhiều hơn một lần.',
  'redeliver.brokenWarning':
    'Nếu nguyên nhân ở trên chưa được khắc phục, lần này nhiều khả năng sẽ lại lỗi. Hãy khắc phục trước nếu có thể.',
  'redeliver.confirm': 'Có, gửi lại',
  'redeliver.sending': 'Đang xếp hàng…',
  'redeliver.cancel': 'Hủy',
  'redeliver.queued':
    'Đã xếp hàng thành một lượt gửi mới. Nó sẽ hiện trong nhật ký ngay khi Noti gửi đi. Điều này chưa có nghĩa là nó đã đến nơi.',
  'redeliver.already':
    'Một lượt gửi lại của thông báo này đã được xếp hàng từ trước, nên Noti không gửi thêm.',
  'redeliver.viewNew': 'Xem lượt gửi mới',
  'redeliver.adminOnly':
    'Chỉ quản trị viên không gian làm việc mới gửi lại được. Hãy nhờ quản trị viên nếu thông báo này quan trọng.',
  'redeliver.inFlight': 'Một lượt gửi lại đang ở trạng thái {state}. Hãy xem các lượt gửi lại bên dưới.',
  'redeliver.succeeded': 'Thông báo này đã được gửi lại và lượt gửi lại đã thành công.',
  'redeliver.integration.missing': 'Tích hợp mà thông báo này đã đi qua đã bị xóa, nên không thể gửi lại.',
  'redeliver.integration.disabled':
    'Tích hợp này đang tạm dừng. Hãy bật lại trong phần cài đặt của nó trước, rồi quay lại để gửi lại.',
  'redeliver.integration.quarantined':
    'Noti đã ngừng dùng webhook URL đã lưu của tích hợp này. Hãy dán lại URL trong phần cài đặt của nó trước, rồi quay lại để gửi lại.',
  'redeliver.notOffered': 'Chỉ các lượt gửi bị lỗi mới gửi lại được. Lượt gửi này không bị lỗi.',
  'redeliver.deletionPending':
    'Không gian làm việc này đang được lên lịch xóa, nên không thể gửi lại gì cả. Hãy hủy việc xóa trong Cài đặt trước.',

  // --- Failure explanations ----------------------------------------------------
  'errors.destination_url_rejected':
    'Địa chỉ đã lưu không phải là địa chỉ mà Noti được phép gửi đến, nên nó không được dùng.',
  'errors.destination_credentials_invalid':
    '{destination} đã từ chối thông tin xác thực mà Noti đã lưu. Hãy thay webhook URL để khắc phục.',
  'errors.destination_revoked':
    'Kết nối này đã bị gỡ trong {destination}, nên không thể gửi thông báo đến đó. Hãy tạo một webhook mới ở đó và thay URL.',
  'errors.destination_unauthorized':
    '{destination} đã từ chối yêu cầu. Kết nối có thể cần quyền mới hoặc một webhook URL mới.',
  'errors.destination_rate_limited': '{destination} đề nghị Noti gửi chậm lại. Noti sẽ tự thử lại.',
  'errors.destination_unavailable':
    '{destination} không phản hồi. Noti tự thử lại, và đã bỏ cuộc với thông báo này sau khi hết số lần thử lại.',
  'errors.payload_too_large':
    'Thông báo này lớn hơn mức {destination} chấp nhận. Không thể gửi nó nguyên như vậy.',
  'errors.render_failed': 'Noti không dựng được từ sự kiện này một tin nhắn mà nơi nhận chấp nhận.',
  'errors.config_invalid':
    'Tích hợp này có một cài đặt mà Noti không đọc được. Hãy mở phần cài đặt và lưu lại.',
  'errors.internal_error': 'Đã có sự cố ở phía Noti. Thông báo của bạn không bị mất và có thể được gửi lại.',

  // --- Workspace data and deletion --------------------------------------------------
  'workspace.export.title': 'Xuất dữ liệu không gian làm việc',
  'workspace.export.body':
    'Tải về một tệp JSON gồm các thành viên, tích hợp, kết nối GitHub của không gian làm việc, cùng tối đa 2.000 lượt gửi và sự kiện kiểm toán gần nhất. Tệp không bao giờ chứa webhook URL, signing secret hay thông tin xác thực khác.',
  'workspace.export.button': 'Tải tệp xuất',
  'workspace.export.exporting': 'Đang chuẩn bị…',
  'workspace.export.done': 'Đã tải tệp xuất {file}.',
  'workspace.export.truncated': 'Còn các lượt gửi hoặc sự kiện kiểm toán cũ hơn mà tệp này không bao gồm.',
  'workspace.export.error': 'Chúng tôi không chuẩn bị được tệp xuất. Chưa có gì bị thay đổi. Hãy thử lại.',
  'workspace.adminOnly':
    'Chỉ quản trị viên không gian làm việc mới làm được việc này. Vai trò của bạn là thành viên.',
  'workspace.danger.title': 'Xóa không gian làm việc',
  'workspace.danger.intro':
    'Xóa một không gian làm việc sẽ dừng toàn bộ thông báo của nó và, sau thời gian chờ 7 ngày, xóa vĩnh viễn dữ liệu của nó.',
  'workspace.danger.point1': 'Ngay lập tức: mọi tích hợp bị tạm dừng và không có gì được gửi thêm.',
  'workspace.danger.point2':
    'Trong 7 ngày: bạn có thể hủy, và các tích hợp đang bật trước đó sẽ được bật lại.',
  'workspace.danger.point3':
    'Sau 7 ngày: các tích hợp, lịch sử gửi, thành viên, nhật ký kiểm toán và chính không gian làm việc bị xóa. Các webhook URL đã lưu sẽ không thể khôi phục.',
  'workspace.danger.backup':
    'Bản sao lưu: Cloudflare D1 Time Travel có thể khôi phục cơ sở dữ liệu về bất kỳ thời điểm nào trong 30 ngày qua, nên dữ liệu đã xóa có thể còn nằm trong lịch sử theo thời điểm của Cloudflare tối đa 30 ngày sau khi bị xóa hẳn. Noti không cam kết xóa nhanh hơn mức đó.',
  'workspace.danger.exportFirst': 'Hãy xuất dữ liệu trước nếu bạn có thể cần đến nó.',
  'workspace.danger.button': 'Xóa không gian làm việc…',
  'workspace.danger.loading': 'Đang kiểm tra trạng thái xóa…',
  'workspace.danger.error': 'Chúng tôi không kiểm tra được việc xóa đã được lên lịch hay chưa.',
  'workspace.danger.scheduled.title': 'Việc xóa đã được lên lịch',
  'workspace.danger.scheduled.body':
    'Các tích hợp đang tạm dừng và không có gì được gửi đi. Mọi thứ sẽ bị xóa vĩnh viễn sau {date}.',
  'workspace.danger.purgeStarted': 'Việc xóa đã bắt đầu và không thể hủy được nữa.',
  'workspace.danger.cancel': 'Hủy việc xóa',
  'workspace.danger.cancelling': 'Đang hủy…',
  'workspace.danger.cancelled': 'Đã hủy việc xóa. Các tích hợp đang bật trước đó đã được bật lại.',
  'workspace.danger.dialog.title': 'Xóa {name}?',
  'workspace.danger.dialog.body':
    'Việc này tạm dừng mọi tích hợp ngay bây giờ và xóa vĩnh viễn không gian làm việc sau 7 ngày, trừ khi bạn hủy. Hãy nhập tên không gian làm việc để xác nhận.',
  'workspace.danger.dialog.label': 'Nhập {name} để xác nhận',
  'workspace.danger.dialog.keep': 'Giữ không gian làm việc',
  'workspace.danger.dialog.confirm': 'Lên lịch xóa',
  'workspace.danger.dialog.scheduling': 'Đang lên lịch…',
  'workspace.error.wrongName':
    'Tên này không khớp với tên không gian làm việc. Hãy nhập chính xác, kể cả chữ hoa.',
  'workspace.error.already': 'Việc xóa không gian làm việc này đã được lên lịch.',
  'workspace.error.purgeStarted': 'Việc xóa đã bắt đầu và không thể hủy được nữa.',
} as const satisfies Record<keyof typeof en, string | PluralMessage>;
