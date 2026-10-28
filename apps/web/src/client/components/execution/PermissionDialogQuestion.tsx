import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import type { PermissionRequest } from '@accomplish_ai/agent-core';
import { cn } from '@/lib/utils';

interface PermissionDialogQuestionProps {
  permissionRequest: PermissionRequest;
  selectedOptions: string[];
  setSelectedOptions: (opts: string[]) => void;
  customResponse: string;
  setCustomResponse: (v: string) => void;
  onSubmit: () => void;
  /** SEC-1: ask text matched credential-request language. */
  credentialFlagged?: boolean;
  /** SEC-1: composed answer matches a high-confidence secret shape. */
  answerBlocked?: boolean;
}

/**
 * SEC-1: when the ask invites credential entry, the card shows a standing
 * warning + manual-browser-authentication alternative; a secret-shaped
 * answer is blocked from submission (the block re-enables as soon as the
 * answer is edited to a safe one). Cancel/Decline is never blocked.
 */
export function PermissionDialogQuestion({
  permissionRequest,
  selectedOptions,
  setSelectedOptions,
  customResponse,
  setCustomResponse,
  onSubmit,
  credentialFlagged,
  answerBlocked,
}: PermissionDialogQuestionProps) {
  const { t } = useTranslation('execution');
  useEffect(() => {
    setSelectedOptions([]);
    setCustomResponse('');
  }, [permissionRequest, setCustomResponse, setSelectedOptions]);

  return (
    <>
      <p className="text-sm text-foreground mb-4">{permissionRequest.question}</p>

      {credentialFlagged && (
        <div
          data-testid="credential-warning"
          className="mb-4 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2.5"
        >
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
            <div className="text-xs">
              <p className="font-medium text-red-600 dark:text-red-400">
                {t('permission.credential.warning')}
              </p>
              <p className="text-muted-foreground mt-1">{t('permission.credential.manualAuth')}</p>
              {answerBlocked && (
                <p
                  data-testid="credential-blocked"
                  className="mt-1.5 font-medium text-red-600 dark:text-red-400"
                >
                  {t('permission.credential.blocked')}
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {permissionRequest.options && permissionRequest.options.length > 0 && (
        <div className="mb-4 space-y-2">
          {permissionRequest.options
            .filter((opt) => opt.label.toLowerCase() !== 'other')
            .map((option, idx) => (
              <button
                key={idx}
                type="button"
                aria-pressed={selectedOptions.includes(option.label)}
                onClick={() => {
                  setCustomResponse('');
                  if (permissionRequest.multiSelect) {
                    setSelectedOptions(
                      selectedOptions.includes(option.label)
                        ? selectedOptions.filter((o) => o !== option.label)
                        : [...selectedOptions, option.label],
                    );
                  } else {
                    setSelectedOptions([option.label]);
                  }
                }}
                className={cn(
                  'w-full text-left p-3 rounded-lg border transition-colors',
                  selectedOptions.includes(option.label)
                    ? 'border-primary bg-primary/10'
                    : 'border-border hover:border-primary/50',
                )}
              >
                <div className="font-medium text-sm">{option.label}</div>
                {option.description && (
                  <div className="text-xs text-muted-foreground mt-1">{option.description}</div>
                )}
              </button>
            ))}
        </div>
      )}

      {permissionRequest.options && permissionRequest.options.length > 0 && (
        <div className="flex items-center gap-3 mb-4">
          <div className="flex-1 h-px bg-border" />
          <span className="text-xs text-muted-foreground">or type your own</span>
          <div className="flex-1 h-px bg-border" />
        </div>
      )}

      <div className="mb-4">
        <textarea
          value={customResponse}
          onChange={(e) => {
            setSelectedOptions([]);
            setCustomResponse(e.target.value);
            e.target.style.height = 'auto';
            e.target.style.height = `${e.target.scrollHeight}px`;
          }}
          placeholder="Enter a different option..."
          aria-label="Custom response"
          maxLength={10000}
          rows={1}
          className="w-full resize-none overflow-hidden rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
          style={{ minHeight: '38px', maxHeight: '150px' }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) {
              return;
            }
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && customResponse.trim()) {
              e.preventDefault();
              onSubmit();
            }
          }}
        />
      </div>
    </>
  );
}
