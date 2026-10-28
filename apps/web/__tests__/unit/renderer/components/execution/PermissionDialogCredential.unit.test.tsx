/**
 * SEC-1 — PermissionDialog credential-request hardening:
 * warning banner + manual-browser-auth guidance on flagged asks,
 * Submit block on secret-shaped answers, Cancel never blocked,
 * and byte-identical behavior for unflagged clarification questions.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// Import helpers first — they register the vi.mock stubs before PermissionDialog loads
import { createQuestionRequest } from './permissionDialogTestHelpers';

import { PermissionDialog } from '@/components/execution/PermissionDialog';

const FLAGGED_ASK = {
  header: 'GitHub login',
  question: 'I cannot log in without your credentials',
  options: [
    {
      label:
        "Share your GitHub username and password via the custom answer box; I'll fill the form for you",
    },
    { label: 'You enter them yourself in the automation browser' },
  ],
};

describe('PermissionDialog — SEC-1 credential-request handling', () => {
  it('warns on a credential-flagged ask via the adapter stamp (header-independent)', () => {
    const request = createQuestionRequest({
      header: 'A quick question',
      question: 'Which format do you want?',
      credentialRisk: true,
    });
    render(<PermissionDialog permissionRequest={request} onRespond={vi.fn()} />);

    expect(screen.getByTestId('credential-warning')).toBeInTheDocument();
    expect(
      screen.getByText(
        /appears to be asking for a password, code, or other authentication secret/i,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/log in directly on the site/i)).toBeInTheDocument();
  });

  it('warns on a restored (unstamped) ask via text-surface detection — the A7 shape', () => {
    const request = createQuestionRequest(FLAGGED_ASK);
    render(<PermissionDialog permissionRequest={request} onRespond={vi.fn()} />);

    expect(screen.getByTestId('credential-warning')).toBeInTheDocument();
  });

  it('does NOT warn on a legitimate clarification question', () => {
    render(<PermissionDialog permissionRequest={createQuestionRequest()} onRespond={vi.fn()} />);

    expect(screen.queryByTestId('credential-warning')).not.toBeInTheDocument();
  });

  it('blocks Submit while the typed answer is secret-shaped, and re-enables on a safe edit', () => {
    const onRespond = vi.fn();
    const request = createQuestionRequest(FLAGGED_ASK);
    render(<PermissionDialog permissionRequest={request} onRespond={onRespond} />);

    const submit = screen.getByTestId('permission-allow-button');
    const textarea = screen.getByLabelText('Custom response');

    fireEvent.change(textarea, { target: { value: 'password: hunter2secret' } });
    expect(submit).toBeDisabled();
    expect(screen.getByTestId('credential-blocked')).toBeInTheDocument();

    fireEvent.click(submit);
    expect(onRespond).not.toHaveBeenCalled();

    fireEvent.change(textarea, { target: { value: 'I logged in myself in the preview browser' } });
    expect(submit).toBeEnabled();
    expect(screen.queryByTestId('credential-blocked')).not.toBeInTheDocument();

    fireEvent.click(submit);
    expect(onRespond).toHaveBeenCalledWith(true, [], 'I logged in myself in the preview browser');
  });

  it('blocks a bare MFA code typed into a flagged ask', () => {
    const onRespond = vi.fn();
    render(
      <PermissionDialog
        permissionRequest={createQuestionRequest(FLAGGED_ASK)}
        onRespond={onRespond}
      />,
    );

    const textarea = screen.getByLabelText('Custom response');
    fireEvent.change(textarea, { target: { value: '482913' } });
    expect(screen.getByTestId('permission-allow-button')).toBeDisabled();
    fireEvent.click(screen.getByTestId('permission-allow-button'));
    expect(onRespond).not.toHaveBeenCalled();
  });

  it('never blocks Cancel/Decline, even with a typed secret-shaped answer', () => {
    const onRespond = vi.fn();
    render(
      <PermissionDialog
        permissionRequest={createQuestionRequest(FLAGGED_ASK)}
        onRespond={onRespond}
      />,
    );

    const textarea = screen.getByLabelText('Custom response');
    fireEvent.change(textarea, { target: { value: 'password: hunter2secret' } });
    fireEvent.click(screen.getByTestId('permission-deny-button'));

    expect(onRespond).toHaveBeenCalledWith(false, [], 'password: hunter2secret');
  });

  it('unflagged questions keep the byte-identical Submit semantics', () => {
    const onRespond = vi.fn();
    render(<PermissionDialog permissionRequest={createQuestionRequest()} onRespond={onRespond} />);

    const submit = screen.getByTestId('permission-allow-button');
    expect(submit).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'CSV' }));
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    expect(onRespond).toHaveBeenCalledWith(true, ['CSV'], undefined);
  });

  it('assists the user toward manual browser authentication on flagged asks (safe alternative copy)', () => {
    render(
      <PermissionDialog
        permissionRequest={createQuestionRequest(FLAGGED_ASK)}
        onRespond={vi.fn()}
      />,
    );
    expect(screen.getByText(/automation browser or in your own browser/i)).toBeInTheDocument();
  });
});
