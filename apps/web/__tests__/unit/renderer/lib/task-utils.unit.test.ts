import { describe, it, expect } from 'vitest';
import { STATUS_COLORS, FAVORITABLE_STATUSES } from '@/lib/task-utils';

describe('task-utils.ts', () => {
  describe('STATUS_COLORS', () => {
    it('should render resuming with the running (progress) family class', () => {
      expect(STATUS_COLORS.resuming).toBe('border-2 border-muted-foreground');
      expect(STATUS_COLORS.resuming).toBe(STATUS_COLORS.running);
    });

    it('should render waiting_for_user with the waiting_permission family class', () => {
      expect(STATUS_COLORS.waiting_for_user).toBe('bg-warning');
      expect(STATUS_COLORS.waiting_for_user).toBe(STATUS_COLORS.waiting_permission);
    });
  });

  describe('FAVORITABLE_STATUSES', () => {
    it('should not treat transient wait/resume statuses as favoritable', () => {
      expect(FAVORITABLE_STATUSES).not.toContain('resuming');
      expect(FAVORITABLE_STATUSES).not.toContain('waiting_for_user');
    });
  });
});
