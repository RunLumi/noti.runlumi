import { describe, expect, it } from 'vitest';
import { parseDevice } from './device';

const UA = {
  chromeMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  safariMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  firefoxWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0',
  edgeWin:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
  safariPhone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  chromePhoneIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1',
  safariPad:
    'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  chromeAndroid:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  chromeAndroidTablet:
    'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  samsung:
    'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
  operaLinux:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0',
  chromeOs:
    'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
};

describe('parseDevice', () => {
  it.each([
    ['chromeMac', 'Chrome', 'macOS', 'computer'],
    ['safariMac', 'Safari', 'macOS', 'computer'],
    ['firefoxWin', 'Firefox', 'Windows', 'computer'],
    ['edgeWin', 'Edge', 'Windows', 'computer'],
    ['safariPhone', 'Safari', 'iOS', 'phone'],
    ['chromePhoneIos', 'Chrome', 'iOS', 'phone'],
    ['safariPad', 'Safari', 'iOS', 'tablet'],
    ['chromeAndroid', 'Chrome', 'Android', 'phone'],
    ['chromeAndroidTablet', 'Chrome', 'Android', 'tablet'],
    ['samsung', 'Samsung Internet', 'Android', 'phone'],
    ['operaLinux', 'Opera', 'Linux', 'computer'],
    ['chromeOs', 'Chrome', 'ChromeOS', 'computer'],
  ] as const)('%s', (key, browser, os, kind) => {
    expect(parseDevice(UA[key])).toEqual({ browser, os, kind });
  });

  it('shows an unrecognised or missing user agent as unknown rather than guessing', () => {
    expect(parseDevice('curl/8.4.0')).toEqual({ browser: null, os: null, kind: 'computer' });
    expect(parseDevice('')).toEqual({ browser: null, os: null, kind: 'computer' });
    expect(parseDevice(null)).toEqual({ browser: null, os: null, kind: 'computer' });
    expect(parseDevice(undefined)).toEqual({ browser: null, os: null, kind: 'computer' });
  });

  it('is not fooled by hostile text: it matches names, it does not echo the string', () => {
    const device = parseDevice('<script>alert(1)</script> Chrome/1 \u202e Macintosh');
    expect(device.browser).toBe('Chrome');
    expect(JSON.stringify(device)).not.toContain('script');
  });
});
