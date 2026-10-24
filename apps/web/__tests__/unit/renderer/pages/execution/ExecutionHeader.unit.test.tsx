/**
 * Unit tests for the ExecutionHeader waiting/resuming status badges (M6-A T3).
 * The human-wait state machine's statuses must surface human-readable
 * labels, not the raw status string fallback.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('react-router', () => ({
  useNavigate: () => vi.fn(),
}));

import { ExecutionHeader } from '@/pages/execution/ExecutionHeader';
import type { TaskStatus } from '@accomplish_ai/agent-core/common';

function renderHeader(status: TaskStatus) {
  return render(<ExecutionHeader prompt="Find the answer" status={status} />);
}

describe('ExecutionHeader status badges', () => {
  it('renders the human-wait label for waiting_for_user', () => {
    renderHeader('waiting_for_user');
    expect(screen.getByTestId('execution-status-badge')).toHaveTextContent('Needs your reply');
    expect(screen.getByTestId('execution-waiting-for-user-label')).toBeInTheDocument();
  });

  it('renders the resuming label for the transient resume state', () => {
    renderHeader('resuming');
    expect(screen.getByTestId('execution-status-badge')).toHaveTextContent('Resuming');
  });

  it('keeps the security-permission label for waiting_permission', () => {
    renderHeader('waiting_permission');
    expect(screen.getByTestId('execution-status-badge')).toHaveTextContent(
      'Waiting for permission',
    );
  });
});
