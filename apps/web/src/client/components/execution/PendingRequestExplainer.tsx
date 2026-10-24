import { useTranslation } from 'react-i18next';
import { Info } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface PendingRequestExplainerProps {
  /** Raw daemon message from the rejected reply, when present. */
  message?: string | null;
  onResume?: () => void;
  onDismiss?: () => void;
  testId?: string;
}

/**
 * M6-A T3 — explainer for a paused task whose pending request can no longer
 * be answered (plan D5: permission decisions are never replayed after a
 * reconnect/restart; the reply is rejected by the daemon's guardrails and
 * the UI explains instead of replaying). Used in two contexts:
 *   - replacing the reply controls of a card whose response was rejected,
 *   - as the inline notice for a waiting task that has no displayable card.
 */
export function PendingRequestExplainer({
  message,
  onResume,
  onDismiss,
  testId,
}: PendingRequestExplainerProps) {
  const { t } = useTranslation('execution');
  return (
    <div
      data-testid={testId ?? 'pending-request-explainer'}
      className="flex flex-col gap-3"
      role="alert"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-muted/60 shrink-0">
          <Info className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="text-sm">
          <p className="font-medium text-foreground">{t('permission.expired.title')}</p>
          <p className="text-muted-foreground mt-1">{t('permission.expired.body')}</p>
        </div>
      </div>
      {message && (
        <p
          data-testid="pending-request-explainer-message"
          className="text-xs text-muted-foreground bg-muted/40 rounded-md px-2 py-1.5 break-words"
        >
          {message}
        </p>
      )}
      {(onResume || onDismiss) && (
        <div className="flex gap-3">
          {onResume && (
            <Button
              onClick={onResume}
              className="flex-1"
              data-testid="pending-request-resume-button"
            >
              {t('permission.expired.resume')}
            </Button>
          )}
          {onDismiss && (
            <Button
              variant="outline"
              onClick={onDismiss}
              className="flex-1"
              data-testid="pending-request-dismiss-button"
            >
              {t('permission.expired.dismiss')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
