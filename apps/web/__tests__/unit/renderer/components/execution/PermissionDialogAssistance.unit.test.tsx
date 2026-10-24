/**
 * Unit tests for the PermissionDialog assistance variant (M6-A T3):
 * rendering (explainer, wait-age, restored hint), responses (Submit /
 * Decline through the existing plumbing), and error states (daemon
 * guardrail rejection → replay explainer + resume/dismiss).
 *
 * Clarification-mode UX is pinned byte-identical by the pre-existing
 * PermissionDialog.unit.test.tsx suite — this file only covers the
 * assistance additions and the stale-rejection surface.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Import helpers first — they register the vi.mock stubs before PermissionDialog loads
import { createQuestionRequest, createAssistanceRequest } from './permissionDialogTestHelpers';

import { PermissionDialog } from '@/components/execution/PermissionDialog';

describe('PermissionDialog — assistance mode (human-assistance question)', () => {
  it('renders the assistance title, explainer and waiting label', () => {
    const onRespond = vi.fn();
    render(
      <PermissionDialog permissionRequest={createAssistanceRequest()} onRespond={onRespond} />,
    );

    expect(screen.getByText('Human assistance required')).toBeInTheDocument();
    expect(screen.getByTestId('assistance-context')).toBeInTheDocument();
    expect(screen.getByTestId('assistance-explainer')).toBeInTheDocument();
    expect(screen.getByTestId('assistance-waiting-label')).toHaveTextContent(
      'Waiting for your reply',
    );
  });

  it('shows the wait age derived from the request timestamp', () => {
    const onRespond = vi.fn();
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    render(
      <PermissionDialog
        permissionRequest={createAssistanceRequest({ createdAt: fiveMinutesAgo })}
        onRespond={onRespond}
      />,
    );

    expect(screen.getByTestId('assistance-waiting-label')).toHaveTextContent('· 5m');
  });

  it('shows the restored hint only when the card came from the persisted record', () => {
    const onRespond = vi.fn();
    const restored = render(
      <PermissionDialog
        permissionRequest={createAssistanceRequest()}
        onRespond={onRespond}
        isRestored
      />,
    );
    expect(screen.getByTestId('assistance-restored-hint')).toBeInTheDocument();
    restored.unmount();

    render(
      <PermissionDialog permissionRequest={createAssistanceRequest()} onRespond={onRespond} />,
    );
    expect(screen.queryByTestId('assistance-restored-hint')).toBeNull();
  });

  it('renders Decline and Submit reply controls (distinct from Cancel/Allow security semantics)', () => {
    const onRespond = vi.fn();
    render(
      <PermissionDialog permissionRequest={createAssistanceRequest()} onRespond={onRespond} />,
    );

    expect(screen.getByTestId('permission-deny-button')).toHaveTextContent('Decline');
    expect(screen.getByTestId('permission-allow-button')).toHaveTextContent('Submit reply');
  });

  it('Submit sends the selected option through the existing respond plumbing', () => {
    const onRespond = vi.fn();
    render(
      <PermissionDialog permissionRequest={createAssistanceRequest()} onRespond={onRespond} />,
    );

    fireEvent.click(screen.getByText("I'll complete it — please wait").closest('button')!);
    fireEvent.click(screen.getByTestId('permission-allow-button'));

    expect(onRespond).toHaveBeenCalledWith(true, ["I'll complete it — please wait"], undefined);
  });

  it('Submit sends typed free-text answers', () => {
    const onRespond = vi.fn();
    render(
      <PermissionDialog permissionRequest={createAssistanceRequest()} onRespond={onRespond} />,
    );

    const input = screen.getByLabelText('Custom response');
    fireEvent.change(input, { target: { value: 'I completed the CAPTCHA' } });
    fireEvent.click(screen.getByTestId('permission-allow-button'));

    expect(onRespond).toHaveBeenCalledWith(true, [], 'I completed the CAPTCHA');
  });

  it('Decline answers with no payload (deny → honest decline / auto-resume guardrails)', () => {
    const onRespond = vi.fn();
    render(
      <PermissionDialog permissionRequest={createAssistanceRequest()} onRespond={onRespond} />,
    );

    fireEvent.click(screen.getByTestId('permission-deny-button'));

    expect(onRespond).toHaveBeenCalledWith(false, [], undefined);
  });

  it('keeps the submit button disabled until an option or text is provided', () => {
    const onRespond = vi.fn();
    render(
      <PermissionDialog permissionRequest={createAssistanceRequest()} onRespond={onRespond} />,
    );

    expect(screen.getByTestId('permission-allow-button')).toBeDisabled();
  });
});

describe('PermissionDialog — clarification questions unchanged', () => {
  it('keeps Cancel/Submit labels for non-assistance questions', () => {
    const onRespond = vi.fn();
    render(<PermissionDialog permissionRequest={createQuestionRequest()} onRespond={onRespond} />);

    expect(screen.queryByTestId('assistance-context')).toBeNull();
    expect(screen.getByTestId('permission-deny-button')).toHaveTextContent('Cancel');
    expect(screen.getByTestId('permission-allow-button')).toHaveTextContent('Submit');
  });
});

describe('PermissionDialog — daemon rejection (expired/stale) error state', () => {
  const REJECTION =
    'permission.respond: the pending request for task task-123 expired with its previous session (status failed) and is never replayed. Use the existing Resume affordance to continue the task.';

  it('replaces reply controls with the replay explainer, message and resume/dismiss', () => {
    const onRespond = vi.fn();
    const onResume = vi.fn();
    const onDismissError = vi.fn();
    render(
      <PermissionDialog
        permissionRequest={createAssistanceRequest()}
        onRespond={onRespond}
        pendingRequestError={REJECTION}
        onResume={onResume}
        onDismissError={onDismissError}
      />,
    );

    // Reply controls are gone — no Allow/Deny replay surface for a stale request.
    expect(screen.queryByTestId('permission-allow-button')).toBeNull();
    expect(screen.queryByTestId('permission-deny-button')).toBeNull();

    expect(screen.getByTestId('pending-request-expired')).toBeInTheDocument();
    expect(screen.getByTestId('pending-request-explainer-message')).toHaveTextContent(
      'never replayed',
    );

    fireEvent.click(screen.getByTestId('pending-request-resume-button'));
    expect(onResume).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('pending-request-dismiss-button'));
    expect(onDismissError).toHaveBeenCalledTimes(1);
  });

  it('dismissal re-reveals the reply controls (retry is permitted; the daemon re-checks)', async () => {
    const onRespond = vi.fn();
    const onDismissError = vi.fn();
    const { rerender } = render(
      <PermissionDialog
        permissionRequest={createAssistanceRequest()}
        onRespond={onRespond}
        pendingRequestError={REJECTION}
        onDismissError={onDismissError}
      />,
    );
    expect(screen.getByTestId('pending-request-expired')).toBeInTheDocument();

    rerender(
      <PermissionDialog
        permissionRequest={createAssistanceRequest()}
        onRespond={onRespond}
        pendingRequestError={null}
        onDismissError={onDismissError}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('permission-allow-button')).toBeInTheDocument();
    });
  });

  it('renders an explainer without action buttons for restored permission rows (never replayed)', () => {
    const onRespond = vi.fn();
    const onResume = vi.fn();
    render(
      <PermissionDialog
        permissionRequest={createQuestionRequest()}
        onRespond={onRespond}
        pendingRequestError={REJECTION}
        onResume={onResume}
      />,
    );

    expect(screen.getByTestId('pending-request-expired')).toBeInTheDocument();
    expect(screen.getByTestId('pending-request-resume-button')).toBeInTheDocument();
    expect(screen.queryByTestId('pending-request-dismiss-button')).toBeNull();
  });
});
