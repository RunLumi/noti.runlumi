import type { ButtonHTMLAttributes, InputHTMLAttributes, HTMLAttributes, ReactNode, Ref } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { cn } from '../lib/utils';
export function Button({
  className,
  variant = 'primary',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'outline' | 'ghost' | 'danger';
  ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      className={cn(
        'btn',
        variant === 'outline'
          ? 'btn-outline'
          : variant === 'ghost'
            ? 'btn-ghost'
            : variant === 'danger'
              ? 'btn-danger'
              : 'btn-primary',
        className,
      )}
      {...props}
    />
  );
}
export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn('input', className)} {...props} />;
}
export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('card', className)} {...props} />;
}
export function Badge({
  children,
  variant = 'neutral',
}: {
  children: ReactNode;
  variant?: 'neutral' | 'success' | 'warning' | 'danger';
}) {
  return <span className={'badge badge-' + variant}>{children}</span>;
}
/** Inline status or error message. Errors are announced (`role="alert"`), the rest politely. */
export function Notice({
  children,
  kind = 'info',
  className,
}: {
  children: ReactNode;
  kind?: 'info' | 'error' | 'warning' | 'success';
  className?: string;
}) {
  return (
    <div className={cn('notice', 'notice-' + kind, className)} role={kind === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}
export function Modal({
  trigger,
  title,
  children,
}: {
  trigger: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <Dialog.Root>
      <Dialog.Trigger render={<span className="inline-trigger" />}>{trigger}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="modal-backdrop" />
        <Dialog.Popup className="modal">
          <Dialog.Title className="modal-title">{title}</Dialog.Title>
          {children}
          <Dialog.Close
            render={
              <button className="modal-close" aria-label="Close dialog">
                ×
              </button>
            }
          />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
