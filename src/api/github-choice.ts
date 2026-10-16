import { html } from 'hono/html';
import type { InstallationChoice } from '../connectors/sources/github/install';

/** No scripts, no provider payload or access token, and every interpolated value is escaped. */
export function choicePage(
  choices: readonly InstallationChoice[],
  install: string,
  language: 'en' | 'vi' = 'en',
) {
  const text =
    language === 'vi'
      ? {
          title: 'Chọn tài khoản GitHub cần kết nối',
          description:
            'Nhiều tài khoản đã cài Lumi Noti. Hãy chọn một tài khoản cho không gian làm việc này. GitHub sẽ xác minh lại quyền truy cập trước khi kết nối.',
          connect: 'Kết nối',
          install: 'Cài Lumi Noti cho tài khoản khác',
          back: 'Quay lại trang tích hợp',
        }
      : {
          title: 'Choose the account to connect',
          description:
            'Several accounts already have Lumi Noti installed. Choose one for this workspace. GitHub will verify your access again before anything is connected.',
          connect: 'Connect',
          install: 'Install Lumi Noti on another account',
          back: 'Back to integrations',
        };
  return html`<!doctype html>
    <html lang="${language}">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>${text.title} · Lumi Noti</title>
        <link rel="stylesheet" href="/github/connect.css" />
      </head>
      <body>
        <main>
          <p>Lumi Noti / GitHub</p>
          <h1>${text.title}</h1>
          <p>${text.description}</p>
          ${choices.map((choice) => html`<form action="/github/choose" method="post"><input type="hidden" name="state" value="${choice.state}" /><button type="submit">${text.connect} ${choice.account}</button></form>`)}
          <p><a href="${install}">${text.install}</a></p>
          <p><a href="/integrations">${text.back}</a></p>
        </main>
      </body>
    </html>`;
}
export const CONNECTION_CSS = `:root{color-scheme:light}*{box-sizing:border-box}body{margin:0;background:#f4f0e8;color:#172033;font:16px/1.6 system-ui,sans-serif}main{max-width:640px;margin:48px auto;padding:32px;background:#fff;border:1px solid #d9dee8;border-radius:12px}h1{color:#102a43;line-height:1.2;font-weight:560;letter-spacing:-.03em}button{min-height:44px;width:100%;padding:12px 16px;margin:8px 0;background:#006093;color:#fff;border:0;border-radius:8px;font:inherit;cursor:pointer}a{color:#006093}button:hover{background:#004f80}:focus-visible{outline:2px solid #006093;outline-offset:3px}@media(max-width:680px){main{margin:20px;padding:24px}}`;
