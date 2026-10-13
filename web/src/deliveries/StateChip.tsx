import type { ComponentType } from 'react';
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconCircleDashedCheck,
  IconClock,
  IconCopyOff,
  IconRefresh,
  IconSend,
} from '@tabler/icons-react';
import { t } from '../i18n';
import type { DeliveryState } from './api';
import { STATE_LABEL } from './copy';

type Tone = 'success' | 'neutral' | 'warning' | 'danger';

/** Each state has its own word and its own shape: colour is never the only signal (WCAG 1.4.1). */
const CHIP: Readonly<
  Record<DeliveryState, { icon: ComponentType<{ size?: number; 'aria-hidden'?: boolean }>; tone: Tone }>
> = {
  pending: { icon: IconClock, tone: 'neutral' },
  claimed: { icon: IconSend, tone: 'neutral' },
  sent: { icon: IconCircleCheck, tone: 'success' },
  accepted: { icon: IconCircleDashedCheck, tone: 'neutral' },
  retrying: { icon: IconRefresh, tone: 'warning' },
  dead_lettered: { icon: IconAlertTriangle, tone: 'danger' },
  suppressed: { icon: IconCopyOff, tone: 'neutral' },
};

export function StateChip({ state }: { readonly state: DeliveryState }) {
  const { icon: Icon, tone } = CHIP[state];
  return (
    <span className={`badge state-chip badge-${tone}`}>
      <Icon size={14} aria-hidden={true} />
      {t(STATE_LABEL[state])}
    </span>
  );
}
