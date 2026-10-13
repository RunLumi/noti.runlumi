import type { PluralMessage } from './messages.en';
import type { filtersEn } from './messages.filters.en';

/**
 * Vietnamese copy for routing filters (ADR 0010); same register and glossary as
 * `messages.vi.ts`. "Held back" is "giữ lại" (not sent, on purpose), "skipped" is "bỏ qua".
 * Branch, label, draft and bot are developer terms and stay English where people see them in
 * GitHub.
 */
export const filtersVi = {
  'filters.title': 'Bộ lọc',
  'filters.intro':
    'Bộ lọc giúp tích hợp này bớt ồn hơn. Một cập nhật chỉ được gửi nếu nó qua được mọi bộ lọc bạn đặt. Khi không có bộ lọc nào, mọi cập nhật bạn đã chọn ở trên đều được gửi.',
  'filters.honest':
    'Bộ lọc không bao giờ thêm cập nhật và không bao giờ đổi người nhìn thấy chúng; chúng chỉ giữ lại những cập nhật mà tích hợp này lẽ ra đã gửi. Nếu một cập nhật thiếu thông tin mà bộ lọc cần, cập nhật đó bị giữ lại và nhật ký ghi rõ điều này. Noti lưu một nhật ký ngắn về những gì đã bị giữ lại và lý do; Noti không lưu chính các sự kiện.',

  'filters.branches.title': 'Branch',
  'filters.branches.hint':
    'Áp dụng cho push, pull request và workflow run. Bộ lọc kiểm tra branch nơi công việc diễn ra.',
  'filters.branchAllow': 'Chỉ các branch này',
  'filters.branchAllow.hint': 'Mỗi dòng một branch. Để trống để cho phép mọi branch.',
  'filters.branchDeny': 'Không bao giờ các branch này',
  'filters.branchDeny.hint': 'Mỗi dòng một branch. Branch có trong danh sách này luôn bị bỏ qua.',
  'filters.patternHelp':
    'Dùng * cho một phần của tên (release/*) và ** để gồm cả dấu gạch chéo (release/**). Không phân biệt chữ hoa, chữ thường.',

  'filters.base.title': 'Branch đích của pull request',
  'filters.base.hint': 'Áp dụng cho pull request. Bộ lọc kiểm tra branch mà pull request muốn merge vào.',
  'filters.baseAllow': 'Chỉ khi merge vào các branch này',
  'filters.baseAllow.hint': 'Mỗi dòng một branch, ví dụ main. Để trống để cho phép mọi branch đích.',
  'filters.baseDeny': 'Không bao giờ khi merge vào các branch này',
  'filters.baseDeny.hint': 'Mỗi dòng một branch.',

  'filters.people.title': 'Người và bot',
  'filters.people.hint':
    'Áp dụng cho mọi cập nhật. Tài khoản GitHub đã bị xóa không bao giờ bị bỏ qua, vì bỏ lỡ một lỗi mà bạn không còn truy ra được người gây ra còn tệ hơn một tin nhắn dư.',
  'filters.bots': 'Cập nhật từ bot',
  'filters.bots.any': 'Gửi các cập nhật đó',
  'filters.bots.exclude': 'Bỏ qua các cập nhật đó',
  'filters.bots.only': 'Chỉ gửi cập nhật từ bot',
  'filters.peopleAllow': 'Chỉ những người này',
  'filters.peopleAllow.hint':
    'Tên người dùng GitHub, mỗi dòng một tên. Để trống để cho phép tất cả mọi người.',
  'filters.peopleDeny': 'Không bao giờ những người này',
  'filters.peopleDeny.hint': 'Tên người dùng GitHub, mỗi dòng một tên, ví dụ dependabot[bot].',

  'filters.drafts.title': 'Pull request nháp (draft)',
  'filters.drafts.label': 'Bỏ qua các cập nhật về pull request nháp',
  'filters.drafts.hint':
    'Bạn vẫn nhận được thông báo về một pull request khi nó được đánh dấu sẵn sàng để review.',

  'filters.labels.title': 'Label',
  'filters.labels.hint':
    'Áp dụng cho issue và pull request. Việc so khớp theo toàn bộ tên label, không theo một phần của tên.',
  'filters.labelsInclude': 'Chỉ khi có một trong các label này',
  'filters.labelsInclude.hint': 'Mỗi dòng một label. Để trống để cho phép mọi label.',
  'filters.labelsExclude': 'Không bao giờ khi có bất kỳ label nào trong số này',
  'filters.labelsExclude.hint': 'Mỗi dòng một label.',

  'filters.error.pattern':
    'Dòng {line}: chỉ dùng chữ cái, chữ số, / . _ - và ký tự đại diện * và **. Các ký tự ? [ ] { } + và dấu ! ở đầu không được hỗ trợ.',
  'filters.error.login':
    'Dòng {line}: hãy dùng một tên người dùng GitHub, ví dụ octocat hoặc dependabot[bot]. Không thể lọc theo tên giữ chỗ của người dùng đã bị xóa.',
  'filters.error.label': 'Dòng {line}: hãy dùng tên label dài tối đa 100 ký tự.',
  'filters.error.entry': 'Dòng {line}: mục này không hợp lệ.',
  'filters.error.tooMany': 'Danh sách này chỉ được tối đa 32 dòng.',
  'filters.error.total': 'Tổng số mục quá nhiều. Hãy bớt đi, tối đa 128 mục trên tất cả các bộ lọc.',
  'filters.error.generic': 'Các bộ lọc này không hợp lệ. Hãy kiểm tra từng danh sách.',

  'filters.save': 'Lưu bộ lọc',
  'filters.saving': 'Đang lưu…',
  'filters.saved': 'Đã lưu bộ lọc. Bộ lọc áp dụng từ cập nhật tiếp theo.',
  'filters.clear': 'Xóa mọi bộ lọc',
  'filters.unsaved': 'Bạn có thay đổi bộ lọc chưa lưu.',
  'filters.none': 'Không có bộ lọc. Mọi cập nhật bạn đã chọn đều được gửi.',
  'filters.invalidStored.title': 'Không đọc được các bộ lọc này, nên các cập nhật đang bị giữ lại',
  'filters.invalidStored.body':
    'Noti giữ lại mọi cập nhật của tích hợp này cho đến khi các bộ lọc được thay, vì một quy tắc mà bạn không thấy có thể đang tồn tại để bảo vệ quyền riêng tư. Hãy thay các bộ lọc để tiếp tục.',

  'filters.summary.none': 'Không có',
  'filters.summary.count': { other: '{count} bộ lọc đang bật' },
  'filters.name.branch': 'Branch',
  'filters.name.baseBranch': 'Branch đích của pull request',
  'filters.name.actor': 'Người và bot',
  'filters.name.draft': 'Pull request nháp (draft)',
  'filters.name.labels': 'Label',
  'filters.review.label': 'Bộ lọc',

  'filters.try.title': 'Thử ngay',
  'filters.try.intro':
    'Mô tả một cập nhật và xem các bộ lọc này có gửi nó hay không. Phần này dùng các bộ lọc đang hiện trên màn hình, dù đã lưu hay chưa. Đây chỉ là kiểm tra, không phải sự kiện thật: không có gì được gửi đi.',
  'filters.try.event': 'Cập nhật',
  'filters.try.branch': 'Branch',
  'filters.try.branch.hint': 'Để trống nếu GitHub sẽ không nêu.',
  'filters.try.base': 'Branch đích của pull request',
  'filters.try.person': 'Người',
  'filters.try.person.hint': 'Tên người dùng GitHub. Để trống nếu không biết.',
  'filters.try.bot': 'Người này có phải là bot không?',
  'filters.try.draft': 'Đây có phải là pull request nháp không?',
  'filters.try.labels': 'Label',
  'filters.try.labels.hint': 'Mỗi dòng một label. Để trống nghĩa là mục này không có label nào.',
  'filters.try.tri.unknown': 'GitHub không nêu',
  'filters.try.tri.yes': 'Có',
  'filters.try.tri.no': 'Không',
  'filters.try.button': 'Kiểm tra cập nhật này',
  'filters.try.invalid': 'Hãy sửa các bộ lọc được đánh dấu ở trên trước, rồi thử lại.',
  'filters.result.sent': 'Sẽ được gửi. Không bộ lọc nào của bạn giữ cập nhật này lại.',
  'filters.result.sentGhost':
    'Sẽ được gửi. Cập nhật này đến từ một tài khoản đã bị xóa, mà bộ lọc không bao giờ bỏ qua.',
  'filters.result.skipped': 'Bị bộ lọc “{filter}” bỏ qua, vì {reason}.',

  'filters.reason.not_in_allow_list': 'nó không có trong danh sách “chỉ” của bạn',
  'filters.reason.in_deny_list': 'nó có trong danh sách “không bao giờ” của bạn',
  'filters.reason.draft_excluded': 'đây là pull request nháp',
  'filters.reason.bot_excluded': 'nó đến từ một bot',
  'filters.reason.not_a_bot': 'nó không đến từ một bot',
  'filters.reason.ghost_exempt': 'nó đến từ một tài khoản đã bị xóa',
  'filters.reason.allowed': 'nó đã qua bộ lọc',
  'filters.reason.not_applicable': 'bộ lọc này không áp dụng cho loại cập nhật này',
  'filters.reason.config_invalid': 'không đọc được các bộ lọc đã lưu của nó, nên nó bị giữ lại cho an toàn',

  'filters.log.title': 'Các quyết định gần đây',
  'filters.log.intro':
    'Những cập nhật gần đây nhất mà Noti đã cân nhắc cho tích hợp này, và chúng đã được gửi hay bị giữ lại. Được lưu 30 ngày. Nhật ký ghi loại sự kiện và lý do, không bao giờ ghi nội dung.',
  'filters.log.empty':
    'Chưa có gì. Các cập nhật sẽ hiện ở đây sau khi Noti nhận được một cập nhật mà tích hợp này đăng ký theo dõi.',
  'filters.log.loading': 'Đang tải các quyết định gần đây…',
  'filters.log.error': 'Chúng tôi không tải được các quyết định gần đây. Bộ lọc của bạn không bị ảnh hưởng.',
  'filters.log.more': 'Hiện các quyết định cũ hơn',
  'filters.log.sent': 'Đã gửi',
  'filters.log.skipped': 'Bị giữ lại',
  'filters.log.unknownNote': 'Thiếu một thông tin',
  'filters.log.entry': '{event}, {outcome}, {when}',
  'filters.reason.unknown_fact':
    'GitHub không báo thông tin mà bộ lọc này kiểm tra, nên cập nhật bị giữ lại cho an toàn',
  'filters.reason.config_newer':
    'các bộ lọc của nó được lưu bởi một phiên bản Noti mới hơn mà phiên bản này không đọc được, nên không có gì bị giữ lại',
  'filters.name.config': 'Bộ lọc đã lưu',
  'filters.replaceInvalid': 'Thay các bộ lọc không hợp lệ',
  'filters.newer.title': 'Các bộ lọc này được lưu bởi một phiên bản Noti mới hơn',
  'filters.newer.body':
    'Phiên bản này không đọc được chúng, nên đang gửi mọi cập nhật bạn đã chọn. Lưu bộ lọc tại đây sẽ thay thế chúng.',
  'filters.appliesTo.branch':
    'Áp dụng cho: push, pull request, workflow run, release và deployment. Với release hoặc deployment, chỉ khi GitHub nêu tên một branch.',
  'filters.appliesTo.base': 'Áp dụng cho: pull request.',
  'filters.appliesTo.people':
    'Áp dụng cho: mọi cập nhật. “Bot” kiểm tra ai gây ra cập nhật (người gửi), không phải ai viết pull request: pull request của một bot được một người merge sẽ không bị bỏ qua.',
  'filters.appliesTo.drafts': 'Áp dụng cho: pull request.',
  'filters.appliesTo.labels': 'Áp dụng cho: issue, bình luận trên issue và pull request.',
  'filters.coverage.blocking':
    'Danh sách “chỉ” trong bộ lọc “{filter}” không thể áp dụng cho: {events}. Danh sách sẽ không được thực thi với chúng. Hãy bỏ các cập nhật đó trong mục “Cập nhật cần gửi”, hoặc bỏ danh sách này.',
  'filters.coverage.warning': 'Bộ lọc “{filter}” không áp dụng cho: {events}. Các cập nhật đó vẫn được gửi.',
  'filters.error.coverageEvents':
    'Các bộ lọc của bạn không áp dụng được cho một số cập nhật này ({filters}). Hãy bỏ các cập nhật đó, hoặc đổi bộ lọc trước.',
  'filters.caseNote':
    'Tên branch và label được so sánh mà không phân biệt chữ hoa, chữ thường, nên “Main” và “main” là một.',
} as const satisfies Record<keyof typeof filtersEn, string | PluralMessage>;
