import { useEffect, useRef, useState } from 'react';
import { IconCheck, IconCopy } from '@tabler/icons-react';
import { Button } from '../components/ui';
import { t, type MessageId } from '../i18n';
import { useLocale } from '../i18n/LocaleProvider';

interface CopyButtonProps {
  readonly text: string;
  readonly label: MessageId;
  readonly copied: MessageId;
  readonly failed: MessageId;
  /** Accessible name when several copy buttons share a screen. */
  readonly ariaLabel?: string;
}

type State = 'idle' | 'copied' | 'failed';

/**
 * Copies with the async Clipboard API. The outcome is stated in text and in a polite live
 * region (never colour alone), and a failure tells the person to copy by hand instead of
 * pretending it worked.
 */
export function CopyButton({ text, label, copied, failed, ariaLabel }: CopyButtonProps) {
  useLocale();
  const [state, setState] = useState<State>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = async () => {
    let next: State = 'copied';
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      next = 'failed';
    }
    setState(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 4000);
  };
  return (
    <span className="copy-control">
      <Button type="button" variant="outline" aria-label={ariaLabel} onClick={() => void copy()}>
        {state === 'copied' ? (
          <IconCheck size={18} aria-hidden="true" />
        ) : (
          <IconCopy size={18} aria-hidden="true" />
        )}
        {t(state === 'copied' ? copied : label)}
      </Button>
      <span className="copy-status" role="status" aria-live="polite">
        {state === 'failed' ? t(failed) : ''}
      </span>
    </span>
  );
}
