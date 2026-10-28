import { useState } from 'react';
import { motion } from 'framer-motion';
import { springs } from '../../lib/animations';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { AlertTriangle, AlertCircle, File, Brain, Hand, Clock3 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import type { PermissionRequest } from '@accomplish_ai/agent-core/common';
import { isAssistanceRequest, formatWaitAge } from '../../lib/assistance-requests';
import { isCredentialFlaggedRequest } from '../../lib/credential-guard';
import { isCredentialUnsafeAnswer } from '@accomplish_ai/agent-core/common';
import { isDeleteOperation, getDisplayFilePaths } from './permission-utils';
import { PermissionDialogFile } from './PermissionDialogFile';
import { PermissionDialogQuestion } from './PermissionDialogQuestion';
import { PermissionDialogTool } from './PermissionDialogTool';
import { PendingRequestExplainer } from './PendingRequestExplainer';

interface PermissionDialogProps {
  permissionRequest: PermissionRequest;
  onRespond: (allowed: boolean, selectedOptions?: string[], customText?: string) => void;
  /** Card was rebuilt from the persisted pending-request record (M6-A T3). */
  isRestored?: boolean;
  /** Daemon rejected the last reply (replay guardrails) — explain instead of replaying. */
  pendingRequestError?: string | null;
  onResume?: () => void;
  onDismissError?: () => void;
}

interface AssistanceContextProps {
  permissionRequest: PermissionRequest;
  isRestored?: boolean;
}

/**
 * Assistance context block (M6-A T3): explains WHY the agent paused
 * (human-verification gate it must not bypass), how long it has been
 * waiting, and — for a card rebuilt from the persisted record — that the
 * conversational context survived the reconnect/restart.
 */
function AssistanceContext({ permissionRequest, isRestored }: AssistanceContextProps) {
  const { t } = useTranslation('execution');
  const waitAge = formatWaitAge(permissionRequest.createdAt);
  return (
    <div
      data-testid="assistance-context"
      className="mb-4 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2.5"
    >
      <p className="text-xs text-muted-foreground" data-testid="assistance-explainer">
        {t('permission.assistance.explanation')}
      </p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs mt-2">
        <span className="inline-flex items-center gap-1.5 font-medium text-primary">
          <Hand className="h-3.5 w-3.5" />
          <span data-testid="assistance-waiting-label">
            {t('permission.assistance.waiting')}
            {waitAge ? ' · ' : ''}
            {waitAge}
          </span>
        </span>
        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
          <Clock3 className="h-3.5 w-3.5" />
          <span>{t('permission.assistance.verification')}</span>
        </span>
      </div>
      {isRestored && (
        <p className="text-xs text-muted-foreground mt-2" data-testid="assistance-restored-hint">
          {t('permission.assistance.restoredHint')}
        </p>
      )}
    </div>
  );
}

/**
 * Inline permission / question card for the execution page.
 *
 * Question-type cards whose header matches the shared assistance marker
 * (M6-A D2) render the assistance variant: distinct icon, explicit
 * human-verification copy, wait-age, and Decline/Submit-reply controls.
 * Security permissions (tool/file) and clarifying questions keep the exact
 * Allow/Deny and Cancel/Submit semantics they had before M6-A.
 */
export function PermissionDialog({
  permissionRequest,
  onRespond,
  isRestored,
  pendingRequestError,
  onResume,
  onDismissError,
}: PermissionDialogProps) {
  const [selectedOptions, setSelectedOptions] = useState<string[]>([]);
  const [customResponse, setCustomResponse] = useState('');
  const { t } = useTranslation('execution');

  const isAssistance = isAssistanceRequest(permissionRequest);

  // SEC-1: a question whose ask text matches credential-request language
  // (detection is header-independent) shows a warning + manual-auth guidance
  // and blocks secret-shaped answers, while Cancel/Decline stays available.
  const isCredentialFlagged =
    permissionRequest.type === 'question' && isCredentialFlaggedRequest(permissionRequest);

  const handleRespond = (allowed: boolean) => {
    const isQuestion = permissionRequest.type === 'question';
    const hasCustomText = isQuestion && customResponse.trim();
    // SEC-1 belt-and-braces: never transmit a secret-shaped reply via Submit.
    // (The adapter enforces the same rule daemon-side for every surface.)
    if (isQuestion && allowed && hasCustomText && isCredentialFlagged) {
      if (isCredentialUnsafeAnswer(customResponse.trim(), true)) {
        return;
      }
    }
    onRespond(
      allowed,
      isQuestion ? (hasCustomText ? [] : selectedOptions) : undefined,
      hasCustomText ? customResponse.trim() : undefined,
    );
    setSelectedOptions([]);
    setCustomResponse('');
  };

  const isDelete = isDeleteOperation(permissionRequest);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      data-testid="execution-permission-card"
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 10 }}
        transition={springs.bouncy}
      >
        <Card className="w-full max-w-lg mx-4 max-h-[80vh] flex flex-col overflow-hidden">
          <div className="flex items-start gap-4 p-6 pb-4 shrink-0">
            <div
              className={cn(
                'flex h-10 w-10 items-center justify-center rounded-full shrink-0',
                isDelete
                  ? 'bg-red-500/10'
                  : isAssistance
                    ? 'bg-primary/10'
                    : permissionRequest.type === 'file'
                      ? 'bg-amber-500/10'
                      : permissionRequest.type === 'question'
                        ? 'bg-primary/10'
                        : 'bg-warning/10',
              )}
            >
              {isDelete ? (
                <AlertTriangle className="h-5 w-5 text-red-600" />
              ) : isAssistance ? (
                <Hand className="h-5 w-5 text-primary" />
              ) : permissionRequest.type === 'file' ? (
                <File className="h-5 w-5 text-amber-600" />
              ) : permissionRequest.type === 'question' ? (
                <Brain className="h-5 w-5 text-primary" />
              ) : (
                <AlertCircle className="h-5 w-5 text-warning" />
              )}
            </div>
            <h3
              className={cn('text-lg font-semibold', isDelete ? 'text-red-600' : 'text-foreground')}
            >
              {isDelete
                ? 'File Deletion Warning'
                : isAssistance
                  ? t('permission.assistance.title')
                  : permissionRequest.type === 'file'
                    ? 'File Permission Required'
                    : permissionRequest.type === 'question'
                      ? permissionRequest.header || 'Question'
                      : 'Permission Required'}
            </h3>
          </div>

          <div className="flex-1 overflow-y-auto px-6 min-h-0">
            {pendingRequestError ? (
              <PendingRequestExplainer
                message={pendingRequestError}
                onResume={onResume}
                onDismiss={onDismissError}
                testId="pending-request-expired"
              />
            ) : (
              <>
                {isAssistance && (
                  <AssistanceContext
                    permissionRequest={permissionRequest}
                    isRestored={isRestored}
                  />
                )}
                {permissionRequest.type === 'file' && (
                  <PermissionDialogFile permissionRequest={permissionRequest} />
                )}
                {permissionRequest.type === 'question' && (
                  <PermissionDialogQuestion
                    permissionRequest={permissionRequest}
                    selectedOptions={selectedOptions}
                    setSelectedOptions={setSelectedOptions}
                    customResponse={customResponse}
                    setCustomResponse={setCustomResponse}
                    onSubmit={() => handleRespond(true)}
                    credentialFlagged={isCredentialFlagged}
                    answerBlocked={
                      isCredentialFlagged &&
                      !!customResponse.trim() &&
                      isCredentialUnsafeAnswer(customResponse.trim(), true)
                    }
                  />
                )}
                {permissionRequest.type === 'tool' && (
                  <PermissionDialogTool permissionRequest={permissionRequest} />
                )}
              </>
            )}
          </div>

          {!pendingRequestError && (
            <div className="flex gap-3 p-6 pt-4 shrink-0 border-t border-border">
              <Button
                variant="outline"
                onClick={() => handleRespond(false)}
                className="flex-1"
                data-testid="permission-deny-button"
              >
                {isAssistance
                  ? t('permission.assistance.decline')
                  : permissionRequest.type === 'question'
                    ? 'Cancel'
                    : 'Deny'}
              </Button>
              <Button
                onClick={() => handleRespond(true)}
                className={cn('flex-1', isDelete && 'bg-red-600 hover:bg-red-700 text-white')}
                data-testid="permission-allow-button"
                disabled={
                  (permissionRequest.type === 'question' &&
                    selectedOptions.length === 0 &&
                    !customResponse.trim()) ||
                  (isCredentialFlagged && isCredentialUnsafeAnswer(customResponse.trim(), true))
                }
              >
                {isDelete
                  ? getDisplayFilePaths(permissionRequest).length > 1
                    ? 'Delete All'
                    : 'Delete'
                  : isAssistance
                    ? t('permission.assistance.submit')
                    : permissionRequest.type === 'question'
                      ? 'Submit'
                      : 'Allow'}
              </Button>
            </div>
          )}
        </Card>
      </motion.div>
    </motion.div>
  );
}
